#!/usr/bin/env node
/**
 * scripts/test-container-smoke.mjs
 *
 * End-to-end acceptance smoke test for the Rabet production Docker image on
 * GitHub Actions (`linux/amd64`, Node 22 standalone runtime).
 *
 * Proves:
 *   1. Image provenance & hardening: linux/amd64, Node 22, non-root UID 1001,
 *      direct `node server.js` startup (no install/build/migrate on boot),
 *      no secrets or `.env*` files baked into image env or filesystem, and
 *      working `@node-rs/argon2` native bindings inside the image.
 *   2. Pure unmodified runtime container on a non-default PORT (`4310`, zero
 *      volume mounts, zero `NODE_OPTIONS`):
 *        - `GET /api/healthz` -> 200 `{ status: "ok", sha }` (`no-store`)
 *        - `GET /` public page -> 200 + compiled `/_next/static/*.css` -> 200
 *        - `GET /manifest.webmanifest` + all PWA icons + `/favicon.ico` -> 200
 *        - `/sw.js` & `/service-worker.js` -> 404 (ADR-008)
 *        - Signed-out dashboard paths + `/api/admin` redirect to `/login`
 *        - Invalid & valid login with synthetic Argon2id credentials
 *        - Authenticated dashboard `Cache-Control: private, no-store, must-revalidate`
 *        - Logout invalidation + unconfigured webhook `503` fail-closed
 *   3. Reverse-proxy HTTPS + isolated PostgreSQL + dummy Telegram webhook
 *      container on non-default PORT (`4311`):
 *        - `GET /api/healthz` performs 0 DB queries and 0 Telegram calls
 *        - Reverse-proxy HTTPS (`Host` + `X-Forwarded-Proto: https` + `AUTH_URL`)
 *          redirects cleanly to `https://rabet-proxy.example.test/login` (never
 *          `0.0.0.0:4311`), issues `__Secure-authjs.session-token` (`Secure`),
 *          and renders seeded store data from isolated PostgreSQL on `/overview`
 *        - `POST /api/telegram/webhook` with missing or wrong secret returns
 *          `401 Unauthorized` with 0 SQL queries, 0 DB writes, and 0 outbound
 *          Telegram API calls
 *   4. Fail-closed container without admin credentials on PORT (`4312`):
 *        - `GET /api/healthz` -> 200, `/login` shows unavailable notice, sign-in
 *          rejected without issuing any session cookie
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";

const IMAGE = process.env.RABET_SMOKE_IMAGE ?? "";
const EXPECTED_SHA = (process.env.RABET_EXPECTED_SHA ?? "").trim().toLowerCase();
const TEST_PG_URL = process.env.RABET_TEST_PG_URL ?? "";

const PURE_PORT = 4310;
const PROXY_PORT = 4311;
const CLOSED_PORT = 4312;

const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "container-smoke-argon2-password-99!";
const PROXY_ORIGIN = "https://rabet-proxy.example.test";

const CONTAINERS = [
  "rabet-smoke-pure",
  "rabet-smoke-proxy",
  "rabet-smoke-closed",
];

const DASHBOARD_PATHS = [
  "/overview",
  "/products",
  "/categories",
  "/storefront",
  "/catalog",
  "/payment-methods",
  "/inquiries",
  "/customers",
  "/bot-content",
  "/telegram",
  "/settings",
];

let tempDir = null;
let mockServer = null;
let adminSql = null;
let smokeSql = null;
let smokeDbName = null;

function log(msg) {
  process.stdout.write(`[container-smoke] ${msg}\n`);
}

function runDocker(args, { allowFailure = false } = {}) {
  const res = spawnSync("docker", args, { encoding: "utf8" });
  if (!allowFailure && res.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (exit ${res.status}):\n${res.stderr || res.stdout}`,
    );
  }
  return res;
}

function dumpContainerLogs(name) {
  const res = runDocker(["logs", name], { allowFailure: true });
  const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (combined) {
    process.stderr.write(`\n--- docker logs ${name} ---\n${combined}\n---------------------------\n`);
  }
}

async function cleanup() {
  for (const name of CONTAINERS) {
    runDocker(["rm", "-f", name], { allowFailure: true });
  }
  if (mockServer) {
    await new Promise((resolve) => mockServer.close(() => resolve()));
    mockServer = null;
  }
  if (smokeSql) {
    try {
      await smokeSql.end();
    } catch {}
    smokeSql = null;
  }
  if (adminSql) {
    if (smokeDbName) {
      try {
        await adminSql.unsafe(`DROP DATABASE IF EXISTS ${smokeDbName}`);
      } catch {}
      smokeDbName = null;
    }
    try {
      await adminSql.end();
    } catch {}
    adminSql = null;
  }
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    tempDir = null;
  }
}

async function waitForHealthz(port, containerName, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      if (res.status === 200) {
        return;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  dumpContainerLogs(containerName);
  throw new Error(
    `Container ${containerName} on port ${port} did not pass /api/healthz within ${timeoutMs}ms (last: ${lastErr})`,
  );
}

async function rawRequest(baseUrl, urlPath, init = {}) {
  const jar = init.jar ?? {};
  const cookieHeader = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const headers = {
    ...(init.headers ?? {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: init.method ?? "GET",
    body: init.body,
    redirect: "manual",
    headers,
  });

  const rawSetCookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of rawSetCookies) {
    const [pair] = cookie.split(";");
    const [name, ...rest] = pair.split("=");
    if (!name) continue;
    const value = rest.join("=");
    if (value === "" || cookie.includes("Max-Age=0")) {
      delete jar[name.trim()];
    } else {
      jar[name.trim()] = value;
    }
  }

  const body = await res.text();
  return {
    status: res.status,
    location: res.headers.get("location"),
    headers: res.headers,
    rawSetCookies,
    body,
    jar,
  };
}

async function fetchCsrf(baseUrl, jar, extraHeaders = {}) {
  const res = await rawRequest(baseUrl, "/api/auth/csrf", {
    jar,
    headers: extraHeaders,
  });
  assert.equal(res.status, 200, `Expected 200 from /api/auth/csrf, got ${res.status}`);
  const parsed = JSON.parse(res.body);
  assert.ok(parsed.csrfToken, "Expected non-empty csrfToken");
  return { csrfToken: parsed.csrfToken, jar: res.jar };
}

function assertNoProductionCredentialsInRunnerEnv() {
  const forbidden = Object.keys(process.env).filter((key) =>
    /^(NEON|VERCEL|RENDER)_/i.test(key),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Refusing to run container smoke tests with hosted credentials present: ${forbidden.join(", ")}`,
    );
  }
  if (/neon\.tech/i.test(TEST_PG_URL)) {
    throw new Error("Refusing to run: RABET_TEST_PG_URL points at neon.tech");
  }
}

async function main() {
  assertNoProductionCredentialsInRunnerEnv();

  if (!IMAGE) {
    throw new Error("RABET_SMOKE_IMAGE is required.");
  }
  if (!/^[0-9a-f]{40}$/.test(EXPECTED_SHA)) {
    throw new Error(`RABET_EXPECTED_SHA must be a 40-char lowercase hex SHA (got "${EXPECTED_SHA}").`);
  }
  if (!TEST_PG_URL) {
    throw new Error("RABET_TEST_PG_URL is required for isolated PostgreSQL verification.");
  }

  const parsedPg = new URL(TEST_PG_URL);
  if (parsedPg.hostname !== "localhost" && parsedPg.hostname !== "127.0.0.1") {
    throw new Error(
      `Refusing to use non-loopback PostgreSQL host in smoke test: ${parsedPg.hostname}`,
    );
  }

  await cleanup();

  // -------------------------------------------------------------------------
  // 1. Inspect built image metadata, env cleanliness, and runtime user/Node
  // -------------------------------------------------------------------------
  log(`Inspecting image ${IMAGE}...`);
  const inspectRes = runDocker(["image", "inspect", IMAGE]);
  const [imageMeta] = JSON.parse(inspectRes.stdout);

  assert.equal(imageMeta.Os, "linux", "Image OS must be linux");
  assert.equal(imageMeta.Architecture, "amd64", "Image architecture must be amd64");
  assert.equal(imageMeta.Config.User, "nextjs", "Image must run as non-root user 'nextjs'");
  assert.deepEqual(
    imageMeta.Config.Cmd,
    ["node", "server.js"],
    "Container startup CMD must invoke prebuilt standalone server directly",
  );
  assert.equal(
    imageMeta.Config.Labels?.["org.opencontainers.image.revision"],
    EXPECTED_SHA,
    "OCI revision label must match exact commit SHA",
  );

  const imageEnvList = imageMeta.Config.Env ?? [];
  const forbiddenImageEnvPrefixes = [
    "AUTH_SECRET=",
    "NEXTAUTH_SECRET=",
    "ADMIN_EMAIL=",
    "ADMIN_PASSWORD_HASH=",
    "DATABASE_URL=",
    "TELEGRAM_BOT_TOKEN=",
    "TELEGRAM_WEBHOOK_SECRET=",
    "TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN=",
  ];
  for (const entry of imageEnvList) {
    for (const prefix of forbiddenImageEnvPrefixes) {
      assert.equal(
        entry.startsWith(prefix),
        false,
        `Secret/runtime env var leaked into image Config.Env: ${prefix}`,
      );
    }
  }
  assert.ok(
    imageEnvList.includes(`RABET_BUILD_SHA=${EXPECTED_SHA}`),
    "Image Config.Env must carry immutable RABET_BUILD_SHA",
  );
  assert.ok(
    imageEnvList.includes("HOSTNAME=0.0.0.0"),
    "Image Config.Env must bind HOSTNAME=0.0.0.0",
  );

  // Exercise Node 22 + non-root UID + filesystem cleanliness + Argon2id inside image
  log("Verifying Node 22, non-root UID, clean filesystem, and @node-rs/argon2 native bindings inside image...");
  const probeScript = `
    const fs = require("node:fs");
    const path = require("node:path");
    const argon2 = require("@node-rs/argon2");

    function findEnvFiles(dir, out = []) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.name.startsWith(".env") || entry.name.endsWith(".env")) {
          out.push(full);
        } else if (entry.isDirectory()) {
          findEnvFiles(full, out);
        }
      }
      return out;
    }

    (async () => {
      const pw = process.env.SMOKE_PW;
      const hashed = await argon2.hash(pw, {
        algorithm: 2,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      const okValid = await argon2.verify(hashed, pw);
      const okInvalid = await argon2.verify(hashed, pw + "-wrong");
      console.log(JSON.stringify({
        nodeVersion: process.version,
        arch: process.arch,
        uid: process.getuid(),
        gid: process.getgid(),
        hasServerJs: fs.existsSync("/app/server.js"),
        hasStatic: fs.existsSync("/app/.next/static"),
        hasPublicIcons: fs.existsSync("/app/public/icons/icon-192x192.png"),
        envFiles: findEnvFiles("/app"),
        okValid,
        okInvalid,
        passwordHash: hashed,
      }));
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `;
  const probeRes = runDocker([
    "run",
    "--rm",
    "-e",
    `SMOKE_PW=${TEST_PASSWORD}`,
    "--entrypoint",
    "node",
    IMAGE,
    "-e",
    probeScript,
  ]);
  const probe = JSON.parse(probeRes.stdout.trim());

  assert.match(probe.nodeVersion, /^v22\./, `Expected Node 22, got ${probe.nodeVersion}`);
  assert.equal(probe.arch, "x64");
  assert.equal(probe.uid, 1001, "Expected non-root UID 1001");
  assert.equal(probe.gid, 1001, "Expected non-root GID 1001");
  assert.equal(probe.hasServerJs, true);
  assert.equal(probe.hasStatic, true);
  assert.equal(probe.hasPublicIcons, true);
  assert.deepEqual(probe.envFiles, [], "No .env files may exist in /app");
  assert.equal(probe.okValid, true, "Argon2id verify must accept matching password");
  assert.equal(probe.okInvalid, false, "Argon2id verify must reject wrong password");
  assert.match(probe.passwordHash, /^\$argon2id\$/, "Expected Argon2id PHC string");

  const passwordHash = probe.passwordHash;
  const authSecret = crypto.randomBytes(32).toString("base64");

  // -------------------------------------------------------------------------
  // 2. Container #1: Unmodified image on non-default PORT=4310
  // -------------------------------------------------------------------------
  log(`Booting pure unmodified container on non-default PORT=${PURE_PORT}...`);
  const pureBase = `http://127.0.0.1:${PURE_PORT}`;
  runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    "rabet-smoke-pure",
    "-p",
    `${PURE_PORT}:${PURE_PORT}`,
    "-e",
    `PORT=${PURE_PORT}`,
    "-e",
    `AUTH_SECRET=${authSecret}`,
    "-e",
    `ADMIN_EMAIL=${TEST_EMAIL}`,
    "-e",
    `ADMIN_PASSWORD_HASH=${passwordHash}`,
    "-e",
    `AUTH_URL=${pureBase}`,
    IMAGE,
  ]);

  await waitForHealthz(PURE_PORT, "rabet-smoke-pure");
  log("Pure container passed startup /api/healthz readiness.");

  // Healthz assertions
  const healthRes = await rawRequest(pureBase, "/api/healthz");
  assert.equal(healthRes.status, 200);
  assert.match(healthRes.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(healthRes.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(healthRes.body), {
    status: "ok",
    sha: EXPECTED_SHA,
  });

  // Public landing page & compiled Tailwind CSS assertions
  const homeRes = await rawRequest(pureBase, "/");
  assert.equal(homeRes.status, 200);
  assert.ok(homeRes.body.includes("Showcase digital products in Telegram"));
  const cssHrefs = [...homeRes.body.matchAll(/href="(\/_next\/static\/[^"]+\.css[^"]*)"/g)].map(
    (m) => m[1],
  );
  assert.ok(cssHrefs.length >= 1, "Landing page HTML must link compiled /_next/static/*.css");
  for (const cssHref of cssHrefs) {
    const cssRes = await rawRequest(pureBase, cssHref);
    assert.equal(cssRes.status, 200, `Expected 200 for stylesheet ${cssHref}`);
    assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/i);
    assert.ok(cssRes.body.length > 1000, "Compiled CSS bundle must be non-trivial");
    assert.match(cssRes.headers.get("cache-control") ?? "", /immutable/i);
  }
  log(`Verified public page and ${cssHrefs.length} compiled CSS asset(s).`);

  // Manifest & PWA icons while signed out
  const manifestRes = await rawRequest(pureBase, "/manifest.webmanifest");
  assert.equal(manifestRes.status, 200);
  const manifest = JSON.parse(manifestRes.body);
  assert.equal(manifest.name, "Rabet");
  assert.equal(manifest.start_url, "/overview");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons?.length, 4);

  for (const iconPath of [
    "/icons/icon-192x192.png",
    "/icons/icon-512x192.png".replace("512x192", "512x512"),
    "/icons/maskable-192x192.png",
    "/icons/maskable-512x512.png",
    "/icons/apple-touch-icon.png",
    "/favicon.ico",
  ]) {
    const iconRes = await fetch(`${pureBase}${iconPath}`);
    assert.equal(iconRes.status, 200, `Expected 200 for ${iconPath}`);
    const buf = await iconRes.arrayBuffer();
    assert.ok(buf.byteLength > 100, `Expected non-empty asset for ${iconPath}`);
  }
  for (const swPath of ["/sw.js", "/service-worker.js"]) {
    const swRes = await rawRequest(pureBase, swPath);
    assert.equal(swRes.status, 404, `Expected 404 for ${swPath} per ADR-008`);
  }
  log("Verified Web App Manifest, PWA icons, favicon, and absence of service worker.");

  // Signed-out dashboard protection
  for (const dashPath of [...DASHBOARD_PATHS, "/api/admin"]) {
    const res = await rawRequest(pureBase, dashPath);
    assert.ok(
      [301, 302, 303, 307, 308].includes(res.status),
      `Expected redirect on signed-out ${dashPath}, got ${res.status}`,
    );
    assert.match(res.location ?? "", /\/login/);
    assert.equal(res.body.includes("Quick actions"), false);
    assert.equal(res.body.includes("Store-wide configuration"), false);
  }

  // Login page cache policy & privacy
  const loginPageRes = await rawRequest(pureBase, "/login");
  assert.equal(loginPageRes.status, 200);
  assert.ok(loginPageRes.body.includes('id="email"'));
  assert.equal(loginPageRes.body.includes(TEST_EMAIL), false);
  assert.match(loginPageRes.headers.get("cache-control") ?? "", /private/i);
  assert.match(loginPageRes.headers.get("cache-control") ?? "", /no-store/i);

  // Missing CSRF rejected
  const missingCsrfRes = await rawRequest(pureBase, "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      callbackUrl: `${pureBase}/overview`,
    }).toString(),
  });
  assert.match(missingCsrfRes.location ?? "", /MissingCSRF/);
  assert.equal(
    Object.keys(missingCsrfRes.jar).some((k) => k.includes("session-token")),
    false,
  );

  // Wrong password & unknown email rejected via Argon2id
  {
    const { csrfToken, jar } = await fetchCsrf(pureBase, {});
    const badPwRes = await rawRequest(pureBase, "/api/auth/callback/credentials", {
      jar,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken,
        email: TEST_EMAIL,
        password: "definitely-wrong-password",
        callbackUrl: `${pureBase}/overview`,
      }).toString(),
    });
    assert.match(badPwRes.location ?? "", /CredentialsSignin/);
    assert.equal(
      Object.keys(badPwRes.jar).some((k) => k.includes("session-token")),
      false,
    );
  }
  {
    const { csrfToken, jar } = await fetchCsrf(pureBase, {});
    const badEmailRes = await rawRequest(pureBase, "/api/auth/callback/credentials", {
      jar,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken,
        email: "nobody@example.test",
        password: TEST_PASSWORD,
        callbackUrl: `${pureBase}/overview`,
      }).toString(),
    });
    assert.match(badEmailRes.location ?? "", /CredentialsSignin/);
    assert.equal(
      Object.keys(badEmailRes.jar).some((k) => k.includes("session-token")),
      false,
    );
  }

  // Valid login exercises Argon2id inside the running standalone container
  const { csrfToken: validCsrf, jar: csrfJar } = await fetchCsrf(pureBase, {});
  const validLoginRes = await rawRequest(pureBase, "/api/auth/callback/credentials", {
    jar: csrfJar,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: validCsrf,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      callbackUrl: `${pureBase}/overview`,
    }).toString(),
  });
  assert.ok([302, 303].includes(validLoginRes.status));
  assert.match(validLoginRes.location ?? "", /\/overview$/);
  assert.equal(
    Object.keys(validLoginRes.jar).some((k) => k.includes("session-token")),
    true,
    "Expected session-token cookie after valid Argon2id login",
  );

  // Authenticated dashboard responses & cache policy
  for (const authedPath of ["/overview", "/settings", "/inquiries", "/customers"]) {
    const res = await rawRequest(pureBase, authedPath, { jar: { ...validLoginRes.jar } });
    assert.equal(res.status, 200, `Expected 200 on authenticated ${authedPath}`);
    assert.equal(
      res.headers.get("cache-control"),
      "private, no-store, must-revalidate",
      `Authenticated ${authedPath} must enforce strict private no-store cache policy`,
    );
    assert.equal(res.headers.get("pragma"), "no-cache");
  }
  const overviewPure = await rawRequest(pureBase, "/overview", {
    jar: { ...validLoginRes.jar },
  });
  assert.ok(overviewPure.body.includes("Quick actions"));
  assert.ok(overviewPure.body.includes("Database setup required"));

  const adminApiRes = await rawRequest(pureBase, "/api/admin", {
    jar: { ...validLoginRes.jar },
  });
  assert.equal(adminApiRes.status, 200);
  assert.deepEqual(JSON.parse(adminApiRes.body), { ok: true, admin: TEST_EMAIL });

  // Logout invalidates session
  const { csrfToken: outCsrf, jar: outJar } = await fetchCsrf(pureBase, {
    ...validLoginRes.jar,
  });
  const logoutRes = await rawRequest(pureBase, "/api/auth/signout", {
    jar: outJar,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: outCsrf,
      callbackUrl: `${pureBase}/login`,
    }).toString(),
  });
  assert.match(logoutRes.location ?? "", /\/login/);
  const afterLogoutRes = await rawRequest(pureBase, "/overview", {
    jar: logoutRes.jar,
  });
  assert.ok([302, 307].includes(afterLogoutRes.status));

  // Unconfigured webhook fails closed with 503
  const unconfiguredWebhookRes = await rawRequest(pureBase, "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: 1 }),
  });
  assert.equal(unconfiguredWebhookRes.status, 503);

  runDocker(["rm", "-f", "rabet-smoke-pure"], { allowFailure: true });
  log("Container #1 (pure unmodified image) passed all checks.");

  // -------------------------------------------------------------------------
  // 3. Container #2: Isolated PostgreSQL + Reverse-Proxy HTTPS + Webhook Gate
  // -------------------------------------------------------------------------
  log("Preparing isolated PostgreSQL database and local Neon/Telegram audit bridge...");
  smokeDbName = `rabet_container_smoke_${Date.now()}`;
  adminSql = postgres(TEST_PG_URL, { max: 1 });
  await adminSql.unsafe(`DROP DATABASE IF EXISTS ${smokeDbName}`);
  await adminSql.unsafe(`CREATE DATABASE ${smokeDbName}`);

  const smokeDbUrl = new URL(TEST_PG_URL);
  smokeDbUrl.pathname = `/${smokeDbName}`;

  const migrateRes = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: smokeDbUrl.toString() },
    encoding: "utf8",
  });
  if (migrateRes.status !== 0) {
    throw new Error(
      `Failed to migrate isolated smoke database:\n${migrateRes.stderr || migrateRes.stdout}`,
    );
  }

  smokeSql = postgres(smokeDbUrl.toString(), { max: 4 });
  const [seededLang] = await smokeSql`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('en', 'English', 'ltr', true)
    RETURNING id
  `;
  await smokeSql`
    INSERT INTO bot_setting (display_name, currency, default_language_id, ask_for_language)
    VALUES ('Render Smoke Store', 'USD', ${seededLang.id}, false)
  `;

  let sqlQueryCount = 0;
  let telegramCallCount = 0;

  mockServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (req.url?.startsWith("/neon-sql")) {
        sqlQueryCount += 1;
        try {
          const payload = JSON.parse(rawBody);
          const executeOne = async ({ query, params }) => {
            const rows = await smokeSql.unsafe(query, params || []);
            const cols = rows.columns || [];
            const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));
            const rowArrays = rows.map((r) => cols.map((c) => r[c.name]));
            return { rows: rowArrays, fields };
          };
          const responsePayload = Array.isArray(payload.queries)
            ? { results: await Promise.all(payload.queries.map(executeOne)) }
            : await executeOne(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responsePayload));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
          );
        }
        return;
      }

      if (req.url?.startsWith("/telegram-api")) {
        telegramCallCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise((resolve) => mockServer.listen(0, "0.0.0.0", resolve));
  const mockPort = mockServer.address().port;

  tempDir = mkdtempSync(path.join(tmpdir(), "rabet-smoke-bridge-"));
  chmodSync(tempDir, 0o755);
  const bridgePath = path.join(tempDir, "bridge.mjs");
  writeFileSync(
    bridgePath,
    `
      const origFetch = globalThis.fetch;
      const hostBase = process.env.SMOKE_HOST_BRIDGE;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        const hdrs = init?.headers ?? {};
        const connStr =
          typeof hdrs.get === "function"
            ? (hdrs.get("Neon-Connection-String") ?? hdrs.get("neon-connection-string") ?? "")
            : (hdrs["Neon-Connection-String"] ?? hdrs["neon-connection-string"] ?? "");
        const isSyntheticNeon =
          (url.includes("ep-example.neon.tech") || String(connStr).includes("ep-example.neon.tech")) &&
          (url.includes("/sql") || url.includes("neon.tech"));
        if (isSyntheticNeon) {
          return origFetch(hostBase + "/neon-sql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: init?.body,
          });
        }
        if (url.includes("api.telegram.org")) {
          return origFetch(hostBase + "/telegram-api", {
            method: init?.method ?? "POST",
            headers: { "content-type": "application/json" },
            body: init?.body,
          });
        }
        return origFetch(input, init);
      };
    `,
    { mode: 0o644 },
  );

  const dummyWebhookSecret = "dummy-smoke-webhook-secret-token-32chars";
  const dummyBotToken = "0000000000:DUMMY_SMOKE_BOT_TOKEN_NOT_REAL";
  const syntheticNeonUrl =
    "postgresql://rabet_user:synthetic_pass@ep-example.neon.tech/rabet_smoke?sslmode=require";

  log(`Booting reverse-proxy + DB + webhook container on PORT=${PROXY_PORT}...`);
  runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    "rabet-smoke-proxy",
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${bridgePath}:/tmp/smoke-bridge.mjs:ro`,
    "-p",
    `${PROXY_PORT}:${PROXY_PORT}`,
    "-e",
    `PORT=${PROXY_PORT}`,
    "-e",
    `AUTH_SECRET=${authSecret}`,
    "-e",
    `ADMIN_EMAIL=${TEST_EMAIL}`,
    "-e",
    `ADMIN_PASSWORD_HASH=${passwordHash}`,
    "-e",
    `AUTH_URL=${PROXY_ORIGIN}`,
    "-e",
    `APP_URL=${PROXY_ORIGIN}`,
    "-e",
    `DATABASE_URL=${syntheticNeonUrl}`,
    "-e",
    `TELEGRAM_BOT_TOKEN=${dummyBotToken}`,
    "-e",
    `TELEGRAM_WEBHOOK_SECRET=${dummyWebhookSecret}`,
    "-e",
    `SMOKE_HOST_BRIDGE=http://host.docker.internal:${mockPort}`,
    "-e",
    "NODE_OPTIONS=--import /tmp/smoke-bridge.mjs",
    IMAGE,
  ]);

  await waitForHealthz(PROXY_PORT, "rabet-smoke-proxy");
  const proxyLocalBase = `http://127.0.0.1:${PROXY_PORT}`;
  const proxyHeaders = {
    Host: "rabet-proxy.example.test",
    "X-Forwarded-Host": "rabet-proxy.example.test",
    "X-Forwarded-Proto": "https",
  };

  // Verify /api/healthz never queries Neon/Postgres or Telegram even when both are configured
  const sqlBeforeHealth = sqlQueryCount;
  const tgBeforeHealth = telegramCallCount;
  const proxyHealthRes = await rawRequest(proxyLocalBase, "/api/healthz", {
    headers: proxyHeaders,
  });
  assert.equal(proxyHealthRes.status, 200);
  assert.equal(sqlQueryCount, sqlBeforeHealth, "/api/healthz must execute 0 SQL queries");
  assert.equal(telegramCallCount, tgBeforeHealth, "/api/healthz must make 0 Telegram calls");

  // Reverse-proxy HTTPS redirect check: must redirect to PROXY_ORIGIN, never 0.0.0.0:4311
  const unauthProxyOverview = await rawRequest(proxyLocalBase, "/overview", {
    headers: proxyHeaders,
  });
  assert.ok([302, 307].includes(unauthProxyOverview.status));
  assert.equal(
    unauthProxyOverview.location,
    `${PROXY_ORIGIN}/login`,
    `Reverse-proxy unauthenticated redirect must target ${PROXY_ORIGIN}/login, got ${unauthProxyOverview.location}`,
  );

  // HTTPS login behind reverse proxy: must issue __Secure-authjs.session-token with Secure attribute
  const { csrfToken: httpsCsrf, jar: httpsCsrfJar } = await fetchCsrf(
    proxyLocalBase,
    {},
    proxyHeaders,
  );
  const httpsLoginRes = await rawRequest(
    proxyLocalBase,
    "/api/auth/callback/credentials",
    {
      jar: httpsCsrfJar,
      method: "POST",
      headers: {
        ...proxyHeaders,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrfToken: httpsCsrf,
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        callbackUrl: `${PROXY_ORIGIN}/overview`,
      }).toString(),
    },
  );
  assert.ok([302, 303].includes(httpsLoginRes.status));
  assert.equal(httpsLoginRes.location, `${PROXY_ORIGIN}/overview`);
  assert.ok(
    httpsLoginRes.jar["__Secure-authjs.session-token"],
    "HTTPS reverse-proxy login must issue __Secure-authjs.session-token",
  );
  assert.ok(
    httpsLoginRes.rawSetCookies.some(
      (c) =>
        c.startsWith("__Secure-authjs.session-token=") &&
        /;\s*Secure/i.test(c) &&
        /;\s*HttpOnly/i.test(c),
    ),
    "__Secure-authjs.session-token must carry Secure and HttpOnly attributes",
  );

  // Authenticated /overview reads from isolated PostgreSQL via neon-http
  const authedDbOverview = await rawRequest(proxyLocalBase, "/overview", {
    jar: httpsLoginRes.jar,
    headers: proxyHeaders,
  });
  assert.equal(authedDbOverview.status, 200);
  assert.ok(
    authedDbOverview.body.includes("Render Smoke Store"),
    "Authenticated /overview must render store name from isolated PostgreSQL",
  );
  assert.equal(
    authedDbOverview.headers.get("cache-control"),
    "private, no-store, must-revalidate",
  );
  assert.ok(sqlQueryCount > sqlBeforeHealth, "Expected SQL reads during /overview render");
  log("Verified HTTPS reverse-proxy auth redirects, __Secure- cookie, and isolated PostgreSQL dashboard read.");

  // Dummy webhook tests: missing & wrong secret must reject with 401, 0 SQL queries, 0 DB rows, 0 Telegram calls
  const sampleUpdatePayload = JSON.stringify({
    update_id: 900001,
    message: {
      message_id: 1,
      date: 1700000000,
      chat: { id: 123456, type: "private" },
      from: { id: 123456, is_bot: false, first_name: "Smoke" },
      text: "/start",
    },
  });

  const sqlBeforeWebhook = sqlQueryCount;
  const tgBeforeWebhook = telegramCallCount;

  // Case A: Missing X-Telegram-Bot-Api-Secret-Token
  const missingSecretRes = await rawRequest(proxyLocalBase, "/api/telegram/webhook", {
    method: "POST",
    headers: {
      ...proxyHeaders,
      "Content-Type": "application/json",
    },
    body: sampleUpdatePayload,
  });
  assert.equal(missingSecretRes.status, 401);

  // Case B: Wrong X-Telegram-Bot-Api-Secret-Token (different length)
  const wrongSecretShortRes = await rawRequest(proxyLocalBase, "/api/telegram/webhook", {
    method: "POST",
    headers: {
      ...proxyHeaders,
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
    },
    body: sampleUpdatePayload,
  });
  assert.equal(wrongSecretShortRes.status, 401);

  // Case C: Wrong X-Telegram-Bot-Api-Secret-Token (same byte length as dummyWebhookSecret)
  const sameLenWrongSecret = "X".repeat(dummyWebhookSecret.length);
  const wrongSecretSameLenRes = await rawRequest(proxyLocalBase, "/api/telegram/webhook", {
    method: "POST",
    headers: {
      ...proxyHeaders,
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": sameLenWrongSecret,
    },
    body: sampleUpdatePayload,
  });
  assert.equal(wrongSecretSameLenRes.status, 401);

  assert.equal(
    sqlQueryCount,
    sqlBeforeWebhook,
    "Rejected webhook requests must execute 0 SQL queries",
  );
  assert.equal(
    telegramCallCount,
    tgBeforeWebhook,
    "Rejected webhook requests must trigger 0 outbound Telegram calls",
  );

  const [{ count: updateCount }] = await smokeSql`SELECT COUNT(*)::int AS count FROM telegram_update`;
  const [{ count: customerCount }] = await smokeSql`SELECT COUNT(*)::int AS count FROM customer`;
  const [{ count: inquiryCount }] = await smokeSql`SELECT COUNT(*)::int AS count FROM inquiry`;
  assert.equal(updateCount, 0, "telegram_update table must remain empty");
  assert.equal(customerCount, 0, "customer table must remain empty");
  assert.equal(inquiryCount, 0, "inquiry table must remain empty");
  log("Verified webhook 401 rejection on missing/wrong secret with 0 DB writes and 0 Telegram calls.");

  runDocker(["rm", "-f", "rabet-smoke-proxy"], { allowFailure: true });

  // -------------------------------------------------------------------------
  // 4. Container #3: Fail-closed without ADMIN_EMAIL / ADMIN_PASSWORD_HASH
  // -------------------------------------------------------------------------
  log(`Booting fail-closed (no admin credentials) container on PORT=${CLOSED_PORT}...`);
  const closedBase = `http://127.0.0.1:${CLOSED_PORT}`;
  runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    "rabet-smoke-closed",
    "-p",
    `${CLOSED_PORT}:${CLOSED_PORT}`,
    "-e",
    `PORT=${CLOSED_PORT}`,
    "-e",
    `AUTH_SECRET=${authSecret}`,
    "-e",
    `AUTH_URL=${closedBase}`,
    IMAGE,
  ]);

  await waitForHealthz(CLOSED_PORT, "rabet-smoke-closed");

  const closedLoginPage = await rawRequest(closedBase, "/login");
  assert.equal(closedLoginPage.status, 200);
  assert.ok(
    closedLoginPage.body.includes("Sign-in is unavailable"),
    "Unprovisioned deployment must render honest 'Sign-in is unavailable' state",
  );

  const { csrfToken: closedCsrf, jar: closedJar } = await fetchCsrf(closedBase, {});
  const closedSignIn = await rawRequest(closedBase, "/api/auth/callback/credentials", {
    jar: closedJar,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: closedCsrf,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      callbackUrl: `${closedBase}/overview`,
    }).toString(),
  });
  assert.match(closedSignIn.location ?? "", /CredentialsSignin/);
  assert.equal(
    Object.keys(closedSignIn.jar).some((k) => k.includes("session-token")),
    false,
  );
  log("Verified fail-closed behavior when admin credentials are withheld.");

  await cleanup();
  log("✓ All container acceptance smoke checks passed.");
}

main().catch(async (err) => {
  process.stderr.write(
    `[container-smoke:FAIL] ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  await cleanup();
  process.exit(1);
});
