import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INVITATION_BODY_MAX_BYTES,
  isSameOriginRequest,
  merchantJson,
  readMerchantJson,
  trustedApplicationOrigin,
} from "@/lib/merchant-invitation/http";

const TRUSTED_ORIGIN = "https://app.example.test:8443";

function request(
  body: string,
  headers: Record<string, string> = {},
  url = `${TRUSTED_ORIGIN}/api/merchant-invitations/preview`,
) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function streamedRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  onCancel?: () => void,
) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });

  return new Request(`${TRUSTED_ORIGIN}/api/merchant-invitations/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", TRUSTED_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("merchant invitation HTTP helpers", () => {
  it("marks every response no-store, no-referrer and non-indexable", () => {
    const response = merchantJson({ ok: true });
    const headers = response.headers;

    expect(headers.get("cache-control")).toContain("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-robots-tag")).toContain("noindex");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("uses the configured application origin, including scheme and port", () => {
    expect(trustedApplicationOrigin()).toBe(TRUSTED_ORIGIN);

    vi.stubEnv("APP_URL", "https://app.example.test");
    expect(trustedApplicationOrigin()).toBe("https://app.example.test");

    vi.stubEnv("APP_URL", "not a url");
    expect(trustedApplicationOrigin()).toBeNull();
  });

  it("compares the complete Origin and ignores forwarded host headers", () => {
    expect(
      isSameOriginRequest(request("{}", { Origin: TRUSTED_ORIGIN })),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        request("{}", {
          Origin: TRUSTED_ORIGIN,
          Host: "internal.example.test",
          "X-Forwarded-Host": "other.example.test",
        }),
      ),
    ).toBe(true);
  });

  it("rejects missing Origin, scheme/port mismatches and a spoofed forwarded host", () => {
    expect(isSameOriginRequest(request("{}"))).toBe(false);
    expect(
      isSameOriginRequest(
        request("{}", { Origin: "http://app.example.test:8443" }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        request("{}", { Origin: "https://app.example.test:9443" }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        request("{}", {
          Origin: "https://evil.example.test",
          Host: "evil.example.test",
          "X-Forwarded-Host": "app.example.test:8443",
        }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        request("{}", { Origin: "null", Host: "app.example.test:8443" }),
      ),
    ).toBe(false);
  });

  it("fails closed when no trusted application origin is configured", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    expect(isSameOriginRequest(request("{}", { Origin: TRUSTED_ORIGIN }))).toBe(
      false,
    );
  });

  it("accepts application/json with valid parameters", async () => {
    expect(
      await readMerchantJson(
        request('{"token":"abc"}', {
          "Content-Type": "application/json; charset=UTF-8",
        }),
      ),
    ).toEqual({ token: "abc" });
  });

  it("rejects non-JSON, invalid parameters and non-object bodies", async () => {
    const textRequest = new Request(`${TRUSTED_ORIGIN}/x`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(await readMerchantJson(textRequest)).toBeNull();

    expect(
      await readMerchantJson(
        request('{"token":"abc"}', {
          "Content-Type": "application/json; charset=iso-8859-1",
        }),
      ),
    ).toBeNull();
    expect(await readMerchantJson(request("[]"))).toBeNull();
    expect(await readMerchantJson(request("null"))).toBeNull();
    expect(await readMerchantJson(request("{"))).toBeNull();
  });

  it("rejects a declared Content-Length that is invalid or over the cap", async () => {
    expect(
      await readMerchantJson(
        request("{}", { "Content-Length": "not-a-number" }),
      ),
    ).toBeNull();
    expect(
      await readMerchantJson(
        request("{}", { "Content-Length": String(INVITATION_BODY_MAX_BYTES + 1) }),
      ),
    ).toBeNull();
  });

  it("enforces the cap on streamed bodies without Content-Length", async () => {
    const encoder = new TextEncoder();
    const bodyOfSize = (size: number) => {
      const prefix = '{"token":"abc","pad":"';
      const suffix = '"}';
      return prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
    };

    const belowBody = bodyOfSize(INVITATION_BODY_MAX_BYTES - 256);
    expect(new TextEncoder().encode(belowBody).byteLength).toBeLessThan(
      INVITATION_BODY_MAX_BYTES,
    );
    expect(
      await readMerchantJson(
        streamedRequest([encoder.encode(belowBody)]),
      ),
    ).not.toBeNull();

    const exactBody = bodyOfSize(INVITATION_BODY_MAX_BYTES);
    expect(encoder.encode(exactBody).byteLength).toBe(INVITATION_BODY_MAX_BYTES);
    expect(
      await readMerchantJson(streamedRequest([encoder.encode(exactBody)])),
    ).not.toBeNull();

    let cancelled = false;
    const overBytes = encoder.encode(
      bodyOfSize(INVITATION_BODY_MAX_BYTES + 1),
    );
    expect(overBytes.byteLength).toBe(INVITATION_BODY_MAX_BYTES + 1);
    const overStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(overBytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const overRequest = new Request(
      `${TRUSTED_ORIGIN}/api/merchant-invitations/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: overStream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    expect(await readMerchantJson(overRequest)).toBeNull();
    expect(cancelled).toBe(true);
  });
});
