import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import { appUser, merchantCredential } from "@/db/schema";
import { createTransactionClient } from "@/db/transaction-client";

/**
 * Staging-only provisioning for the named platform Super Admin test account.
 *
 * This script refuses any target other than the approved isolated Staging
 * database/role on the pinned direct endpoint. It only receives the Argon2id
 * password hash, never the password, and writes a sanitized summary with no
 * credential material.
 */

const EXPECTED_HOST = "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";
const EXPECTED_DATABASE = "rabet_staging_pr48";
const EXPECTED_USER = "rabet_staging";

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) throw new Error(`${name} is required.`);

  return value;
}

async function main() {
  const databaseUrl = required("SEED_DATABASE_URL");
  const email = required("PLATFORM_ADMIN_EMAIL").toLowerCase();
  const passwordHash = required("PLATFORM_ADMIN_PASSWORD_HASH");
  const outputPath = required("SEED_OUTPUT");

  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new Error("PLATFORM_ADMIN_EMAIL must be a valid email address.");
  }
  if (!passwordHash.startsWith("$argon2id$")) {
    throw new Error("PLATFORM_ADMIN_PASSWORD_HASH must be an Argon2id PHC string.");
  }

  const parsed = new URL(databaseUrl);

  if (
    parsed.hostname.toLowerCase() !== EXPECTED_HOST ||
    parsed.pathname !== `/${EXPECTED_DATABASE}` ||
    parsed.username !== EXPECTED_USER
  ) {
    throw new Error(
      "Refusing to seed: the target is not the approved Staging database.",
    );
  }

  const client = createTransactionClient(databaseUrl);

  try {
    const result = await client.db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: appUser.id,
          platformRole: appUser.platformRole,
          sessionVersion: appUser.sessionVersion,
        })
        .from(appUser)
        .where(sql`lower(${appUser.email}) = ${email}`)
        .limit(1);

      let userId: string;
      let sessionVersion: number;

      if (existing.length === 0) {
        const [created] = await tx
          .insert(appUser)
          .values({
            email,
            status: "active",
            platformRole: "super_admin",
          })
          .returning({
            id: appUser.id,
            sessionVersion: appUser.sessionVersion,
          });

        userId = created.id;
        sessionVersion = created.sessionVersion;
      } else {
        const identity = existing[0];

        if (identity.platformRole !== "super_admin") {
          throw new Error(
            "Refusing to elevate an existing non-Super-Admin account.",
          );
        }

        const [updated] = await tx
          .update(appUser)
          .set({
            status: "active",
            sessionVersion: identity.sessionVersion + 1,
          })
          .where(sql`${appUser.id} = ${identity.id}`)
          .returning({
            id: appUser.id,
            sessionVersion: appUser.sessionVersion,
          });

        userId = updated.id;
        sessionVersion = updated.sessionVersion;
      }

      const credential = await tx
        .select({ id: merchantCredential.id })
        .from(merchantCredential)
        .where(sql`${merchantCredential.userId} = ${userId}`)
        .limit(1);

      if (credential.length === 0) {
        await tx.insert(merchantCredential).values({
          userId,
          passwordHash,
        });
      } else {
        await tx
          .update(merchantCredential)
          .set({ passwordHash })
          .where(sql`${merchantCredential.userId} = ${userId}`);
      }

      return { userId, sessionVersion };
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });

    const summary = {
      email,
      userId: result.userId,
      platformRole: "super_admin",
      status: "active",
      sessionVersion: result.sessionVersion,
      provisionedAt: new Date().toISOString(),
      target: {
        database: EXPECTED_DATABASE,
        user: EXPECTED_USER,
      },
    };

    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    });

    process.stdout.write(
      `[p1-staging-seed] provisioned ${email} (${result.userId})\n`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? error)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://<redacted>")
    .replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>");

  process.stderr.write(`[p1-staging-seed:FAIL] ${message}\n`);
  process.exitCode = 1;
});
