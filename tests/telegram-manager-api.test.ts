import { describe, expect, it, vi } from "vitest";

import { createTelegramBotApiClient } from "@/lib/telegram/manager-api";

const TOKEN = "123456789:AA-manager-token-never-returned";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("manager bot API client", () => {
  it("calls getMe and returns the bot identity", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          id: 9001,
          is_bot: true,
          first_name: "Rabet Manager",
          username: "RabetManagerBot",
        },
      }),
    );
    const api = createTelegramBotApiClient(TOKEN, { fetchImpl });

    const result = await api.getMe();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.id).toBe(9001);
    expect(result.result.username).toBe("RabetManagerBot");
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${TOKEN}/getMe`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("passes the managed bot user id and returns a token without exposing it in errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: "987654321:AA-managed-token" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            description: `Unauthorized ${TOKEN}`,
            error_code: 401,
          },
          401,
        ),
      );

    const api = createTelegramBotApiClient(TOKEN, { fetchImpl });

    const token = await api.getManagedBotToken(987654321);
    expect(token).toEqual({
      ok: true,
      result: "987654321:AA-managed-token",
    });

    const forbidden = await api.getWebhookInfo();
    expect(forbidden.ok).toBe(false);
    if (forbidden.ok) return;
    expect(forbidden.error).not.toContain(TOKEN);
    expect(forbidden.error).toContain("[REDACTED_BOT_TOKEN]");
  });

  it("registers a webhook with the per-connection secret and verifies its URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            url: "https://app.example.test/api/telegram/webhook/managed/abc",
            pending_update_count: 0,
          },
        }),
      );

    const api = createTelegramBotApiClient(TOKEN, { fetchImpl });
    const set = await api.setWebhook({
      url: "https://app.example.test/api/telegram/webhook/managed/abc",
      secretToken: "webhook-secret",
      allowedUpdates: ["message", "callback_query"],
    });

    expect(set).toEqual({ ok: true, result: true });
    const [, options] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({
      url: "https://app.example.test/api/telegram/webhook/managed/abc",
      secret_token: "webhook-secret",
      allowed_updates: ["message", "callback_query"],
    });

    const info = await api.getWebhookInfo();
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    expect(info.result.url).toBe(
      "https://app.example.test/api/telegram/webhook/managed/abc",
    );
  });

  it("redacts the token from network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network failed for /bot${TOKEN}/getMe`);
    });
    const api = createTelegramBotApiClient(TOKEN, { fetchImpl });

    const result = await api.getMe();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toBe("Network error contacting Telegram");
  });
});
