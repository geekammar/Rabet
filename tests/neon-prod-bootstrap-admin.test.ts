import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_CONFIRM_ENV,
  ADMIN_EMAIL_ENV,
  ADMIN_HASH_ENV,
  BOOTSTRAP_CONFIRMATION,
  validateBootstrapInput,
} from "../scripts/neon-prod-bootstrap-admin.mjs";

const PROD_URL =
  "postgresql://prod_owner:never-print-this@ep-prod-123456789.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PROD_HOST = "ep-prod-123456789.us-east-2.aws.neon.tech";
const VALID_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHlzYWx0eXNhbHQ$aGFzaHZhbHVlaGFzaHZhbHVl";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_ACTIONS: "false",
    NEON_PROD_DATABASE_URL: PROD_URL,
    NEON_PROD_EXPECTED_HOST: PROD_HOST,
    NEON_PROD_EXPECTED_DB_NAME: "neondb",
    [ADMIN_EMAIL_ENV]: "owner@example.test",
    [ADMIN_HASH_ENV]: VALID_HASH,
    [ADMIN_CONFIRM_ENV]: BOOTSTRAP_CONFIRMATION,
    ...overrides,
  };
}

describe("production platform admin bootstrap input", () => {
  it("accepts the exact confirmation, approved target and Argon2id hash", () => {
    const result = validateBootstrapInput(baseEnv(), {
      requireGithubContext: false,
      allowTestTarget: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.email).toBe("owner@example.test");
      expect(result.databaseName).toBe("neondb");
      expect(result.passwordHash).toBe(VALID_HASH);
    }
  });

  it("requires manual main-branch GitHub context", () => {
    const wrongEvent = validateBootstrapInput(
      baseEnv({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
      }),
      { requireGithubContext: true, allowTestTarget: false },
    );
    expect(wrongEvent.ok).toBe(false);

    const wrongRef = validateBootstrapInput(
      baseEnv({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/feature",
      }),
      { requireGithubContext: true, allowTestTarget: false },
    );
    expect(wrongRef.ok).toBe(false);

    const valid = validateBootstrapInput(
      baseEnv({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
      }),
      { requireGithubContext: true, allowTestTarget: false },
    );
    expect(valid.ok).toBe(true);
  });

  it("rejects a wrong confirmation, invalid email and missing/invalid hash without echoing it", () => {
    const wrongConfirm = validateBootstrapInput(
      baseEnv({ [ADMIN_CONFIRM_ENV]: "provision" }),
      { requireGithubContext: false, allowTestTarget: false },
    );
    expect(wrongConfirm.ok).toBe(false);

    const invalidEmail = validateBootstrapInput(
      baseEnv({ [ADMIN_EMAIL_ENV]: "not-an-email" }),
      { requireGithubContext: false, allowTestTarget: false },
    );
    expect(invalidEmail.ok).toBe(false);

    const invalidHash = validateBootstrapInput(
      baseEnv({ [ADMIN_HASH_ENV]: "plaintext-not-allowed" }),
      { requireGithubContext: false, allowTestTarget: false },
    );
    expect(invalidHash.ok).toBe(false);
    if (!invalidHash.ok) {
      expect(invalidHash.problems.join(" ")).not.toContain(
        "plaintext-not-allowed",
      );
    }
  });

  it("rejects a wrong Production host or database before connecting", () => {
    const wrongHost = validateBootstrapInput(
      baseEnv({ NEON_PROD_EXPECTED_HOST: "ep-other-123.us-east-2.aws.neon.tech" }),
      { requireGithubContext: false, allowTestTarget: false },
    );
    expect(wrongHost.ok).toBe(false);

    const wrongDb = validateBootstrapInput(
      baseEnv({ NEON_PROD_EXPECTED_DB_NAME: "other_database" }),
      { requireGithubContext: false, allowTestTarget: false },
    );
    expect(wrongDb.ok).toBe(false);
  });
});

describe("production platform admin bootstrap workflow", () => {
  const workflow = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../.github/workflows/neon-prod-bootstrap-admin.yml",
    ),
    "utf8",
  );

  it("is manual main-only and uses the Production environment", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s{2}(push|pull_request):/m);
    expect(workflow).toContain("environment: Production");
    expect(workflow).toContain("PROVISION_RABET_SUPER_ADMIN");
  });

  it("never accepts the hash as a workflow input", () => {
    const inputsBlock = workflow.split("jobs:")[0].split("inputs:")[1] ?? "";

    expect(inputsBlock).toContain("admin_email");
    expect(inputsBlock).toContain("confirm");
    expect(inputsBlock).not.toMatch(/password|hash/i);
  });

  it("reads the hash only from the Production secret", () => {
    expect(workflow).toContain(
      "RABET_PLATFORM_ADMIN_PASSWORD_HASH: ${{ secrets.RABET_PLATFORM_ADMIN_PASSWORD_HASH }}",
    );
    expect(workflow).not.toContain("inputs.password");
    expect(workflow).not.toContain("inputs.hash");
  });
});
