import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as preview } from "@/app/api/merchant-invitations/preview/route";
import { POST as accept } from "@/app/api/merchant-invitations/accept/route";

afterEach(() => {
  vi.unstubAllEnvs();
});

function post(path: string, body = "{}") {
  return new Request(`https://app.example.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://app.example.test",
      Host: "app.example.test",
    },
    body,
  });
}

describe("merchant invitation endpoints — enablement gate", () => {
  it("returns 404 before reading a token or touching the database while disabled", async () => {
    for (const handler of [preview, accept]) {
      const response = await handler(post("/api/merchant-invitations/preview"));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toContain("no-store");
      await expect(response.json()).resolves.toEqual({
        ok: false,
        code: "NOT_FOUND",
      });
    }
  });

  it("rejects cross-origin calls before the token limiter when enabled", async () => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");

    const response = await preview(
      new Request("https://app.example.test/api/merchant-invitations/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.test",
          Host: "app.example.test",
        },
        body: '{"token":"abc"}',
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("rejects malformed bodies with a generic response when enabled", async () => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");

    const response = await accept(post("/api/merchant-invitations/accept", "{"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });
});
