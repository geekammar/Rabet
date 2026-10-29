#!/usr/bin/env node
/**
 * scripts/validate-audit-report.mjs
 *
 * Validates npm audit JSON output on GitHub-hosted runners.
 * Rejects missing, empty, or malformed JSON, npm error payloads,
 * and reports lacking expected audit metadata.
 *
 * Distinguishes valid reports with vulnerabilities from collection failures.
 */

import fs from "node:fs";

export function validateAuditReport(rawContent, commandExitCode) {
  if (typeof rawContent !== "string" || rawContent.trim().length === 0) {
    return {
      valid: false,
      error: "Report is empty or missing content.",
      classification: "collection_failed",
    };
  }

  let data;
  try {
    data = JSON.parse(rawContent);
  } catch (err) {
    return {
      valid: false,
      error: `Malformed JSON: ${err.message}`,
      classification: "collection_failed",
    };
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      valid: false,
      error: "Audit report root is not a valid JSON object.",
      classification: "collection_failed",
    };
  }

  // Detect npm CLI error response objects (e.g., registry errors, E404, ENOTFOUND)
  if (data.error) {
    const detail =
      typeof data.error === "object"
        ? (data.error.summary || data.error.code || JSON.stringify(data.error))
        : String(data.error);
    return {
      valid: false,
      error: `npm CLI returned an audit error response: ${detail}`,
      classification: "collection_failed",
    };
  }

  // Verify presence of standard audit metadata
  if (
    !data.metadata ||
    typeof data.metadata !== "object" ||
    !data.metadata.vulnerabilities ||
    typeof data.metadata.vulnerabilities !== "object"
  ) {
    return {
      valid: false,
      error: "Missing expected audit metadata or incompatible report shape.",
      classification: "collection_failed",
    };
  }

  if (!data.vulnerabilities || typeof data.vulnerabilities !== "object") {
    return {
      valid: false,
      error: "Missing expected vulnerabilities dictionary in audit report.",
      classification: "collection_failed",
    };
  }

  const vulns = data.metadata.vulnerabilities;
  const total = Number(vulns.total ?? 0);

  const counts = {
    info: Number(vulns.info ?? 0),
    low: Number(vulns.low ?? 0),
    moderate: Number(vulns.moderate ?? 0),
    high: Number(vulns.high ?? 0),
    critical: Number(vulns.critical ?? 0),
    total,
  };

  if (total === 0) {
    return {
      valid: true,
      classification: "clean",
      total: 0,
      counts,
      metadata: data.metadata,
      vulnerabilities: data.vulnerabilities,
    };
  }

  return {
    valid: true,
    classification: "findings",
    total,
    counts,
    metadata: data.metadata,
    vulnerabilities: data.vulnerabilities,
  };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2];
  const exitCodeArg = process.argv[3];
  const scope = process.argv[4] || "prod";

  if (!filePath) {
    console.error("Usage: node scripts/validate-audit-report.mjs <file> <exit-code> [prod|all]");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Validation error: file not found at ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const exitCode = parseInt(exitCodeArg ?? "0", 10);
  const result = validateAuditReport(raw, exitCode);

  if (!result.valid) {
    console.error(`\n[COLLECTION FAILED] Audit evidence collection failure for ${filePath}:`);
    console.error(`- Error: ${result.error}`);
    console.error(`- Command exit code: ${exitCode}`);
    process.exit(1);
  }

  console.log(`\n======================================================`);
  console.log(`AUDIT EVIDENCE REPORT: ${scope.toUpperCase()} (${filePath})`);
  console.log(`======================================================`);
  console.log(`Classification: ${result.classification.toUpperCase()}`);
  console.log(`Command exit code: ${exitCode}`);
  console.log(`Total vulnerabilities: ${result.total}`);
  console.log(`Breakdown: ${JSON.stringify(result.counts)}`);

  if (scope === "prod") {
    if (result.classification !== "clean") {
      console.error(`[BLOCKER] Production dependencies contain ${result.total} vulnerabilities.`);
      process.exit(1);
    }
    console.log(`[PASS] Production dependencies are completely clean (0 vulnerabilities).`);
    process.exit(0);
  } else {
    // All (including devDependencies)
    if (result.classification === "findings") {
      console.log(`[INFO] Full tree findings (devDependencies): ${result.total} advisories recorded.`);
      const keys = Object.keys(result.vulnerabilities);
      console.log(`Packages affected (${keys.length}): ${keys.join(", ")}`);
    } else {
      console.log(`[PASS] Full dependency tree is completely clean.`);
    }
    process.exit(0);
  }
}
