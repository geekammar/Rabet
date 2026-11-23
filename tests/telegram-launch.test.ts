import { describe, expect, it } from "vitest";

import {
  buildTelegramLaunchFallbackUrl,
  buildTelegramLaunchLinks,
  parseTelegramDeepLink,
  TELEGRAM_ANDROID_PACKAGE,
  TELEGRAM_X_ANDROID_PACKAGE,
} from "@/components/merchant/telegram-launch";

const START = "abcDEF_123-xyz";
const LINK = `https://t.me/Nokmelpre_bot?start=${START}`;

describe("Android Telegram launch links", () => {
  it("parses the manager deep link without changing the start value", () => {
    expect(parseTelegramDeepLink(LINK)).toEqual({
      username: "Nokmelpre_bot",
      start: START,
    });
  });

  it("targets regular Telegram and Telegram X with the same start value", () => {
    const fallback = buildTelegramLaunchFallbackUrl(
      "https://rabet-pr48-staging.onrender.com",
      "telegram",
    );
    const links = buildTelegramLaunchLinks(LINK, fallback);

    expect(links).not.toBeNull();
    if (!links) return;

    expect(links.telegramIntent).toContain(
      `package=${TELEGRAM_ANDROID_PACKAGE}`,
    );
    expect(links.telegramXIntent).toContain(
      `package=${TELEGRAM_X_ANDROID_PACKAGE}`,
    );
    expect(links.telegramIntent).toContain(`start=${START}`);
    expect(links.telegramXIntent).toContain(`start=${START}`);
    expect(links.telegramIntent).toContain("scheme=tg");
    expect(links.telegramXIntent).toContain("scheme=tg");
    expect(links.telegramIntent).toContain(
      encodeURIComponent(fallback),
    );
    expect(links.telegramXIntent).toContain(
      encodeURIComponent(fallback),
    );
    expect(links.telegramIntent).not.toContain("t.me/Nokmelpre_bot");
    expect(links.telegramXIntent).not.toContain("t.me/Nokmelpre_bot");
  });

  it("keeps a bot link without a start parameter", () => {
    const links = buildTelegramLaunchLinks(
      "https://t.me/rabet_3501f6ea_merchant_a_st_bot",
      "https://rabet-pr48-staging.onrender.com/app/setup#telegram-launch-failed=telegram-x",
    );

    expect(links).not.toBeNull();
    if (!links) return;
    expect(links.telegramIntent).toContain(
      "intent://resolve?domain=rabet_3501f6ea_merchant_a_st_bot#Intent;",
    );
    expect(links.telegramXIntent).toContain(
      "intent://resolve?domain=rabet_3501f6ea_merchant_a_st_bot#Intent;",
    );
  });

  it("rejects non-Telegram URLs and invalid usernames", () => {
    expect(parseTelegramDeepLink("https://example.test/foo")).toBeNull();
    expect(parseTelegramDeepLink("http://t.me/Nokmelpre_bot")).toBeNull();
    expect(parseTelegramDeepLink("https://t.me/a")).toBeNull();
  });
});

describe("merchant Telegram launch UI wiring", () => {
  it("uses direct app-choice anchors and does not auto-open the default app", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/components/merchant/merchant-telegram-connection.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("telegramIntent");
    expect(source).toContain("telegramXIntent");
    expect(source).toContain("merchant-telegram-open-x");
    expect(source).not.toContain("window.location.assign");
  });
});
