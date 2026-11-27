import { afterEach, describe, expect, it, vi } from "vitest";

const { start, resume } = vi.hoisted(() => ({
  start: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@/app/actions/merchant-notification-bot", () => ({
  startMerchantNotificationBotManagedAction: start,
  resumeMerchantNotificationBotManagedAction: resume,
}));

import { POST as postResume } from "../resume/route";
import { POST as postStart } from "../start/route";

const origin = "https://app.example.test";
const challenge = "abcDEF_123-xyz";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe.each([
  { name: "start", post: postStart, action: start, bot: "ManagerTestBot" },
  { name: "resume", post: postResume, action: resume, bot: "NotificationTestBot" },
])("notification bot $name route", ({ name, post, action, bot }) => {
  function request(agent: string) {
    return new Request(`${origin}/app/setup/notification-bot/${name}`, {
      method: "POST",
      headers: { Origin: origin, "User-Agent": agent },
      body: new URLSearchParams({ attemptId: "test-attempt" }),
    });
  }

  it.each(["Android", "desktop"])("preserves the challenge on %s", async (platform) => {
    vi.stubEnv("APP_URL", origin);
    const deepLink = `https://t.me/${bot}?start=${challenge}`;
    action.mockResolvedValue({ ok: true, managed: { deepLink } });

    const response = await post(request(platform));
    const location = response.headers.get("Location");

    expect(response.status).toBe(303);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    if (platform === "Android") {
      expect(location).toBe(
        `intent://resolve?domain=${bot}&start=${challenge}#Intent;scheme=tg;package=org.telegram.messenger;S.browser_fallback_url=${encodeURIComponent(
          `${origin}/app/setup#notification-bot-start-error=TELEGRAM_LAUNCH_FAILED`,
        )};end`,
      );
    } else {
      expect(location).toBe(deepLink);
    }
    expect(action).toHaveBeenCalledTimes(1);
  });
});
