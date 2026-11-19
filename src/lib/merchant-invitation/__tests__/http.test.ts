import { describe, expect, it } from "vitest";

import {
  INVITATION_BODY_MAX_BYTES,
  isSameOriginRequest,
  merchantJson,
  readMerchantJson,
} from "@/lib/merchant-invitation/http";

function request(
  body: string,
  headers: Record<string, string> = {},
  url = "https://app.example.test/api/merchant-invitations/preview",
) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("merchant invitation HTTP helpers", () => {
  it("marks every response no-store, no-referrer and non-indexable", () => {
    const response = merchantJson({ ok: true });
    const headers = response.headers;

    expect(headers.get("cache-control")).toContain("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-robots-tag")).toContain("noindex");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("accepts only a same-origin browser POST", () => {
    expect(
      isSameOriginRequest(
        request("{}", { Origin: "https://app.example.test", Host: "app.example.test" }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        request("{}", {
          Origin: "https://app.example.test",
          "X-Forwarded-Host": "app.example.test",
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        request("{}", { Origin: "https://evil.example.test", Host: "app.example.test" }),
      ),
    ).toBe(false);
    expect(isSameOriginRequest(request("{}"))).toBe(false);
    expect(
      isSameOriginRequest(request("{}", { Origin: "null", Host: "app.example.test" })),
    ).toBe(false);
  });

  it("rejects non-JSON, oversized and non-object bodies", async () => {
    const textRequest = new Request("https://app.example.test/x", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(await readMerchantJson(textRequest)).toBeNull();

    expect(
      await readMerchantJson(
        request("x".repeat(INVITATION_BODY_MAX_BYTES + 1)),
      ),
    ).toBeNull();
    expect(await readMerchantJson(request("[]"))).toBeNull();
    expect(await readMerchantJson(request("null"))).toBeNull();
    expect(await readMerchantJson(request("{"))).toBeNull();
    expect(await readMerchantJson(request('{"token":"abc"}'))).toEqual({
      token: "abc",
    });
  });
});
