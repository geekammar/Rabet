#!/usr/bin/env node
/**
 * scripts/validate-audit-report.mjs
 *
 * Validates npm audit JSON output on GitHub-hosted runners.
 *
 * Requirements & Specifications:
 * - Supported report format: npm audit report version 2 (auditReportVersion === 2).
 * - Containers: plain non-array objects for root, metadata, metadata.vulnerabilities,
 *   and vulnerabilities dictionary.
 * - Required severity counters: info, low, moderate, high, critical, and total.
 * - Counter constraints: non-negative safe integers. No string, null, or undefined coercion.
 * - Consistency: total must equal the exact sum of the five severity counters.
 * - Dictionary alignment:
 *   - total === 0 requires an empty vulnerabilities dictionary.
 *   - total > 0 requires a non-empty vulnerabilities dictionary.
 * - Dependency metadata: if present in metadata.dependencies, must be a plain object
 *   with non-negative safe integer counts.
 * - Exit code handling:
 *   For `npm audit --omit=dev --json` and `npm audit --json`:
 *     - Exit 0: Process completed cleanly with 0 vulnerabilities matching criteria.
 *     - Exit 1: Process completed with 1 or more vulnerabilities discovered.
 *     - Exit 2 (or other / signal): Operational failure (network error, invalid options,
 *       malformed package.json).
 *   Command exit code must be explicitly provided as a safe integer.
 *   Exit code 0 requires total === 0.
 *   Exit code 1 requires total > 0.
 *   Any other exit code (e.g. 2, negative, or >1) indicates collection failure.
 *
 * CLI Usage:
 *   node scripts/validate-audit-report.mjs <file> <exit-code> <prod|all>
 */

import fs from "node:fs";

function isPlainObject(val) {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

const EXPECTED_SEVERITY_KEYS = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
  "total",
];

