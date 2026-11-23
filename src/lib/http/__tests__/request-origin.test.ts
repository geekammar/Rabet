import { describe, expect, it } from "vitest";

import {
  isSameOriginNavigationPost,
  isSameOriginRequest,
} from "@/lib/http/request-origin";

const ORIGIN = "https://app.example.test";

function post(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/app/setup/telegram/start`, {
    method: "POST",
    headers,
  });
}

describe("trusted request origin", () => {
  it("accepts a normal same-origin form post", () => {
    expect(isSameOriginRequest(post({ Origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(
      isSameOriginNavigationPost(post({ Origin: ORIGIN }), ORIGIN),
    ).toBe(true);
  });

  it("accepts a null origin only with same-origin Fetch Metadata", () => {
    expect(
      isSameOriginNavigationPost(
        post({ Origin: "null", "Sec-Fetch-Site": "same-origin" }),
        ORIGIN,
      ),
    ).toBe(true);
    expect(
      isSameOriginNavigationPost(
        post({ Origin: "null", "Sec-Fetch-Site": "cross-site" }),
        ORIGIN,
      ),
    ).toBe(false);
    expect(
      isSameOriginNavigationPost(post({ Origin: "null" }), ORIGIN),
    ).toBe(false);
  });

  it("rejects cross-origin posts", () => {
    expect(
      isSameOriginNavigationPost(
        post({ Origin: "https://evil.example.test" }),
        ORIGIN,
      ),
    ).toBe(false);
  });
});
