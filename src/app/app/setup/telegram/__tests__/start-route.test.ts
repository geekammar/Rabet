import { afterEach, describe, expect, it, vi } from "vitest";

const { startMerchantTelegramConnection } = vi.hoisted(() => ({
  startMerchantTelegramConnection: vi.fn(),
}));

vi.mock("@/app/actions/merchant-telegram", () => ({
  startMerchantTelegramConnection,
}));

import { POST } from "@/app/app/setup/telegram/start/route";

const ORIGIN = "https://app.example.test";
const START = "abcDEF_123-xyz";
const DEEP_LINK = `https://t.me/Nokmelpre_bot?start=${START}`;
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36";

function request(userAgent = ANDROID_UA): Request {
  return new Request(`${ORIGIN}/app/setup/telegram/start`, {
    method: "POST",
    headers: { Origin: ORIGIN, "User-Agent": userAgent },
  });
}

afterEach(() => {
  startMerchantTelegramConnection.mockReset();
  vi.unstubAllEnvs();
});

describe("merchant Telegram start route", () => {
  it("redirects an Android form post straight to official Telegram", async () => {
    vi.stubEnv("APP_URL", ORIGIN);
    startMerchantTelegramConnection.mockResolvedValue({
      ok: true,
      deepLink: DEEP_LINK,
    });

    const response = await POST(request());

    expect(response.status).toBe(303);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("intent://resolve?");
    expect(location).toContain("package=org.telegram.messenger");
    expect(location).toContain(`start=${START}`);
    expect(location).toContain(
      encodeURIComponent(`${ORIGIN}/app/setup#telegram-launch-failed=telegram`),
    );
    expect(location).not.toContain("org.thunderdog.challegram");
    expect(startMerchantTelegramConnection).toHaveBeenCalledTimes(1);
  });

  it("keeps the original HTTPS link on desktop", async () => {
    vi.stubEnv("APP_URL", ORIGIN);
    startMerchantTelegramConnection.mockResolvedValue({
      ok: true,
      deepLink: DEEP_LINK,
    });

    const response = await POST(request("Mozilla/5.0 (X11; Linux x86_64)"));

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(DEEP_LINK);
  });

  it("returns the same setup attempt with an error code when starting fails", async () => {
    vi.stubEnv("APP_URL", ORIGIN);
    startMerchantTelegramConnection.mockResolvedValue({
      ok: false,
      error: "UNAVAILABLE",
    });

    const response = await POST(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `${ORIGIN}/app/setup#telegram-start-error=UNAVAILABLE`,
    );
  });

  it("rejects cross-origin posts before creating an attempt", async () => {
    vi.stubEnv("APP_URL", ORIGIN);

    const response = await POST(
      new Request(`${ORIGIN}/app/setup/telegram/start`, {
        method: "POST",
        headers: { Origin: "https://evil.example.test", "User-Agent": ANDROID_UA },
      }),
    );

    expect(response.status).toBe(403);
    expect(startMerchantTelegramConnection).not.toHaveBeenCalled();
  });
});