export function validateAuditReport(rawContent, commandExitCode) {
  // Validate command exit status explicitly (no defaulting to 0)
  if (
    commandExitCode === undefined ||
    commandExitCode === null ||
    typeof commandExitCode !== "number" ||
    !Number.isSafeInteger(commandExitCode)
  ) {
    return {
      valid: false,
      error: `Invalid or missing command exit code: expected a safe integer, got ${commandExitCode}.`,
      classification: "collection_failed",
    };
  }

  // Reject unsupported / error exit statuses such as 2 or signal-derived codes
  if (commandExitCode !== 0 && commandExitCode !== 1) {
    return {
      valid: false,
      error: `Unsupported or error command exit status: ${commandExitCode}. Expected 0 (clean) or 1 (vulnerabilities found).`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  if (typeof rawContent !== "string" || rawContent.trim().length === 0) {
    return {
      valid: false,
      error: "Report is empty or missing content.",
      classification: "collection_failed",
      exitCode: commandExitCode,
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
      exitCode: commandExitCode,
    };
  }

  if (!isPlainObject(data)) {
    return {
      valid: false,
      error: "Audit report root is not a plain JSON object.",
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  // Detect npm CLI error response objects (e.g., registry errors, E404, ENOTFOUND)
  if (data.error) {
    const detail =
      typeof data.error === "object"
        ? data.error.summary || data.error.code || JSON.stringify(data.error)
        : String(data.error);
    return {
      valid: false,
      error: `npm CLI returned an audit error response: ${detail}`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  // Validate supported audit report version
  if (data.auditReportVersion !== 2) {
    return {
      valid: false,
      error: `Unsupported or missing auditReportVersion: expected 2, got ${data.auditReportVersion}.`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  // Verify presence and type of standard audit metadata containers
  if (!isPlainObject(data.metadata)) {
    return {
      valid: false,
      error: "Missing or invalid metadata container: expected a plain object.",
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  if (!isPlainObject(data.metadata.vulnerabilities)) {
    return {
      valid: false,
      error:
        "Missing or invalid metadata.vulnerabilities container: expected a plain object.",
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  if (!isPlainObject(data.vulnerabilities)) {
    return {
      valid: false,
      error:
        "Missing or invalid vulnerabilities dictionary: expected a plain object.",
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  // Validate each entry in the vulnerabilities dictionary is a plain object
  for (const [pkg, entry] of Object.entries(data.vulnerabilities)) {
    if (!isPlainObject(entry)) {
      return {
        valid: false,
        error: `Vulnerability entry for "${pkg}" is not a plain object.`,
        classification: "collection_failed",
        exitCode: commandExitCode,
      };
    }
  }

  // Validate explicit presence and type of all severity counters and total
  const vulns = data.metadata.vulnerabilities;
  for (const key of EXPECTED_SEVERITY_KEYS) {
    if (!(key in vulns)) {
      return {
        valid: false,
        error: `Missing required vulnerability counter: "${key}".`,
        classification: "collection_failed",
        exitCode: commandExitCode,
      };
    }
    const val = vulns[key];
    if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 0) {
      return {
        valid: false,
        error: `Invalid vulnerability counter "${key}": expected non-negative safe integer, got ${typeof val === "string" ? `"${val}"` : val}.`,
        classification: "collection_failed",
        exitCode: commandExitCode,
      };
    }
  }

  // Require total to equal the exact sum of severity counters
  const severitySum =
    vulns.info + vulns.low + vulns.moderate + vulns.high + vulns.critical;
  if (vulns.total !== severitySum) {
    return {
      valid: false,
      error: `Vulnerability total mismatch: metadata.vulnerabilities.total (${vulns.total}) does not equal sum of severity counters (${severitySum}).`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  // Require dictionary count alignment with total
  const dictKeys = Object.keys(data.vulnerabilities);
  if (vulns.total === 0 && dictKeys.length > 0) {
    return {
      valid: false,
      error: `Report claims 0 total vulnerabilities but vulnerabilities dictionary contains ${dictKeys.length} items.`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }
  if (vulns.total > 0 && dictKeys.length === 0) {
    return {
      valid: false,
      error: `Report claims ${vulns.total} vulnerabilities but vulnerabilities dictionary is empty.`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  // Validate metadata.dependencies if present
  if (data.metadata.dependencies !== undefined) {
    if (!isPlainObject(data.metadata.dependencies)) {
      return {
        valid: false,
        error: "metadata.dependencies is not a plain object.",
        classification: "collection_failed",
        exitCode: commandExitCode,
      };
    }
    for (const [depKey, depVal] of Object.entries(data.metadata.dependencies)) {
      if (
        typeof depVal !== "number" ||
        !Number.isSafeInteger(depVal) ||
        depVal < 0
      ) {
        return {
          valid: false,
          error: `metadata.dependencies.${depKey} is not a non-negative safe integer: got ${depVal}.`,
          classification: "collection_failed",
          exitCode: commandExitCode,
        };
      }
    }
  }

  // Validate exit code consistency with findings count
  if (commandExitCode === 0 && vulns.total !== 0) {
    return {
      valid: false,
      error: `Inconsistent audit result: command exited 0 (clean) but report contains ${vulns.total} vulnerabilities.`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  if (commandExitCode === 1 && vulns.total === 0) {
    return {
      valid: false,
      error: `Inconsistent audit result: command exited 1 (findings) but report contains 0 vulnerabilities.`,
      classification: "collection_failed",
      exitCode: commandExitCode,
    };
  }

  const counts = {
    info: vulns.info,
    low: vulns.low,
    moderate: vulns.moderate,
    high: vulns.high,
    critical: vulns.critical,
    total: vulns.total,
  };

  if (vulns.total === 0) {
    return {
      valid: true,
      classification: "clean",
      total: 0,
      counts,
      exitCode: commandExitCode,
      metadata: data.metadata,
      vulnerabilities: data.vulnerabilities,
    };
  }

  return {
    valid: true,
    classification: "findings",
    total: vulns.total,
    counts,
    exitCode: commandExitCode,
    metadata: data.metadata,
    vulnerabilities: data.vulnerabilities,
  };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length !== 5) {
    console.error(
      "Usage: node scripts/validate-audit-report.mjs <file> <exit-code> <prod|all>",
    );
    process.exit(1);
  }

  const filePath = process.argv[2];
  const exitCodeArg = process.argv[3];
  const scope = process.argv[4];

  // Reject malformed exit code strings rather than partially parsing them
  if (!/^-?\d+$/.test(exitCodeArg.trim())) {
    console.error(
      `Validation error: malformed exit code argument "${exitCodeArg}". Expected an integer.`,
    );
    process.exit(1);
  }

  const exitCode = parseInt(exitCodeArg.trim(), 10);
  if (!Number.isSafeInteger(exitCode)) {
    console.error(
      `Validation error: exit code is not a safe integer: "${exitCodeArg}".`,
    );
    process.exit(1);
  }

  // Reject unsupported scopes explicitly
  if (scope !== "prod" && scope !== "all") {
    console.error(
      `Validation error: unsupported scope "${scope}". Supported scopes: "prod", "all".`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Validation error: file not found at ${filePath}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(
      `Validation error: failed to read file at ${filePath}: ${err.message}`,
    );
    process.exit(1);
  }

  const result = validateAuditReport(raw, exitCode);

  if (!result.valid) {
    console.error(
      `\n[COLLECTION FAILED] Audit evidence collection failure for ${filePath}:`,
    );
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
      console.error(
        `[BLOCKER] Production dependencies contain ${result.total} vulnerabilities.`,
      );
      process.exit(1);
    }
    console.log(
      `[PASS] Production dependencies are completely clean (0 vulnerabilities).`,
    );
    process.exit(0);
  } else {
    // All (full dependency tree)
    if (result.classification === "findings") {
      console.log(
        `[INFO] Full dependency tree findings: ${result.total} advisories recorded.`,
      );
      const keys = Object.keys(result.vulnerabilities);
      console.log(`Packages affected (${keys.length}): ${keys.join(", ")}`);
    } else {
      console.log(`[PASS] Full dependency tree is completely clean.`);
    }
    process.exit(0);
  }
}
