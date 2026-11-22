#!/usr/bin/env node
/**
 * scripts/neon-prod-bootstrap-admin.mjs — manual Production bootstrap for the
 * named platform Super Admin.
 *
 * This is a one-account provisioning path, not a general user-management tool.
 * It runs only from a manual GitHub Actions workflow on `main` with the
 * Production environment, reuses the production target-identity guards, and
 * consumes only an Argon2id PHC hash from the Production environment secret
 * `RABET_PLATFORM_ADMIN_PASSWORD_HASH`. The plaintext password and the hash are
 * never accepted as workflow inputs and never printed.
 *
 * Behavior:
 * - Verifies workflow_dispatch + refs/heads/main when run in GitHub Actions.
 * - Validates the exact approved Production host/database before connecting.
 * - Creates `app_user` + `merchant_credential` in one transaction.
 * - Safe retry: the same existing active Super Admin with the same credential
 *   hash is a no-op success.
 * - Refuses to promote a merchant, reactivate a disabled account, or overwrite
 *   an existing different credential.
 * - Any failure rolls the whole transaction back.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";

import postgres from "postgres";
import { parseOptions } from "@node-rs/argon2";

import {
  EXPECTED_DB_NAME_ENV,
  EXPECTED_HOST_ENV,
  PROD_URL_ENV,
  redact,
  validateGithubContext,
  validateProdUrl,
} from "./neon-prod-actions.mjs";

export const BOOTSTRAP_CONFIRMATION = "PROVISION_RABET_SUPER_ADMIN";
export const ADMIN_EMAIL_ENV = "RABET_PLATFORM_ADMIN_EMAIL";
export const ADMIN_HASH_ENV = "RABET_PLATFORM_ADMIN_PASSWORD_HASH";
export const ADMIN_CONFIRM_ENV = "RABET_PLATFORM_ADMIN_CONFIRM";

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The documented generator's exact Argon2id policy.
 *
 * `@node-rs/argon2`'s parser validates the PHC encoding/decoding and reports
 * the decoded sizes; the structural check keeps the accepted text canonical
 * (standard unpadded base64, 16-byte salt, 32-byte digest).
 */
const ARGON2ID_ALGORITHM = 2; // Algorithm.Argon2id
const ARGON2_VERSION_V19 = 1; // Version.V0x13
const ARGON2_MEMORY_COST = 19456;
const ARGON2_TIME_COST = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_SALT_BYTES = 16;
const ARGON2_OUTPUT_BYTES = 32;
const ARGON2_PHC_SHAPE =
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

export class PlatformAdminBootstrapError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "PlatformAdminBootstrapError";
    this.code = code;
  }
}

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(email)
  ) {
    return null;
  }
  return email;
}

