import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildAndroidTelegramLaunchTarget,
  buildOfficialTelegramIntent,
  buildTelegramLaunchFallbackUrl,
  isAndroidUserAgent,
  MERCHANT_TELEGRAM_START_PATH,
  OFFICIAL_TELEGRAM_ANDROID_PACKAGE,
  parseTelegramDeepLink,
} from "@/components/merchant/telegram-official-launch";

const START = "abcDEF_123-xyz";
const LINK = `https://t.me/Nokmelpre_bot?start=${START}`;

describe("official Telegram Android launch", () => {
  it("preserves the original manager deep link and start payload", () => {
    expect(parseTelegramDeepLink(LINK)).toEqual({
      username: "Nokmelpre_bot",
      start: START,
    });
  });

  it("targets only official Telegram with the same start value", () => {
    const fallback = buildTelegramLaunchFallbackUrl(
      "https://rabet-pr48-staging.onrender.com",
    );
    const intent = buildOfficialTelegramIntent(LINK, fallback);

    expect(intent).not.toBeNull();
    if (!intent) return;

    expect(intent).toContain("intent://resolve?");
    expect(intent).toContain("scheme=tg");
    expect(intent).toContain(
      `package=${OFFICIAL_TELEGRAM_ANDROID_PACKAGE}`,
    );
    expect(intent).toContain(`start=${START}`);
    expect(intent).not.toContain("org.thunderdog.challegram");
    expect(intent).toContain(encodeURIComponent(fallback));
    expect(fallback).toContain("/app/setup#telegram-launch-failed=telegram");
  });

  it("rejects non-Telegram links and invalid usernames", () => {
    expect(parseTelegramDeepLink("https://example.test/foo")).toBeNull();
    expect(parseTelegramDeepLink("http://t.me/Nokmelpre_bot")).toBeNull();
    expect(parseTelegramDeepLink("https://t.me/a")).toBeNull();
  });

  it("never falls back to a generic Telegram link on Android", () => {
    const fallback = buildTelegramLaunchFallbackUrl(
      "https://rabet-pr48-staging.onrender.com",
    );

    expect(buildAndroidTelegramLaunchTarget(LINK, fallback)).toContain(
      `package=${OFFICIAL_TELEGRAM_ANDROID_PACKAGE}`,
    );
    expect(buildAndroidTelegramLaunchTarget(LINK, fallback)).toContain(
      `start=${START}`,
    );
    expect(buildAndroidTelegramLaunchTarget("not-a-link", fallback)).toBe(
      fallback,
    );
  });

  it("detects Android from the request user agent", () => {
    expect(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel)")).toBe(
      true,
    );
    expect(isAndroidUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)")).toBe(
      false,
    );
    expect(isAndroidUserAgent(null)).toBe(false);
  });

  it("uses one form-post start path and the same official launch for both actions", () => {
    const component = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/components/merchant/merchant-telegram-connection.tsx",
      ),
      "utf8",
    );
    const route = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/app/app/setup/telegram/start/route.ts",
      ),
      "utf8",
    );

    expect(MERCHANT_TELEGRAM_START_PATH).toBe("/app/setup/telegram/start");
    expect(component).toContain("MERCHANT_TELEGRAM_START_PATH");
    expect(component).toContain('method="post"');
    expect(component).toContain("buildAndroidTelegramLaunchTarget");
    expect(component).not.toContain("isAndroidRuntime");
    expect(component).not.toContain("org.thunderdog.challegram");
    expect(component).not.toContain("merchant-telegram-open-x");
    expect(component).not.toContain("openTelegramX");

    expect(route).toContain("isSameOriginNavigationPost");
    expect(route).toContain("status: 303");
    expect(route).toContain("buildAndroidTelegramLaunchTarget");
    expect(route).toContain("isAndroidUserAgent");
  });
});
