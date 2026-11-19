import { describe, expect, it } from "vitest";

import { classifyInvitationFailure } from "@/lib/merchant-invitation/responses";

describe("invitation response classification", () => {
  it("separates rate limits and temporary outages from an invalid invitation", () => {
    expect(classifyInvitationFailure(429)).toBe("rate_limited");
    expect(classifyInvitationFailure(500)).toBe("unavailable");
    expect(classifyInvitationFailure(503)).toBe("unavailable");
    expect(classifyInvitationFailure(400)).toBe("invalid");
    expect(classifyInvitationFailure(403)).toBe("invalid");
    expect(classifyInvitationFailure(404)).toBe("invalid");
  });
});
