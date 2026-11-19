import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isMerchantAppEnabled,
  MERCHANT_APP_ENABLED_ENV,
} from "@/lib/auth/merchant-gate";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("merchant app gate", () => {
  it("is off when the variable is absent", () => {
    expect(isMerchantAppEnabled()).toBe(false);
  });

  it("is off for every value except true", () => {
    for (const value of ["", "false", "1", "yes", "on", "TRUE-ish"]) {
      vi.stubEnv(MERCHANT_APP_ENABLED_ENV, value);
      expect(isMerchantAppEnabled()).toBe(false);
    }
  });

  it("enables only the exact true value, ignoring surrounding whitespace and case", () => {
    for (const value of ["true", "TRUE", " true "]) {
      vi.stubEnv(MERCHANT_APP_ENABLED_ENV, value);
      expect(isMerchantAppEnabled()).toBe(true);
    }
  });
});
