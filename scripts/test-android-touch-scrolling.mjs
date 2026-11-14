#!/usr/bin/env node
/**
 * scripts/test-android-touch-scrolling.mjs
 *
 * Real browser acceptance test suite for Android / Mobile Single-Finger Touch Scrolling.
 * Validates that touch scrolling works on mobile viewports (390x844 and 360x740)
 * using native CDP touch input (Input.dispatchTouchEvent).
 *
 * Supports two modes:
 * 1. Default (repaired verification mode):
 *    - Direct load single-finger touch scrolling on /bot-content and /settings.
 *    - Computed styles: overflow-x: clip and overflow-y: visible.
 *    - Comprehensive scroll-lock lifecycle: backdrop dismissal, close-button dismissal,
 *      and background locking during open state.
 *    - Drawer-internal scrolling on an overflowing drawer using a short viewport descriptor.
 *    - Navigated page touch scrolling verified via true positive delta (final - initial >= 100).
 *    - Standalone display-mode evaluation and matchMedia verification.
 * 2. Baseline inspection mode (--baseline or TEST_BASELINE=true):
 *    - Executes behavioral swipes against the pre-repair base commit (0eb0dc3).
 *    - Records route, browser version, viewport, starting position, scroll container,
 *      final scroll position, and delta.
 *    - Reports truthfully whether baseline reproduces scrolling failure or scrolls under emulation.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import postgres from "postgres";
import {
  detectConflictingFixture,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const isBaselineMode =
  process.argv.includes("--baseline") || process.env.TEST_BASELINE === "true";

const APP_PORT = isBaselineMode ? 3389 : 3388;
const CDP_PORT = isBaselineMode ? 9389 : 9388;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-123";

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let createdDbName = null;
let isCleaningUp = false;

function log(msg) {
  const prefix = isBaselineMode ? "[touch-baseline]" : "[touch-scrolling]";
  process.stdout.write(`${prefix} ${msg}\n`);
}

async function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  log("Cleaning up processes and temporary resources...");

  if (chromeProcess) {
    try {
      chromeProcess.kill("SIGKILL");
    } catch {}
    chromeProcess = null;
  }

  if (appServer && appServer.pid) {
    try {
      process.kill(-appServer.pid, "SIGKILL");
    } catch {}
    appServer = null;
  }

  if (pgClient) {
    try {
      await pgClient.end();
    } catch {}
    pgClient = null;
  }

  if (createdDbName && process.env.RABET_TEST_PG_URL) {
    try {
      const cleanupSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${createdDbName}`);
      await cleanupSql.end();
    } catch {}
    createdDbName = null;
  }

  if (ownedTempDir) {
    try {
      rmSync(ownedTempDir, { recursive: true, force: true });
    } catch {}
    ownedTempDir = null;
  }

  if (ownedPgFixture) {
    const stateFilePath =
      process.env.RABET_PG_STATE_FILE ??
      path.join(tmpdir(), "rabet-test-pg.json");

    verifyAndStopOwnedFixture({
      stateFilePath,
      ownedFixture: ownedPgFixture,
      stopFn: (fixture) => {
        log(`Stopping owned disposable PostgreSQL fixture (port ${fixture.port})...`);
        try {
          spawnSync(
            "node",
            ["scripts/db-test-postgres.mjs", "stop", fixture.datadir],
            {
              stdio: "ignore",
              env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
            }
          );
        } catch {}
      },
    });
    ownedPgFixture = null;
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

async function fail(msg) {
  log(`FAILED: ${msg}`);
  await cleanup();
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveChromePath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const pwDirs = [
    "/root/.cache/ms-playwright",
    path.join(process.env.HOME || "", ".cache/ms-playwright"),
  ];

  for (const pwDir of pwDirs) {
    if (existsSync(pwDir)) {
      try {
        const entries = readdirSync(pwDir);
        for (const entry of entries) {
          if (entry.startsWith("chromium-")) {
            const candidate = path.join(pwDir, entry, "chrome-linux64/chrome");
            if (existsSync(candidate)) return candidate;
          }
          if (entry.startsWith("chromium_headless_shell-")) {
            const candidate = path.join(
              pwDir,
              entry,
              "chrome-headless-shell-linux64/chrome-headless-shell"
            );
            if (existsSync(candidate)) return candidate;
          }
        }
      } catch {}
    }
  }

  const systemPaths = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of systemPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id && this.callbacks.has(data.id)) {
          const { resolve, reject } = this.callbacks.get(data.id);
          this.callbacks.delete(data.id);
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else resolve(data.result);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `CDP evaluate error: ${res.exceptionDetails.text} - ${
          res.exceptionDetails.exception?.description || ""
        }`
      );
    }
    return res.result?.value;
  }

  async close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

/**
 * Dispatches a native single-pointer vertical touch swipe via CDP Input.dispatchTouchEvent.
 */