function readHash(raw) {
  if (typeof raw !== "string") return null;
  const hash = raw.trim();
  if (hash.length < 20 || hash.length > 1024) return null;
  if (!ARGON2_PHC_SHAPE.test(hash)) return null;

  try {
    const parsed = parseOptions(hash);
    if (
      parsed.algorithm !== ARGON2ID_ALGORITHM ||
      parsed.version !== ARGON2_VERSION_V19 ||
      parsed.memoryCost !== ARGON2_MEMORY_COST ||
      parsed.timeCost !== ARGON2_TIME_COST ||
      parsed.parallelism !== ARGON2_PARALLELISM ||
      parsed.saltLen !== ARGON2_SALT_BYTES ||
      parsed.outputLen !== ARGON2_OUTPUT_BYTES
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return hash;
}

/**
 * Validates all bootstrap inputs before any network connection.
 *
 * Exported for unit tests. Returns `{ ok: false, problems }` without echoing
 * any credential material.
 */
export function validateBootstrapInput(env, options = {}) {
  const requireGithubContext = options.requireGithubContext ?? true;
  const allowTestTarget = options.allowTestTarget ?? false;
  const problems = [];

  const github = validateGithubContext(env, {
    requireGithub: requireGithubContext,
  });
  if (!github.ok) problems.push(...github.problems);

  const confirm = typeof env[ADMIN_CONFIRM_ENV] === "string"
    ? env[ADMIN_CONFIRM_ENV]
    : "";
  if (confirm !== BOOTSTRAP_CONFIRMATION) {
    problems.push(
      `The confirmation input (${ADMIN_CONFIRM_ENV}) must equal ` +
        `"${BOOTSTRAP_CONFIRMATION}" exactly.`,
    );
  }

  const email = normalizeEmail(env[ADMIN_EMAIL_ENV]);
  if (email === null) {
    problems.push(
      `${ADMIN_EMAIL_ENV} must be a valid email address of at most ` +
        `${EMAIL_MAX_LENGTH} characters.`,
    );
  }

  const passwordHash = readHash(env[ADMIN_HASH_ENV]);
  if (passwordHash === null) {
    problems.push(
      `${ADMIN_HASH_ENV} must be a valid Argon2id PHC hash supplied by the ` +
        "Production environment secret. It is never accepted as a workflow input.",
    );
  }

  const target = validateProdUrl(env[PROD_URL_ENV], {
    expectedHost: env[EXPECTED_HOST_ENV],
    expectedDbName: env[EXPECTED_DB_NAME_ENV],
    allowTestTarget,
  });
  if (!target.ok) problems.push(...target.problems);

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    email,
    passwordHash,
    url: target.url,
    target: target.target,
    databaseName: String(env[EXPECTED_DB_NAME_ENV]).trim(),
  };
}

/** Creates the bounded postgres-js client used by the bootstrap transaction. */
export function createBootstrapClient(url) {
  return postgres(url, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    connection: {
      statement_timeout: 30_000,
    },
  });
}

function collision(code, message) {
  return new PlatformAdminBootstrapError(code, message);
}

/**
 * Creates or safely retries the named platform Super Admin.
 *
 * `connect` and the GitHub/test options are injectable so the disposable
 * PostgreSQL tests can exercise the real transaction without touching
 * Production.
 */
