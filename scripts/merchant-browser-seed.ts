import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { appUser, merchantInvitation } from "@/db/schema";
import { createTransactionClient } from "@/db/transaction-client";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
  revokeMerchantInvitation,
} from "@/lib/merchant-invitation/service";

/**
 * Seeds the disposable browser fixture through the merged invitation service.
 *
 * No production issuance UI, test bypass or direct invitation INSERT is used:
 * stores, invitations and accounts are created by the same transactional
 * service the application calls. Only the expiration fixture is mutated with
 * SQL because the service intentionally has no "make this expired" API.
 *
 * Tokens are secrets: they are written only to the 0600 output file named by
 * SEED_OUTPUT and are never printed.
 */

const MERCHANT_PASSWORD = "browser-merchant-password-123";
const USED_PASSWORD = "browser-used-password-123";

async function main() {
  const databaseUrl = process.env.SEED_DATABASE_URL;
  const outputPath = process.env.SEED_OUTPUT;

  if (!databaseUrl || !outputPath) {
    throw new Error("SEED_DATABASE_URL and SEED_OUTPUT are required.");
  }

  mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });

  const client = createTransactionClient(databaseUrl);
  const db = client.db;

  try {
    const [admin] = await db
      .insert(appUser)
      .values({
        email: `browser-admin-${crypto.randomUUID()}@example.test`,
        platformRole: "super_admin",
      })
      .returning();

    async function issue(
      email: string,
      storeName: string,
      storeSlug: string,
    ) {
      return issueMerchantInvitation(db, {
        actorUserId: admin.id,
        storeName,
        storeSlug,
        invitedEmail: email,
      });
    }

    const a = await issue(
      "merchant.a@example.test",
      "متجر النور",
      "browser-store-a",
    );
    const b = await issue(
      "merchant.b@example.test",
      "متجر القمر",
      "browser-store-b",
    );

    const expired = await issue(
      "expired.fixture@example.test",
      "متجر منتهي",
      "browser-store-expired",
    );
    await db.execute(sql`
      update merchant_invitation
      set created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 hour'
      where id = ${expired.invitationId}
    `);

    const revoked = await issue(
      "revoked.fixture@example.test",
      "متجر ملغي",
      "browser-store-revoked",
    );
    await revokeMerchantInvitation(db, {
      actorUserId: admin.id,
      invitationId: revoked.invitationId,
    });

    const used = await issue(
      "used.fixture@example.test",
      "متجر مستخدم",
      "browser-store-used",
    );
    const usedAccount = await acceptMerchantInvitation(db, {
      token: used.token,
      password: USED_PASSWORD,
    });

    const [usedInvitation] = await db
      .select({ acceptedAt: merchantInvitation.acceptedAt })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, used.invitationId));

    const output = {
      adminUserId: admin.id,
      password: MERCHANT_PASSWORD,
      a: {
        invitationId: a.invitationId,
        storeId: a.storeId,
        storeSlug: a.storeSlug,
        storeName: "متجر النور",
        email: a.invitedEmail,
        token: a.token,
      },
      b: {
        invitationId: b.invitationId,
        storeId: b.storeId,
        storeSlug: b.storeSlug,
        storeName: "متجر القمر",
        email: b.invitedEmail,
        token: b.token,
      },
      expired: {
        invitationId: expired.invitationId,
        email: expired.invitedEmail,
        token: expired.token,
      },
      revoked: {
        invitationId: revoked.invitationId,
        email: revoked.invitedEmail,
        token: revoked.token,
      },
      used: {
        invitationId: used.invitationId,
        userId: usedAccount.userId,
        email: used.invitedEmail,
        token: used.token,
        password: USED_PASSWORD,
        acceptedAt: usedInvitation?.acceptedAt ?? null,
      },
    };

    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
      mode: 0o600,
    });

    process.stdout.write(
      "Merchant browser fixture seeded through the transactional invitation service.\n",
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Merchant browser seed failed: ${
      error instanceof Error ? error.message : "unknown error"
    }\n`,
  );
  process.exit(1);
});