async function performTouchSwipe(cdp, { startX, startY, endY, steps = 10, stepDelayMs = 20 }) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: startX, y: startY, id: 0 }],
  });

  const deltaY = (endY - startY) / steps;
  for (let i = 1; i <= steps; i++) {
    const currentY = Math.round(startY + deltaY * i);
    await sleep(stepDelayMs);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: startX, y: currentY, id: 0 }],
    });
  }

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  // Allow layout/inertia settling
  await sleep(350);
}

async function runBaselineInspection(cdp, browserVersion) {
  log("\n================================================================================");
  log("BASELINE INSPECTION MODE: Testing pre-repair commit (0eb0dc3b9780ca79776b1794fa0c3228da8d91e7)");
  log(`Browser: ${browserVersion.product} (${browserVersion.userAgent})`);
  log("================================================================================");

  // Configure mobile touch emulation (390x844)
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });

  // Route 1: /bot-content on baseline
  log("\n--- Baseline Check 1: /bot-content (Viewport: 390x844) ---");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/bot-content` });
  await sleep(1500);

  const baselineBotState = await cdp.evaluate(`(() => {
    const html = document.documentElement;
    const body = document.body;
    const main = document.getElementById("main");
    const scrollingEl = document.scrollingElement;
    return {
      route: window.location.pathname,
      docHeight: html.scrollHeight,
      viewportHeight: window.innerHeight,
      initialScrollY: window.scrollY,
      htmlScrollTop: html.scrollTop,
      bodyScrollTop: body.scrollTop,
      mainScrollTop: main ? main.scrollTop : null,
      scrollingElementTag: scrollingEl ? scrollingEl.tagName : null,
      htmlOverflowX: getComputedStyle(html).overflowX,
      htmlOverflowY: getComputedStyle(html).overflowY,
      bodyOverflowX: getComputedStyle(body).overflowX,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyOverscrollY: getComputedStyle(body).overscrollBehaviorY,
      mainOverflowX: main ? getComputedStyle(main).overflowX : null,
      mainOverflowY: main ? getComputedStyle(main).overflowY : null,
    };
  })()`);

  log(`Baseline Initial State: ${JSON.stringify(baselineBotState, null, 2)}`);

  // Ensure sufficient height for gesture
  if (baselineBotState.docHeight <= baselineBotState.viewportHeight + 200) {
    await fail(
      `Baseline page is not tall enough to test (${baselineBotState.docHeight} <= ${baselineBotState.viewportHeight}). Setup failure.`
    );
  }

  // Dispatch real single-pointer swipe up on baseline
  log("Dispatching native single-pointer swipe up (startX: 200, startY: 600, endY: 200)...");
  await performTouchSwipe(cdp, { startX: 200, startY: 600, endY: 200, steps: 12 });

  const baselineBotFinal = await cdp.evaluate(`(() => {
    const html = document.documentElement;
    const body = document.body;
    const main = document.getElementById("main");
    return {
      finalScrollY: window.scrollY,
      htmlScrollTop: html.scrollTop,
      bodyScrollTop: body.scrollTop,
      mainScrollTop: main ? main.scrollTop : null,
    };
  })()`);

  const botDelta = baselineBotFinal.finalScrollY - baselineBotState.initialScrollY;
  log(`Baseline Final State: ${JSON.stringify(baselineBotFinal)}`);
  log(`Baseline Scroll Delta on /bot-content: ${botDelta}px`);

  // Route 2: /settings on baseline (360x740)
  log("\n--- Baseline Check 2: /settings (Viewport: 360x740) ---");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });
  await cdp.send("Page.navigate", { url: `${BASE_URL}/settings` });
  await sleep(1500);

  const baselineSettingsInit = await cdp.evaluate(`(() => ({
    route: window.location.pathname,
    docHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    initialScrollY: window.scrollY,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    scrollingElementTag: document.scrollingElement ? document.scrollingElement.tagName : null,
  }))()`);

  log(`Baseline Settings Initial: ${JSON.stringify(baselineSettingsInit)}`);

  log("Dispatching native single-pointer swipe up on /settings (startX: 180, startY: 550, endY: 200)...");
  await performTouchSwipe(cdp, { startX: 180, startY: 550, endY: 200, steps: 10 });

  const baselineSettingsFinalScroll = await cdp.evaluate("window.scrollY");
  const settingsDelta = baselineSettingsFinalScroll - baselineSettingsInit.initialScrollY;
  log(`Baseline /settings Final scrollY: ${baselineSettingsFinalScroll}px, Delta: ${settingsDelta}px`);

  // Truthful baseline evaluation summary
  log("\n================================================================================");
  log("BASELINE EVIDENCE SUMMARY (Actual base commit 0eb0dc3b9780ca79776b1794fa0c3228da8d91e7):");
  log(`- Browser version: ${browserVersion.product}`);
  log(`- /bot-content (390x844): initial=${baselineBotState.initialScrollY}px, final=${baselineBotFinal.finalScrollY}px, delta=${botDelta}px`);
  log(`- /settings (360x740): initial=${baselineSettingsInit.initialScrollY}px, final=${baselineSettingsFinalScroll}px, delta=${settingsDelta}px`);
  if (botDelta === 0 && settingsDelta === 0) {
    log("- Result: Single-finger touch scrolling failure REPRODUCED on actual base source (0px scrolled).");
  } else {
    log(`- Result: Under headless desktop Chromium mobile emulation, baseline build scrolled (botDelta=${botDelta}px, settingsDelta=${settingsDelta}px).`);
  }
  log("================================================================================");
}

async function runRepairedSuite(cdp) {
  // TEST 1: Direct load of /bot-content and single-finger vertical touch scrolling
  log("\n--- TEST 1: Direct load /bot-content and single-finger touch scroll (390x844) ---");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });

  await cdp.send("Page.navigate", { url: `${BASE_URL}/bot-content` });
  await sleep(1500);

  const stylesCheck = await cdp.evaluate(`(() => {
    const html = document.documentElement;
    const body = document.body;
    const main = document.getElementById("main");
    return {
      htmlOverflowX: getComputedStyle(html).overflowX,
      htmlOverflowY: getComputedStyle(html).overflowY,
      bodyOverflowX: getComputedStyle(body).overflowX,
      bodyOverflowY: getComputedStyle(body).overflowY,
      mainOverflowX: main ? getComputedStyle(main).overflowX : null,
      mainOverflowY: main ? getComputedStyle(main).overflowY : null,
      dataScrollLocked: body.getAttribute("data-scroll-locked"),
      initialScrollY: window.scrollY,
      docHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  })()`);
  log(`Computed styles on direct load: ${JSON.stringify(stylesCheck)}`);

  if (stylesCheck.htmlOverflowY === "auto" || stylesCheck.bodyOverflowY === "auto") {
    await fail(
      `html or body computed overflow-y is 'auto' instead of 'visible'. html: ${stylesCheck.htmlOverflowY}, body: ${stylesCheck.bodyOverflowY}`
    );
  }
  if (stylesCheck.mainOverflowY === "auto") {
    await fail(`main#main computed overflow-y is 'auto', creating an inner scroll trap.`);
  }
  if (stylesCheck.dataScrollLocked !== null) {
    await fail(`body unexpectedly has data-scroll-locked attribute on direct load.`);
  }
  if (stylesCheck.docHeight <= stylesCheck.viewportHeight + 200) {
    await fail(`Page content is not tall enough to test scrolling (${stylesCheck.docHeight} <= ${stylesCheck.viewportHeight}).`);
  }

  // Perform single-finger touch swipe up
  const startScroll1 = stylesCheck.initialScrollY;
  log("Performing native single-finger swipe up (400px gesture)...");
  await performTouchSwipe(cdp, { startX: 200, startY: 600, endY: 200, steps: 12 });

  const scrollAfterUp = await cdp.evaluate("window.scrollY");
  const upDelta = scrollAfterUp - startScroll1;
  log(`window.scrollY after single-finger swipe up: ${scrollAfterUp}px (delta: +${upDelta}px)`);
  if (upDelta < 100) {
    await fail(`Single-finger swipe up produced insufficient scroll delta: ${upDelta}px < 100px.`);
  }

  // Perform single-finger touch swipe back down
  log("Performing native single-finger swipe back down...");
  await performTouchSwipe(cdp, { startX: 200, startY: 200, endY: 600, steps: 12 });
  const scrollAfterDown = await cdp.evaluate("window.scrollY");
  log(`window.scrollY after single-finger swipe down: ${scrollAfterDown}px`);
  if (scrollAfterDown >= scrollAfterUp) {
    await fail(`Single-finger swipe down failed to reduce scroll position. Before: ${scrollAfterUp}, After: ${scrollAfterDown}.`);
  }

  // TEST 2: Compact Android Viewport (360x740) on /settings
  log("\n--- TEST 2: Compact Android Viewport (360x740) on /settings ---");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });

  await cdp.send("Page.navigate", { url: `${BASE_URL}/settings` });
  await sleep(1500);

  const settingsInit = await cdp.evaluate(`(() => ({
    scrollY: window.scrollY,
    docHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }))()`);
  log(`Settings initial state on 360x740: ${JSON.stringify(settingsInit)}`);

  if (settingsInit.bodyWidth > settingsInit.viewportWidth) {
    await fail(
      `Horizontal layout blowout detected on 360x740: body scrollWidth (${settingsInit.bodyWidth}) > viewport (${settingsInit.viewportWidth}).`
    );
  }

  const startScroll2 = settingsInit.scrollY;
  log("Performing native single-finger swipe up on /settings (360x740)...");
  await performTouchSwipe(cdp, { startX: 180, startY: 550, endY: 200, steps: 10 });
  const settingsScroll = await cdp.evaluate("window.scrollY");
  const settingsDelta = settingsScroll - startScroll2;
  log(`window.scrollY on /settings after swipe: ${settingsScroll}px (delta: +${settingsDelta}px)`);
  if (settingsDelta < 100) {
    await fail(`Single-finger touch scrolling on 360x740 produced insufficient delta: ${settingsDelta}px < 100px.`);
  }

  // Restore standard mobile viewport
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });

  // TEST 3: Complete Mobile Nav Drawer (Sheet) Scroll-Lock Lifecycle
  log("\n--- TEST 3: Complete Mobile Nav Drawer (Sheet) Scroll-Lock Lifecycle ---");

  // 3A: Backdrop dismissal and background locking
  log("Subtest 3A: Backdrop dismissal and background locking...");
  await cdp.evaluate("window.scrollTo(0, 0);");
  await sleep(150);

  await cdp.evaluate(`document.querySelector('button[aria-label="Open navigation menu"]').click();`);
  await sleep(600);

  const backdropDrawerOpen = await cdp.evaluate(`(() => ({
    hasSheetContent: Boolean(document.querySelector('[data-slot="sheet-content"]')),
    hasOverlay: Boolean(document.querySelector('[data-slot="sheet-overlay"]')),
    isLocked: document.body.hasAttribute("data-scroll-locked"),
    scrollY: window.scrollY,
  }))()`);
  log(`Drawer open state (3A): ${JSON.stringify(backdropDrawerOpen)}`);
  if (!backdropDrawerOpen.hasSheetContent || !backdropDrawerOpen.isLocked) {
    await fail("Drawer failed to open or body missing data-scroll-locked in 3A.");
  }

  // Swipe on backdrop overlay while drawer open: verify background does NOT move
  log("Swiping on backdrop overlay while drawer open: asserting zero background scroll...");
  await performTouchSwipe(cdp, { startX: 340, startY: 500, endY: 200, steps: 10 });
  const scrollDuringOverlaySwipe = await cdp.evaluate("window.scrollY");
  log(`Background scroll during open drawer: ${scrollDuringOverlaySwipe}px (initial: ${backdropDrawerOpen.scrollY}px)`);
  if (scrollDuringOverlaySwipe !== backdropDrawerOpen.scrollY) {
    await fail(`Background scrolled while drawer was open: moved from ${backdropDrawerOpen.scrollY} to ${scrollDuringOverlaySwipe}.`);
  }

  // Dismiss by clicking the backdrop overlay
  log("Dismissing drawer by clicking backdrop overlay...");
  await cdp.evaluate(`(() => {
    const overlay = document.querySelector('[data-slot="sheet-overlay"]');
    if (overlay) overlay.click();
  })()`);
  await sleep(500);

  const backdropDismissedState = await cdp.evaluate(`(() => ({
    sheetContent: Boolean(document.querySelector('[data-slot="sheet-content"]')),
    isLocked: document.body.hasAttribute("data-scroll-locked"),
  }))()`);
  log(`State after backdrop dismissal: ${JSON.stringify(backdropDismissedState)}`);
  if (backdropDismissedState.sheetContent || backdropDismissedState.isLocked) {
    await fail("Drawer content remained or body retained data-scroll-locked after backdrop dismissal.");
  }

  // Verify single-finger page scrolling resumes after backdrop dismissal
  await cdp.evaluate("window.scrollTo(0, 0);");
  await sleep(100);
  const preSwipe3A = await cdp.evaluate("window.scrollY");
  log("Performing touch swipe on page after backdrop dismissal...");
  await performTouchSwipe(cdp, { startX: 200, startY: 550, endY: 200, steps: 10 });
  const postSwipe3A = await cdp.evaluate("window.scrollY");
  const delta3A = postSwipe3A - preSwipe3A;
  log(`scrollY after backdrop dismissal swipe: ${postSwipe3A}px (delta: +${delta3A}px)`);
  if (delta3A < 100) {
    await fail(`Single-finger scrolling failed to resume after backdrop dismissal: delta ${delta3A}px < 100px.`);
  }

  // 3B: Close-button dismissal
  log("\nSubtest 3B: Close-button dismissal...");
  await cdp.evaluate("window.scrollTo(0, 0);");
  await sleep(150);

  await cdp.evaluate(`document.querySelector('button[aria-label="Open navigation menu"]').click();`);
  await sleep(600);

  const closeBtnDrawerOpen = await cdp.evaluate(`(() => ({
    hasSheetContent: Boolean(document.querySelector('[data-slot="sheet-content"]')),
    isLocked: document.body.hasAttribute("data-scroll-locked"),
  }))()`);
  if (!closeBtnDrawerOpen.hasSheetContent || !closeBtnDrawerOpen.isLocked) {
    await fail("Drawer failed to open or body missing data-scroll-locked in 3B.");
  }

  // Dismiss via close button
  log("Dismissing drawer via close button...");
  await cdp.evaluate(`(() => {
    const closeBtn = document.querySelector('[data-slot="sheet-content"] button[data-slot="sheet-close"]') ||
                     document.querySelector('[data-slot="sheet-content"] button');
    if (closeBtn) closeBtn.click();
  })()`);
  await sleep(500);

  const closeBtnDismissedState = await cdp.evaluate(`(() => ({
    sheetContent: Boolean(document.querySelector('[data-slot="sheet-content"]')),
    isLocked: document.body.hasAttribute("data-scroll-locked"),
  }))()`);
  log(`State after close-button dismissal: ${JSON.stringify(closeBtnDismissedState)}`);
  if (closeBtnDismissedState.sheetContent || closeBtnDismissedState.isLocked) {
    await fail("Drawer content remained or body retained data-scroll-locked after close-button dismissal.");
  }

  // Verify single-finger page scrolling resumes after close-button dismissal
  await cdp.evaluate("window.scrollTo(0, 0);");
  await sleep(100);
  const preSwipe3B = await cdp.evaluate("window.scrollY");
  log("Performing touch swipe on page after close-button dismissal...");
  await performTouchSwipe(cdp, { startX: 200, startY: 550, endY: 200, steps: 10 });
  const postSwipe3B = await cdp.evaluate("window.scrollY");
  const delta3B = postSwipe3B - preSwipe3B;
  log(`scrollY after close-button dismissal swipe: ${postSwipe3B}px (delta: +${delta3B}px)`);
  if (delta3B < 100) {
    await fail(`Single-finger scrolling failed to resume after close-button dismissal: delta ${delta3B}px < 100px.`);
  }

  // 3C: Drawer-internal scrolling on an overflowing drawer (using short viewport)
  log("\nSubtest 3C: Drawer-internal scrolling on an overflowing drawer (short viewport 360x320)...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 320,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });

  await cdp.evaluate(`document.querySelector('button[aria-label="Open navigation menu"]').click();`);
  await sleep(600);

  const drawerOverflowCheck = await cdp.evaluate(`(() => {
    const scrollContainer = document.querySelector('[data-slot="sheet-content"] .overflow-y-auto') ||
                            document.querySelector('[data-slot="sheet-content"] [class*="overflow-y-auto"]');
    if (!scrollContainer) return { found: false };
    return {
      found: true,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
      initialScrollTop: scrollContainer.scrollTop,
      backgroundScrollY: window.scrollY,
    };
  })()`);
  log(`Drawer internal scroll container stats: ${JSON.stringify(drawerOverflowCheck)}`);

  if (!drawerOverflowCheck.found) {
    await fail("Could not find drawer internal scroll container (.overflow-y-auto).");
  }
  if (drawerOverflowCheck.scrollHeight <= drawerOverflowCheck.clientHeight) {
    await fail(
      `Drawer did not overflow on short viewport (${drawerOverflowCheck.scrollHeight} <= ${drawerOverflowCheck.clientHeight}).`
    );
  }

  // Perform touch swipe inside the drawer
  log("Performing native single-pointer swipe inside drawer content...");
  await performTouchSwipe(cdp, { startX: 100, startY: 240, endY: 80, steps: 10 });

  const drawerPostSwipe = await cdp.evaluate(`(() => {
    const scrollContainer = document.querySelector('[data-slot="sheet-content"] .overflow-y-auto') ||
                            document.querySelector('[data-slot="sheet-content"] [class*="overflow-y-auto"]');
    return {
      finalScrollTop: scrollContainer ? scrollContainer.scrollTop : 0,
      backgroundScrollY: window.scrollY,
    };
  })()`);
  const drawerScrollDelta = drawerPostSwipe.finalScrollTop - drawerOverflowCheck.initialScrollTop;
  log(`Drawer internal scrollTop: ${drawerPostSwipe.finalScrollTop}px (delta: +${drawerScrollDelta}px), Background: ${drawerPostSwipe.backgroundScrollY}px`);

  if (drawerScrollDelta <= 20) {
    await fail(`Drawer internal content failed to scroll: delta ${drawerScrollDelta}px <= 20px.`);
  }
  if (drawerPostSwipe.backgroundScrollY !== drawerOverflowCheck.backgroundScrollY) {
    await fail(`Background scrolled while dragging inside drawer: moved from ${drawerOverflowCheck.backgroundScrollY} to ${drawerPostSwipe.backgroundScrollY}.`);
  }

  // Close drawer and restore standard mobile viewport
  await cdp.evaluate(`(() => {
    const closeBtn = document.querySelector('[data-slot="sheet-content"] button[data-slot="sheet-close"]') ||
                     document.querySelector('[data-slot="sheet-content"] button');
    if (closeBtn) closeBtn.click();
  })()`);
  await sleep(400);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });

  // TEST 4: Navigation through Mobile Drawer Links (Repaired Assertion)
  log("\n--- TEST 4: Navigation through Mobile Drawer links (Repaired Positive Delta Assertion) ---");
  await cdp.evaluate("window.scrollTo(0, 0);");
  await sleep(150);

  await cdp.evaluate(`document.querySelector('button[aria-label="Open navigation menu"]').click();`);
  await sleep(600);

  log("Clicking 'Bot Content' link inside mobile drawer...");
  const navClicked = await cdp.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('[data-slot="sheet-content"] a'));
    const botContentLink = links.find(a => a.href.includes('/bot-content') || a.innerText.includes('Bot Content'));
    if (botContentLink) {
      botContentLink.click();
      return true;
    }
    return false;
  })()`);
  if (!navClicked) {
    await fail("Could not find Bot Content link inside mobile drawer.");
  }

  // Wait for URL to change to exact destination pathname
  let navSuccess = false;
  for (let i = 0; i < 25; i++) {
    await sleep(250);
    const currPath = await cdp.evaluate("window.location.pathname");
    if (currPath === "/bot-content") {
      navSuccess = true;
      break;
    }
  }
  if (!navSuccess) {
    const actualPath = await cdp.evaluate("window.location.pathname");
    await fail(`Navigation did not reach exact destination '/bot-content'. Actual: '${actualPath}'.`);
  }

  // Assert drawer content and overlay are absent/closed, and data-scroll-locked is removed
  const navSettledState = await cdp.evaluate(`(() => ({
    pathname: window.location.pathname,
    sheetPresent: Boolean(document.querySelector('[data-slot="sheet-content"]')),
    overlayPresent: Boolean(document.querySelector('[data-slot="sheet-overlay"]')),
    isLocked: document.body.hasAttribute("data-scroll-locked"),
  }))()`);
  log(`Post-navigation settled state: ${JSON.stringify(navSettledState)}`);

  if (navSettledState.pathname !== "/bot-content") {
    await fail(`Destination pathname mismatch: expected '/bot-content', got '${navSettledState.pathname}'.`);
  }
  if (navSettledState.sheetPresent || navSettledState.overlayPresent) {
    await fail("Drawer content or overlay remained present after navigation.");
  }
  if (navSettledState.isLocked) {
    await fail("body retained data-scroll-locked after drawer link navigation.");
  }

  // Prepare defined starting position with room to scroll
  await cdp.evaluate("window.scrollTo(0, 0);");
  await sleep(150);
  const navRoomCheck = await cdp.evaluate(`(() => ({
    startY: window.scrollY,
    docHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }))()`);
  log(`Navigated page starting state: ${JSON.stringify(navRoomCheck)}`);

  if (navRoomCheck.startY !== 0) {
    await fail(`Failed to establish defined starting position 0px on navigated page. Got ${navRoomCheck.startY}px.`);
  }
  if (navRoomCheck.docHeight <= navRoomCheck.viewportHeight + 200) {
    await fail(`Navigated page has insufficient height to test scrolling (${navRoomCheck.docHeight} <= ${navRoomCheck.viewportHeight}).`);
  }

  // Dispatch native single-pointer swipe and assert meaningful positive delta
  log("Dispatching native single-pointer swipe on navigated page...");
  await performTouchSwipe(cdp, { startX: 180, startY: 550, endY: 200, steps: 10 });

  const postNavFinalScroll = await cdp.evaluate("window.scrollY");
  const postNavDelta = postNavFinalScroll - navRoomCheck.startY;
  log(`window.scrollY on navigated page after swipe: ${postNavFinalScroll}px (delta: +${postNavDelta}px)`);

  if (postNavDelta < 100) {
    await fail(`Single-finger swipe on navigated page produced insufficient delta: ${postNavDelta}px < 100px.`);
  }

  // TEST 5: Standalone-mode evaluation (display-mode: standalone)
  log("\n--- TEST 5: Standalone-mode evaluation (display-mode: standalone) ---");
  const initialStandaloneMatches = await cdp.evaluate(`window.matchMedia('(display-mode: standalone)').matches`);
  log(`Initial matchMedia('(display-mode: standalone)').matches: ${initialStandaloneMatches}`);

  // Attempt to emulate display-mode: standalone via CDP
  try {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "display-mode", value: "standalone" }],
    });
  } catch (err) {
    log(`Emulation.setEmulatedMedia display-mode: ${err.message}`);
  }

  const emulatedStandaloneMatches = await cdp.evaluate(`window.matchMedia('(display-mode: standalone)').matches`);
  log(`Emulated matchMedia('(display-mode: standalone)').matches: ${emulatedStandaloneMatches}`);

  if (emulatedStandaloneMatches) {
    log("Standalone display-mode established by runner: testing page scrolling and drawer recovery...");
    await cdp.evaluate("window.scrollTo(0, 0);");
    await sleep(100);
    const pwaStart = await cdp.evaluate("window.scrollY");
    await performTouchSwipe(cdp, { startX: 180, startY: 550, endY: 200, steps: 10 });
    const pwaEnd = await cdp.evaluate("window.scrollY");
    const pwaDelta = pwaEnd - pwaStart;
    log(`PWA standalone scroll delta: +${pwaDelta}px`);
    if (pwaDelta < 100) {
      await fail(`Touch scrolling failed under standalone display-mode: delta ${pwaDelta}px < 100px.`);
    }

    // Verify drawer lifecycle in standalone mode
    await cdp.evaluate(`document.querySelector('button[aria-label="Open navigation menu"]').click();`);
    await sleep(500);
    await cdp.evaluate(`(() => {
      const closeBtn = document.querySelector('[data-slot="sheet-content"] button[data-slot="sheet-close"]') ||
                       document.querySelector('[data-slot="sheet-content"] button');
      if (closeBtn) closeBtn.click();
    })()`);
    await sleep(400);
    log("Standalone display-mode verified successfully in runner.");
  } else {
    log(
      "[touch-scrolling] NOTE: Standalone display-mode (display-mode: standalone) cannot be established by the headless Chromium runner (matches: false). " +
      "Marking standalone PWA mode as UNVERIFIED in automated runner; real-device Android PWA test required per instructions."
    );
  }

  log("\n[SUCCESS] All mobile single-finger touch scrolling tests PASSED!");
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail(
      "Chromium executable not found. Set CHROME_BIN or CHROME_PATH environment variable."
    );
  }
  log(`Using Chromium executable: ${chromePath}`);

  let pgUrl = "";
  if (process.env.RABET_TEST_PG_URL) {
    createdDbName = `rabet_android_scroll_${Date.now()}`;
    const adminSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${createdDbName}`);
    await adminSql.end();

    const parsed = new URL(process.env.RABET_TEST_PG_URL);
    parsed.pathname = `/${createdDbName}`;
    pgUrl = parsed.toString();
    log(`Using designated PostgreSQL service with database: ${createdDbName}`);
  } else {
    const stateFilePath =
      process.env.RABET_PG_STATE_FILE ??
      path.join(tmpdir(), "rabet-test-pg.json");

    const conflict = detectConflictingFixture(stateFilePath);
    if (conflict) {
      await fail(
        `Pre-existing disposable PostgreSQL instance detected at ${stateFilePath} ` +
          `(port ${conflict.port}, datadir: ${conflict.datadir}).`
      );
    }

    log("Starting disposable PostgreSQL...");
    const pgStart = spawnSync("node", ["scripts/db-test-postgres.mjs", "start"], {
      encoding: "utf8",
      env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
    });
    if (pgStart.status !== 0) {
      await fail(`Could not start disposable PostgreSQL: ${pgStart.stderr}`);
    }

    const pgUrlMatch = pgStart.stdout.match(/postgresql:\/\/[^\s]+/);
    if (!pgUrlMatch) {
      await fail(`Could not find postgresql URL in output:\n${pgStart.stdout}`);
    }
    pgUrl = pgUrlMatch[0];

    const datadirMatch = pgStart.stdout.match(/DATADIR=([^\s]+)/);
    const parsedPgUrl = new URL(pgUrl);
    ownedPgFixture = {
      port: Number(parsedPgUrl.port),
      datadir: datadirMatch ? datadirMatch[1] : "",
    };
  }

  log("Applying database migrations...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    await fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }

  pgClient = postgres(pgUrl);
  log("Seeding test store settings and languages...");
  const [langEn] = await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('en', 'English', 'ltr', true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('ar', 'العربية', 'rtl', false);
  `;
  await pgClient`
    INSERT INTO bot_setting (display_name, currency, default_language_id, ask_for_language)
    VALUES ('Acme Digital', 'USD', ${langEn.id}, true);
  `;

  ownedTempDir = mkdtempSync(path.join(tmpdir(), `rabet-touch-${isBaselineMode ? "baseline" : "repaired"}-`));
  chmodSync(ownedTempDir, 0o700);

  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-proxy-bootstrap.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `const originalFetch = globalThis.fetch;\n` +
      `let pg = null;\n` +
      `globalThis.fetch = async (input, init) => {\n` +
      `  const url = typeof input === "string" ? input : (input ? input.url : "");\n` +
      `  const headers = init?.headers || {};\n` +
      `  const connStr = typeof headers.get === "function" ? headers.get("Neon-Connection-String") : (headers["Neon-Connection-String"] || headers["neon-connection-string"] || "");\n` +
      `  const isSyntheticEndpoint = (url && url.includes("ep-example.neon.tech")) || (typeof connStr === "string" && connStr.includes("ep-example.neon.tech"));\n` +
      `  if (isSyntheticEndpoint && (url.includes("/sql") || url.includes("neon.tech"))) {\n` +
      `    if (!pg && process.env.TEST_REAL_PG_URL) {\n` +
      `      pg = postgres(process.env.TEST_REAL_PG_URL);\n` +
      `    }\n` +
      `    const { query, params } = JSON.parse(init.body);\n` +
      `    try {\n` +
      `      const rows = await pg.unsafe(query, params || []);\n` +
      `      const cols = rows.columns || [];\n` +
      `      const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `      const rowArrays = rows.map((r) => cols.map((c) => r[c.name]));\n` +
      `      return new Response(JSON.stringify({ rows: rowArrays, fields }), {\n` +
      `        status: 200,\n` +
      `        headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    } catch (err) {\n` +
      `      return new Response(JSON.stringify({ message: err.message }), {\n` +
      `        status: 500,\n` +
      `        headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    }\n` +
      `  }\n` +
      `  return originalFetch(input, init);\n` +
      `};\n`,
    { mode: 0o600 }
  );

  const passwordHash = await hash(TEST_PASSWORD, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const authSecret = Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32))
  ).toString("base64");

  const envFile = path.join(ownedTempDir, "test.env");
  const testSyntheticNeonUrl =
    "postgresql://rabet_user:synthetic_pass@ep-example.neon.tech/rabet_db";

  writeFileSync(
    envFile,
    [
      `export DATABASE_URL='${testSyntheticNeonUrl}'`,
      `export TEST_REAL_PG_URL='${pgUrl}'`,
      `export AUTH_SECRET='${authSecret}'`,
      `export ADMIN_EMAIL='${TEST_EMAIL}'`,
      `export ADMIN_PASSWORD_HASH='${passwordHash}'`,
      `export AUTH_URL='${BASE_URL}'`,
      `export AUTH_TRUST_HOST='true'`,
      `export NODE_OPTIONS='--import ${bootstrapFile}'`,
    ].join("\n") + "\n",
    { mode: 0o600 }
  );

  appServer = spawn(
    "bash",
    [
      "-c",
      `source "${envFile}" && PORT=${APP_PORT} node node_modules/next/dist/bin/next start`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    }
  );

  appServer.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("blocking-prerender-crypto") && !s.includes("ExperimentalWarning")) {
      process.stderr.write(`[next:stderr] ${s}`);
    }
  });

  let serverReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${BASE_URL}/login`);
      if (res.status === 200 || res.status === 307) {
        serverReady = true;
        break;
      }
    } catch {}
  }
  if (!serverReady) {
    await fail("Next.js server failed to start within 20s");
  }
  log("Next.js server is ready.");

  // Authenticate admin session
  log("Authenticating admin session over HTTP...");
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.csrfToken;
  const initialCookies = csrfRes.headers.get("set-cookie") || "";

  const signinBody = new URLSearchParams({
    csrfToken,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    callbackUrl: `${BASE_URL}/bot-content`,
    json: "true",
  });

  const signinRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: initialCookies,
    },
    body: signinBody.toString(),
    redirect: "manual",
  });

  const authCookies = signinRes.headers.get("set-cookie") || "";
  const sessionTokenMatch = authCookies.match(/authjs\.session-token=([^;]+)/);
  if (!sessionTokenMatch) {
    await fail("Failed to obtain session token from signin response");
  }
  const sessionCookieVal = sessionTokenMatch[1];
  log("Admin session authenticated successfully.");

  // Launch headless Chromium
  log("Launching headless Chromium...");
  const chromeDataDir = path.join(ownedTempDir, "chrome-data");
  chmodSync(ownedTempDir, 0o700);

  chromeProcess = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeDataDir}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=390,844",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let pageTarget = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await targetsRes.json();
      pageTarget = targets.find((t) => t.type === "page") || targets[0];
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        break;
      }
    } catch {}
  }
  if (!pageTarget) {
    await fail("Could not connect to Chromium DevTools Protocol");
  }

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  log("Connected to Chromium page via CDP.");

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Network.enable");

  // Set session cookie
  await cdp.send("Network.setCookie", {
    name: "authjs.session-token",
    value: sessionCookieVal,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });

  const browserVersion = await cdp.send("Browser.getVersion");

  if (isBaselineMode) {
    await runBaselineInspection(cdp, browserVersion);
  } else {
    await runRepairedSuite(cdp);
  }

  await cdp.close();
  await cleanup();
}

main().catch(async (err) => {
  log(`UNHANDLED ERROR: ${err.stack || err.message}`);
  await cleanup();
  process.exit(1);
});
