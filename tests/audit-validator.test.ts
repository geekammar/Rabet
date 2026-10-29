import { describe, expect, it } from "vitest";
import { validateAuditReport } from "../scripts/validate-audit-report.mjs";

describe("validateAuditReport", () => {
  it("accepts a valid clean report (0 vulnerabilities)", () => {
    const cleanJson = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        },
        dependencies: { prod: 110, total: 915 },
      },
    });

    const result = validateAuditReport(cleanJson, 0);
    expect(result.valid).toBe(true);
    expect(result.classification).toBe("clean");
    expect(result.total).toBe(0);
  });

  it("classifies a valid report containing findings as findings", () => {
    const findingsJson = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        deepmerge: { severity: "high" },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 1,
          moderate: 9,
          high: 6,
          critical: 0,
          total: 16,
        },
        dependencies: { prod: 110, total: 915 },
      },
    });

    const result = validateAuditReport(findingsJson, 1);
    expect(result.valid).toBe(true);
    expect(result.classification).toBe("findings");
    expect(result.total).toBe(16);
    expect(result.counts?.high).toBe(6);
    expect(result.counts?.moderate).toBe(9);
  });

  it("rejects an npm error response object as collection failure", () => {
    const errorJson = JSON.stringify({
      error: {
        code: "ENOTFOUND",
        summary: "getaddrinfo ENOTFOUND registry.npmjs.org",
      },
    });

    const result = validateAuditReport(errorJson, 1);
    expect(result.valid).toBe(false);
    expect(result.classification).toBe("collection_failed");
    expect(result.error).toContain("npm CLI returned an audit error response");
  });

  it("rejects malformed JSON", () => {
    const malformed = "{ auditReportVersion: 2, unclosed";
    const result = validateAuditReport(malformed, 1);
    expect(result.valid).toBe(false);
    expect(result.classification).toBe("collection_failed");
    expect(result.error).toContain("Malformed JSON");
  });

  it("rejects missing expected metadata", () => {
    const missingMetadata = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
    });
    const result = validateAuditReport(missingMetadata, 0);
    expect(result.valid).toBe(false);
    expect(result.classification).toBe("collection_failed");
    expect(result.error).toContain("Missing expected audit metadata");
  });

  it("rejects empty or whitespace-only content", () => {
    const result = validateAuditReport("   \n", 0);
    expect(result.valid).toBe(false);
    expect(result.classification).toBe("collection_failed");
    expect(result.error).toContain("empty or missing");
  });

  it("rejects when npm exit code is non-zero despite 0 vulnerabilities", () => {
    const cleanJson = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        },
        dependencies: { prod: 110, total: 915 },
      },
    });

    const result = validateAuditReport(cleanJson, 1);
    expect(result.valid).toBe(false);
    expect(result.classification).toBe("collection_failed");
    expect(result.error).toContain("non-zero exit code");
  });
});
