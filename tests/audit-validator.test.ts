import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAuditReport } from "../scripts/validate-audit-report.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("validateAuditReport (Unit)", () => {
  it("accepts a valid clean report (0 vulnerabilities, exit 0)", () => {
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
        dependencies: { prod: 110, dev: 15, total: 125 },
      },
    });

    const result = validateAuditReport(cleanJson, 0);
    expect(result.valid).toBe(true);
    expect(result.classification).toBe("clean");
    expect(result.total).toBe(0);
    expect(result.counts).toEqual({
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    });
  });

  it("accepts a valid, internally consistent findings report (coherent small fixture, exit 1)", () => {
    const findingsJson = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        lodash: { name: "lodash", severity: "high" },
        minimist: { name: "minimist", severity: "moderate" },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 1,
          high: 1,
          critical: 0,
          total: 2,
        },
        dependencies: { prod: 110, dev: 15, total: 125 },
      },
    });

    const result = validateAuditReport(findingsJson, 1);
    expect(result.valid).toBe(true);
    expect(result.classification).toBe("findings");
    expect(result.total).toBe(2);
    expect(result.counts?.high).toBe(1);
    expect(result.counts?.moderate).toBe(1);
    expect(result.counts?.total).toBe(2);
  });

  describe("Four reviewer-reproduced invalid cases", () => {
    it("Case A: Rejects missing counters (exit code 0)", () => {
      const payload = JSON.stringify({
        metadata: { vulnerabilities: {} },
        vulnerabilities: {},
      });
      const result = validateAuditReport(payload, 0);
      expect(result.valid).toBe(false);
      expect(result.classification).toBe("collection_failed");

      // Also verify with auditReportVersion: 2
      const payloadWithVer = JSON.stringify({
        auditReportVersion: 2,
        metadata: { vulnerabilities: {} },
        vulnerabilities: {},
      });
      const resultWithVer = validateAuditReport(payloadWithVer, 0);
      expect(resultWithVer.valid).toBe(false);
      expect(resultWithVer.classification).toBe("collection_failed");
      expect(resultWithVer.error).toContain('Missing required vulnerability counter: "info"');
    });

    it("Case B: Rejects arrays instead of objects (exit code 0)", () => {
      const payload = JSON.stringify({
        metadata: { vulnerabilities: [] },
        vulnerabilities: [],
      });
      const result = validateAuditReport(payload, 0);
      expect(result.valid).toBe(false);
      expect(result.classification).toBe("collection_failed");

      // Also verify with auditReportVersion: 2
      const payloadWithVer = JSON.stringify({
        auditReportVersion: 2,
        metadata: { vulnerabilities: [] },
        vulnerabilities: [],
      });
      const resultWithVer = validateAuditReport(payloadWithVer, 0);
      expect(resultWithVer.valid).toBe(false);
      expect(resultWithVer.classification).toBe("collection_failed");
      expect(resultWithVer.error).toContain("Missing or invalid metadata.vulnerabilities container: expected a plain object");
    });

    it("Case C: Rejects invalid total string (not a number, exit code 0)", () => {
      const payload = JSON.stringify({
        metadata: { vulnerabilities: { total: "not-a-number" } },
        vulnerabilities: {},
      });
      const result = validateAuditReport(payload, 0);
      expect(result.valid).toBe(false);
      expect(result.classification).toBe("collection_failed");

      // Also verify with auditReportVersion: 2 and all counters present but total is string
      const payloadWithVer = JSON.stringify({
        auditReportVersion: 2,
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: "not-a-number",
          },
        },
        vulnerabilities: {},
      });
      const resultWithVer = validateAuditReport(payloadWithVer, 0);
      expect(resultWithVer.valid).toBe(false);
      expect(resultWithVer.classification).toBe("collection_failed");
      expect(resultWithVer.error).toContain('Invalid vulnerability counter "total": expected non-negative safe integer');
    });

    it("Case D: Rejects failed command exit code (exit code 2)", () => {
      const payload = JSON.stringify({
        metadata: {
          vulnerabilities: { total: 1, high: 1 },
        },
        vulnerabilities: { demo: { severity: "high" } },
      });
      const result = validateAuditReport(payload, 2);
      expect(result.valid).toBe(false);
      expect(result.classification).toBe("collection_failed");
      expect(result.error).toContain("Unsupported or error command exit status: 2");

      // Also verify with version 2
      const payloadWithVer = JSON.stringify({
        auditReportVersion: 2,
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 1,
            critical: 0,
            total: 1,
          },
        },
        vulnerabilities: { demo: { severity: "high" } },
      });
      const resultWithVer = validateAuditReport(payloadWithVer, 2);
      expect(resultWithVer.valid).toBe(false);
      expect(resultWithVer.classification).toBe("collection_failed");
      expect(resultWithVer.error).toContain("Unsupported or error command exit status: 2");
    });
  });

  describe("Schema & Counter Validation", () => {
    const baseValidReport = {
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
      },
    };

    it("rejects unsupported auditReportVersion", () => {
      const report = { ...baseValidReport, auditReportVersion: 1 };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported or missing auditReportVersion");
    });

    it("rejects non-object root container", () => {
      const result = validateAuditReport(JSON.stringify(["not", "an", "object"]), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Audit report root is not a plain JSON object");
    });

    it("rejects non-object metadata container", () => {
      const report = { ...baseValidReport, metadata: "invalid-container" };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing or invalid metadata container: expected a plain object");
    });

    it("rejects non-object vulnerabilities dictionary container", () => {
      const report = { ...baseValidReport, vulnerabilities: ["array"] };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing or invalid vulnerabilities dictionary: expected a plain object");
    });

    it("rejects non-object vulnerability entry in dictionary", () => {
      const report = {
        auditReportVersion: 2,
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
        },
        vulnerabilities: { lodash: "not-a-plain-object" },
      };
      const result = validateAuditReport(JSON.stringify(report), 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Vulnerability entry for "lodash" is not a plain object');
    });

    it("rejects missing individual severity counter", () => {
      const missingCritical = { ...baseValidReport.metadata.vulnerabilities };
      delete (missingCritical as Record<string, unknown>).critical;
      const report = {
        ...baseValidReport,
        metadata: { vulnerabilities: missingCritical },
      };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing required vulnerability counter: "critical"');
    });

    it("rejects negative counter values", () => {
      const report = {
        ...baseValidReport,
        metadata: {
          vulnerabilities: {
            ...baseValidReport.metadata.vulnerabilities,
            low: -1,
            total: -1,
          },
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expected non-negative safe integer");
    });

    it("rejects fractional counter values", () => {
      const report = {
        ...baseValidReport,
        metadata: {
          vulnerabilities: {
            ...baseValidReport.metadata.vulnerabilities,
            high: 1.5,
            total: 1.5,
          },
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expected non-negative safe integer");
    });

    it("rejects string coercion for counters", () => {
      const report = {
        ...baseValidReport,
        metadata: {
          vulnerabilities: {
            ...baseValidReport.metadata.vulnerabilities,
            info: "0",
          },
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expected non-negative safe integer");
    });

    it("rejects severity totals that do not add up", () => {
      const report = {
        ...baseValidReport,
        metadata: {
          vulnerabilities: {
            info: 1,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 5, // mismatch: sum is 1
          },
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Vulnerability total mismatch");
    });

    it("rejects a zero-total report with non-empty vulnerability dictionary", () => {
      const report = {
        auditReportVersion: 2,
        vulnerabilities: { demo: { severity: "low" } },
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 0,
          },
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Report claims 0 total vulnerabilities but vulnerabilities dictionary contains 1 items");
    });

    it("rejects a positive-total report with an empty vulnerability dictionary", () => {
      const report = {
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 1,
            critical: 0,
            total: 1,
          },
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Report claims 1 vulnerabilities but vulnerabilities dictionary is empty");
    });

    it("rejects non-object metadata.dependencies", () => {
      const report = {
        ...baseValidReport,
        metadata: {
          ...baseValidReport.metadata,
          dependencies: "not-an-object",
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("metadata.dependencies is not a plain object");
    });

    it("rejects invalid dependency count in metadata.dependencies", () => {
      const report = {
        ...baseValidReport,
        metadata: {
          ...baseValidReport.metadata,
          dependencies: { prod: "110" },
        },
      };
      const result = validateAuditReport(JSON.stringify(report), 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("metadata.dependencies.prod is not a non-negative safe integer");
    });
  });

  describe("Exit code and Error Payload validation", () => {
    const cleanValidJson = JSON.stringify({
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
      },
    });

    it("rejects missing exit code (undefined or null)", () => {
      const res1 = validateAuditReport(cleanValidJson, undefined as unknown as number);
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain("Invalid or missing command exit code");

      const res2 = validateAuditReport(cleanValidJson, null as unknown as number);
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain("Invalid or missing command exit code");
    });

    it("rejects non-integer exit code", () => {
      const res = validateAuditReport(cleanValidJson, 0.5 as unknown as number);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Invalid or missing command exit code");
    });

    it("rejects unsupported exit code numbers (e.g. 2, -1, 127)", () => {
      const res2 = validateAuditReport(cleanValidJson, 2);
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain("Unsupported or error command exit status: 2");

      const resNeg = validateAuditReport(cleanValidJson, -1);
      expect(resNeg.valid).toBe(false);
      expect(resNeg.error).toContain("Unsupported or error command exit status: -1");

      const res127 = validateAuditReport(cleanValidJson, 127);
      expect(res127.valid).toBe(false);
      expect(res127.error).toContain("Unsupported or error command exit status: 127");
    });

    it("rejects exit code 0 when report contains vulnerabilities", () => {
      const findingsJson = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: { pkg: { severity: "high" } },
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 1,
            critical: 0,
            total: 1,
          },
        },
      });
      const result = validateAuditReport(findingsJson, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Inconsistent audit result: command exited 0 (clean) but report contains 1 vulnerabilities");
    });

    it("rejects exit code 1 when report contains 0 vulnerabilities", () => {
      const result = validateAuditReport(cleanValidJson, 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Inconsistent audit result: command exited 1 (findings) but report contains 0 vulnerabilities");
    });

    it("rejects npm error response object as collection failure", () => {
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
      const result = validateAuditReport("{ not valid json", 1);
      expect(result.valid).toBe(false);
      expect(result.classification).toBe("collection_failed");
      expect(result.error).toContain("Malformed JSON");
    });

    it("rejects empty or whitespace-only content", () => {
      const result = validateAuditReport("   \n\t", 0);
      expect(result.valid).toBe(false);
      expect(result.classification).toBe("collection_failed");
      expect(result.error).toContain("empty or missing");
    });
  });
});

describe("validateAuditReport CLI (Subprocess)", () => {
  const cliScript = path.resolve(__dirname, "../scripts/validate-audit-report.mjs");
  const tmpDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);

  const cleanFile = path.join(tmpDir, "clean.json");
  const findingsFile = path.join(tmpDir, "findings.json");
  const invalidFile = path.join(tmpDir, "invalid.json");

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      cleanFile,
      JSON.stringify({
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
          dependencies: { prod: 110, total: 110 },
        },
      }),
      "utf8",
    );

    fs.writeFileSync(
      findingsFile,
      JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          lodash: { name: "lodash", severity: "high" },
        },
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 1,
            critical: 0,
            total: 1,
          },
          dependencies: { prod: 110, dev: 15, total: 125 },
        },
      }),
      "utf8",
    );

    fs.writeFileSync(invalidFile, '{"metadata":{"vulnerabilities":{}},"vulnerabilities":{}}', "utf8");
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("node", [cliScript, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err: unknown) {
      const error = err as {
        status?: number;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      return {
        status: error.status ?? 1,
        stdout: error.stdout?.toString() ?? "",
        stderr: error.stderr?.toString() ?? "",
      };
    }
  }

  it("passes cleanly for clean production audit (exit 0)", () => {
    const res = runCli([cleanFile, "0", "prod"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("AUDIT EVIDENCE REPORT: PROD");
    expect(res.stdout).toContain("Production dependencies are completely clean");
  });

  it("fails production gate when vulnerabilities exist in prod (exit 1)", () => {
    const res = runCli([findingsFile, "1", "prod"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[BLOCKER] Production dependencies contain 1 vulnerabilities");
  });

  it("accepts valid full-tree findings with informational output (exit 0)", () => {
    const res = runCli([findingsFile, "1", "all"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("AUDIT EVIDENCE REPORT: ALL");
    expect(res.stdout).toContain("[INFO] Full dependency tree findings: 1 advisories recorded");
    expect(res.stdout).toContain("Packages affected (1): lodash");
  });

  it("fails when report content is invalid (exit 1)", () => {
    const res = runCli([invalidFile, "0", "prod"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[COLLECTION FAILED]");
  });

  it("fails when exit code argument is missing (exit 1)", () => {
    const res = runCli([cleanFile]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage: node scripts/validate-audit-report.mjs");
  });

  it("fails when exit code argument is malformed (exit 1)", () => {
    const res = runCli([cleanFile, "0abc", "prod"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('malformed exit code argument "0abc"');
  });

  it("fails when scope argument is unsupported (exit 1)", () => {
    const res = runCli([cleanFile, "0", "unsupported"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unsupported scope "unsupported"');
  });

  it("fails when target file does not exist (exit 1)", () => {
    const res = runCli([path.join(tmpDir, "nonexistent.json"), "0", "prod"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("file not found");
  });
});
