import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

const REVIEWED_SHA = "2085f109fd15004b9fa0ef229945267e084fb054";
const OTHER_SHA = "ca80c8b356176d51f8416293d92be50dfd00ed05";

type GuardEnv = Record<string, string>;

type WorkflowCase = {
  name: string;
  file: string;
  nextJob: string;
  dbCommand: string;
  validEnv: GuardEnv;
};

const workflows: WorkflowCase[] = [
  {
    name: "migration",
    file: ".github/workflows/neon-prod-migrate.yml",
    nextJob: "neon-prod",
    dbCommand: "run: node scripts/neon-prod-actions.mjs",
    validEnv: {
      RABET_REF: "refs/heads/main",
      RABET_EVENT: "workflow_dispatch",
      RABET_EXPECTED_SHA: REVIEWED_SHA,
      RABET_MODE: "inspect",
      RABET_CONFIRM: "",
    },
  },
  {
    name: "bootstrap",
    file: ".github/workflows/neon-prod-bootstrap-admin.yml",
    nextJob: "bootstrap",
    dbCommand: "run: node scripts/neon-prod-bootstrap-admin.mjs",
    validEnv: {
      RABET_REF: "refs/heads/main",
      RABET_EVENT: "workflow_dispatch",
      RABET_EXPECTED_SHA: REVIEWED_SHA,
      RABET_EMAIL: "owner@example.test",
      RABET_CONFIRM: "PROVISION_RABET_SUPER_ADMIN",
    },
  },
];

function readWorkflow(file: string): string {
  return readFileSync(path.resolve(root, file), "utf8");
}

function guardBlock(workflow: string, nextJob: string): string {
  const start = workflow.indexOf("\n  guard:\n");
  expect(start, "the early guard job must exist").toBeGreaterThanOrEqual(0);

  const end = workflow.indexOf(`\n  ${nextJob}:\n`, start);
  expect(end, `the ${nextJob} job must follow the guard job`).toBeGreaterThan(
    start,
  );

  return workflow.slice(start, end);
}

function guardScript(workflow: string, nextJob: string): string {
  const block = guardBlock(workflow, nextJob);
  const match = block.match(/node - <<'NODE'\n([\s\S]*?)\n\s*NODE\n/);
  expect(match, "the early guard must run an inline Node validator").not.toBeNull();
  return match![1];
}

function productionJob(workflow: string, nextJob: string): string {
  const start = workflow.indexOf(`\n  ${nextJob}:\n`);
  expect(start, `the ${nextJob} job must exist`).toBeGreaterThanOrEqual(0);
  return workflow.slice(start);
}

function withoutExpectedSha(env: GuardEnv): GuardEnv {
  const copy = { ...env };
  delete copy.RABET_EXPECTED_SHA;
  return copy;
}

function runGuard(script: string, env: GuardEnv) {
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });

  return {
    code: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

describe.each(workflows)(
  "$name Production workflow bind to the approved SHA",
  ({ file, nextJob, dbCommand, validEnv }) => {
    const workflow = readWorkflow(file);
    const script = guardScript(workflow, nextJob);
    const block = guardBlock(workflow, nextJob);
    const production = productionJob(workflow, nextJob);

    it("declares expected_sha as a required workflow input", () => {
      const inputs = workflow.split("jobs:")[0].split("inputs:")[1] ?? "";
      expect(inputs).toMatch(/expected_sha:[\s\S]*?required: true/);
    });

    it("passes the input through env instead of interpolating it into shell", () => {
      expect(block).toContain(
        "RABET_EXPECTED_SHA: ${{ inputs.expected_sha }}",
      );

      const runBody = block.slice(block.indexOf("run: |"));
      expect(runBody).not.toContain("${{ inputs.expected_sha }}");
    });

    it("checks out the workflow event commit and verifies git HEAD before the database step", () => {
      expect(production).toContain("name: Checkout the workflow event commit");
      expect(production).toMatch(
        /Checkout the workflow event commit[\s\S]*?ref: \$\{\{ github\.sha \}\}/,
      );
      expect(production).not.toContain("ref: ${{ inputs.expected_sha }}");
      expect(production).toContain("git rev-parse HEAD");

      const verifyIndex = production.indexOf(
        "Verify checked-out commit is the approved SHA",
      );
      const databaseIndex = production.indexOf(dbCommand);
      expect(verifyIndex).toBeGreaterThanOrEqual(0);
      expect(databaseIndex).toBeGreaterThan(verifyIndex);
    });

    it("includes the validated SHA in the success summary", () => {
      const summary = production.slice(
        production.indexOf("name: Report execution summary"),
      );
      expect(summary).toContain(
        "RABET_EXPECTED_SHA: ${{ inputs.expected_sha }}",
      );
      expect(summary).toContain("approved SHA");
      expect(summary).toContain("APPROVED_SHA");
    });

    it("accepts a matching 40-character SHA", () => {
      const result = runGuard(script, {
        ...validEnv,
        GITHUB_SHA: REVIEWED_SHA,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(REVIEWED_SHA);
    });

    it.each([
      ["a missing", undefined],
      ["a malformed", "not-a-40-character-hex-sha"],
      ["a short", REVIEWED_SHA.slice(0, 39)],
      ["a non-hex", "g".repeat(40)],
    ])("rejects %s expected_sha", (_label, expectedSha) => {
      const env = { ...validEnv, GITHUB_SHA: REVIEWED_SHA };
      if (expectedSha === undefined) {
        delete env.RABET_EXPECTED_SHA;
      } else {
        env.RABET_EXPECTED_SHA = expectedSha;
      }

      const result = runGuard(script, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("expected_sha");
      expect(result.stderr).toContain("40-character");
    });

    it("rejects an approved SHA that does not match the workflow event SHA", () => {
      const result = runGuard(script, {
        ...validEnv,
        RABET_EXPECTED_SHA: REVIEWED_SHA,
        GITHUB_SHA: OTHER_SHA,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("does not match");
      expect(result.stderr).not.toContain("PostgreSQL");
    });

    it("rejects a missing workflow event SHA", () => {
      const env = { ...validEnv };
      delete env.GITHUB_SHA;
      const result = runGuard(script, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("does not match");
    });
  },
);

describe("migration workflow applies the SHA guard to migrate mode too", () => {
  const migration = workflows[0];
  const workflow = readWorkflow(migration.file);
  const script = guardScript(workflow, migration.nextJob);

  it("accepts a matching SHA with the migrate confirmation", () => {
    const result = runGuard(script, {
      ...migration.validEnv,
      RABET_MODE: "migrate",
      RABET_CONFIRM: "MIGRATE_RABET_PROD",
      GITHUB_SHA: REVIEWED_SHA,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(REVIEWED_SHA);
  });

  it("rejects a missing SHA before accepting migrate mode", () => {
    const env = withoutExpectedSha({
      ...migration.validEnv,
      RABET_MODE: "migrate",
      RABET_CONFIRM: "MIGRATE_RABET_PROD",
      GITHUB_SHA: REVIEWED_SHA,
    });
    const result = runGuard(script, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("40-character");
  });
});