export async function bootstrapPlatformAdmin({
  env,
  io,
  connect = createBootstrapClient,
  requireGithubContext = true,
  allowTestTarget = false,
}) {
  const validated = validateBootstrapInput(env, {
    requireGithubContext,
    allowTestTarget,
  });

  if (!validated.ok) {
    throw new PlatformAdminBootstrapError(
      "INVALID_INPUT",
      validated.problems.join(" "),
    );
  }

  io?.line?.("rabet platform-admin-bootstrap — mode: bootstrap");
  io?.note?.(`Target      ${validated.target.host}/${validated.target.dbname}`);
  io?.note?.("Confirmation accepted. No password or hash will be logged.");

  const sql = connect(validated.url);

  try {
    const meta = await sql`
      select current_database() as database, current_user as role
    `;
    const live = meta[0];

    if (!live || live.database !== validated.databaseName) {
      throw new PlatformAdminBootstrapError(
        "TARGET_MISMATCH",
        "The live database identity does not match the approved Production " +
          "database. Refusing to write.",
      );
    }

    const result = await sql.begin(async (tx) => {
      await tx`
        select pg_advisory_xact_lock(
          hashtextextended(${`platform-admin-bootstrap:${validated.email}`}, 0)
        )
      `;

      const existing = await tx`
        select id, email, status, platform_role, session_version
        from app_user
        where lower(email) = ${validated.email}
        limit 1
        for update
      `;

      if (existing.length === 0) {
        const [created] = await tx`
          insert into app_user (email, status, platform_role)
          values (${validated.email}, 'active', 'super_admin')
          returning id, email, session_version
        `;

        await tx`
          insert into merchant_credential (user_id, password_hash)
          values (${created.id}, ${validated.passwordHash})
        `;

        return {
          outcome: "created",
          userId: created.id,
          email: created.email,
          sessionVersion: created.session_version,
        };
      }

      const account = existing[0];

      if (account.platform_role !== "super_admin") {
        throw collision(
          "ROLE_COLLISION",
          "An account with this email already exists with a non-Super-Admin " +
            "platform role. Refusing to promote or overwrite it.",
        );
      }

      if (account.status !== "active") {
        throw collision(
          "STATUS_COLLISION",
          "An existing Super Admin account is not active. Refusing to " +
            "reactivate or overwrite it.",
        );
      }

      const credentials = await tx`
        select password_hash
        from merchant_credential
        where user_id = ${account.id}
        limit 1
      `;

      if (credentials.length === 0) {
        await tx`
          insert into merchant_credential (user_id, password_hash)
          values (${account.id}, ${validated.passwordHash})
        `;

        return {
          outcome: "credential_added",
          userId: account.id,
          email: account.email,
          sessionVersion: account.session_version,
        };
      }

      if (credentials[0].password_hash !== validated.passwordHash) {
        throw collision(
          "CREDENTIAL_COLLISION",
          "An existing Super Admin credential differs from the supplied hash. " +
            "Refusing to overwrite it.",
        );
      }

      return {
        outcome: "already_provisioned",
        userId: account.id,
        email: account.email,
        sessionVersion: account.session_version,
      };
    });

    const message =
      result.outcome === "created"
        ? "Created the named platform Super Admin."
        : result.outcome === "credential_added"
          ? "Added the credential to the existing Super Admin account."
          : "The named platform Super Admin is already provisioned with this credential.";

    io?.line?.(`${message} User ${result.userId}.`);

    return {
      ...result,
      platformRole: "super_admin",
    };
  } catch (error) {
    if (error instanceof PlatformAdminBootstrapError) throw error;

    throw new PlatformAdminBootstrapError(
      "OPERATION_FAILED",
      "The platform Super Admin bootstrap failed and the transaction was rolled back.",
      { cause: error },
    );
  } finally {
    await sql.end?.({ timeout: 5 }).catch(() => {});
  }
}

const HELP = [
  "rabet platform-admin-bootstrap — manual Production owner bootstrap",
  "",
  "Required environment (Production GitHub Environment):",
  `  ${PROD_URL_ENV}        Direct unpooled connection string (secret)`,
  `  ${EXPECTED_HOST_ENV}       Expected direct hostname (non-secret variable)`,
  `  ${EXPECTED_DB_NAME_ENV}    Expected database name (non-secret variable)`,
  `  ${ADMIN_EMAIL_ENV}   Named Super Admin email (workflow input)`,
  `  ${ADMIN_HASH_ENV} Argon2id PHC hash (Production secret)`,
  `  ${ADMIN_CONFIRM_ENV} Must equal ${BOOTSTRAP_CONFIRMATION}`,
  "",
  "The hash is never accepted as a workflow input and is never printed.",
  "Staging seed scripts must never be used against Production.",
].join("\n");

export async function runCli() {
  const env = process.env;

  if (env.RABET_BOOTSTRAP_HELP === "1") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  const io = {
    line: (text = "") => process.stdout.write(`${redact(String(text))}\n`),
    note: (text = "") => process.stdout.write(`  ${redact(String(text))}\n`),
  };

  try {
    const result = await bootstrapPlatformAdmin({
      env,
      io,
      requireGithubContext: true,
      allowTestTarget: false,
    });

    process.stdout.write(
      `Bootstrap complete: ${result.outcome} (${result.userId}).\n`,
    );
    process.exit(0);
  } catch (error) {
    const message = redact(String(error?.message ?? error));
    process.stderr.write(`FAIL ${message}\n`);
    process.exit(1);
  }
}

const isCli = import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;

if (isCli) {
  runCli().catch((error) => {
    process.stderr.write(
      `FAIL ${redact(String(error?.message ?? error))}\n`,
    );
    process.exit(1);
  });
}
