import { describe, it, expect } from "vitest";
import {
  isValidInternalRedirect,
  safeLoginRedirect,
  DEFAULT_LOGIN_REDIRECT,
} from "@/lib/auth/redirect";

describe("safeLoginRedirect", () => {
  it("accepts a valid internal path", () => {
    expect(safeLoginRedirect("/overview")).toBe("/overview");
    expect(safeLoginRedirect("/inquiries")).toBe("/inquiries");
    expect(safeLoginRedirect("/orders/123")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects protocol-relative URLs", () => {
    expect(isValidInternalRedirect("//evil.com")).toBe(false);
    expect(safeLoginRedirect("//evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects absolute URLs", () => {
    expect(safeLoginRedirect("https://evil.com/x")).toBe(DEFAULT_LOGIN_REDIRECT);
    expect(safeLoginRedirect("http://evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects backslash evasions", () => {
    expect(safeLoginRedirect("/\\/evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
    expect(safeLoginRedirect("\\\\evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects percent-encoded evasions", () => {
    expect(safeLoginRedirect("/%2f%2fevil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects paths outside the allowlist", () => {
    expect(safeLoginRedirect("/admin")).toBe(DEFAULT_LOGIN_REDIRECT);
    expect(safeLoginRedirect("/")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("handles non-string input", () => {
    expect(safeLoginRedirect(null)).toBe(DEFAULT_LOGIN_REDIRECT);
    expect(safeLoginRedirect(undefined)).toBe(DEFAULT_LOGIN_REDIRECT);
    expect(safeLoginRedirect(42)).toBe(DEFAULT_LOGIN_REDIRECT);
  });
});
