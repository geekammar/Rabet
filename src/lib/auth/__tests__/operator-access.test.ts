import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPERATOR_ACCESS_KEY_ENV,
  OPERATOR_ACCESS_USER,
  checkOperatorAccess,
  isOperatorAccessPath,
  operatorAccessChallenge,
} from "@/lib/auth/operator-access";

const TEST_KEY = "test-operator-access-key-32-characters-minimum";

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("operator access", () => {
  it("accepts the fixed username and configured high-entropy key", () => {
    vi.stubEnv(OPERATOR_ACCESS_KEY_ENV, TEST_KEY);

    expect(checkOperatorAccess(basic(OPERATOR_ACCESS_USER, TEST_KEY))).toBe(
      true,
    );
  });

  it("rejects a wrong username or key", () => {
    vi.stubEnv(OPERATOR_ACCESS_KEY_ENV, TEST_KEY);

    expect(checkOperatorAccess(basic("admin", TEST_KEY))).toBe(false);
    expect(checkOperatorAccess(basic(OPERATOR_ACCESS_USER, "wrong-key"))).toBe(
      false,
    );
  });

  it("fails closed for missing, short, or malformed configuration", () => {
    delete process.env[OPERATOR_ACCESS_KEY_ENV];

    expect(checkOperatorAccess(basic(OPERATOR_ACCESS_USER, TEST_KEY))).toBe(
      false,
    );

    vi.stubEnv(OPERATOR_ACCESS_KEY_ENV, "too-short");
    expect(checkOperatorAccess(basic(OPERATOR_ACCESS_USER, "too-short"))).toBe(
      false,
    );

    vi.stubEnv(OPERATOR_ACCESS_KEY_ENV, TEST_KEY);
    expect(checkOperatorAccess(null)).toBe(false);
    expect(checkOperatorAccess("Bearer something")).toBe(false);
    expect(checkOperatorAccess("Basic not-valid-base64!!")).toBe(false);
    expect(checkOperatorAccess("Basic")).toBe(false);
  });

  it("returns the same non-cacheable 401 challenge for every rejection", async () => {
    const response = operatorAccessChallenge();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Operator access required.\n");
  });

  it("recognises only the two credential entry paths", () => {
    expect(isOperatorAccessPath("/login")).toBe(true);
    expect(isOperatorAccessPath("/login/")).toBe(true);
    expect(isOperatorAccessPath("/api/auth/callback/credentials")).toBe(true);
    expect(isOperatorAccessPath("/api/auth/callback/credentials/")).toBe(true);
    expect(isOperatorAccessPath("/api/auth/csrf")).toBe(false);
    expect(isOperatorAccessPath("/api/auth/session")).toBe(false);
    expect(isOperatorAccessPath("/api/healthz")).toBe(false);
    expect(isOperatorAccessPath("/api/telegram/webhook")).toBe(false);
    expect(isOperatorAccessPath("/overview")).toBe(false);
  });
});
