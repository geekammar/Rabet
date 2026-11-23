import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildOfficialTelegramIntent,
  buildTelegramLaunchFallbackUrl,
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

  it("restores one button and removes the two-app chooser code", () => {
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/components/merchant/merchant-telegram-connection.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("buildOfficialTelegramIntent");
    expect(source).not.toContain("org.thunderdog.challegram");
    expect(source).not.toContain("merchant-telegram-open-x");
    expect(source).not.toContain("openTelegramX");
  });
});
