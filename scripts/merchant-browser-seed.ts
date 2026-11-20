import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { eq, inArray, sql } from "drizzle-orm";

import {
  appUser,
  category,
  language,
  merchantInvitation,
  product,
  productTranslation,
} from "@/db/schema";
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
    const empty = await issue(
      "merchant.empty@example.test",
      "متجر البداية",
      "browser-store-empty",
    );

    await db
      .insert(language)
      .values([
        {
          code: "ar",
          label: "العربية",
          textDirection: "rtl",
          isEnabled: true,
        },
        {
          code: "en",
          label: "English",
          textDirection: "ltr",
          isEnabled: true,
        },
      ])
      .onConflictDoNothing();

    const languages = await db
      .select({ id: language.id, code: language.code })
      .from(language)
      .where(inArray(language.code, ["ar", "en"]));

    const arabicLanguageId = languages.find(
      (entry) => entry.code === "ar",
    )?.id;
    const englishLanguageId = languages.find(
      (entry) => entry.code === "en",
    )?.id;

    if (!arabicLanguageId || !englishLanguageId) {
      throw new Error("The seed languages were not created.");
    }

    const arLanguageId = arabicLanguageId;
    const enLanguageId = englishLanguageId;

    async function seedCatalog(input: {
      storeId: string;
      storeKey: string;
      rootSortOrder: number;
      productNames: {
        one: { ar: string; en: string };
        two: { en: string };
      };
    }) {
      const [storeCategory] = await db
        .insert(category)
        .values({
          storeId: input.storeId,
          slug: `${input.storeKey}-category`,
          sortOrder: input.rootSortOrder,
          isActive: true,
        })
        .returning({ id: category.id });

      const [productOne] = await db
        .insert(product)
        .values({
          storeId: input.storeId,
          categoryId: storeCategory.id,
          slug: `${input.storeKey}-product-one`,
          price: "10.00",
          isActive: true,
          sortOrder: 10,
        })
        .returning({ id: product.id });

      const [productTwo] = await db
        .insert(product)
        .values({
          storeId: input.storeId,
          categoryId: storeCategory.id,
          slug: `${input.storeKey}-product-two`,
          price: "20.00",
          isActive: true,
          sortOrder: 20,
        })
        .returning({ id: product.id });

      const [productFallback] = await db
        .insert(product)
        .values({
          storeId: input.storeId,
          categoryId: storeCategory.id,
          slug: `${input.storeKey}-product-fallback`,
          price: "30.00",
          isActive: true,
          sortOrder: 30,
        })
        .returning({ id: product.id });

      await db.insert(productTranslation).values([
        {
          productId: productOne.id,
          languageId: arLanguageId,
          name: input.productNames.one.ar,
        },
        {
          productId: productOne.id,
          languageId: enLanguageId,
          name: input.productNames.one.en,
        },
        {
          productId: productTwo.id,
          languageId: enLanguageId,
          name: input.productNames.two.en,
        },
      ]);

      return {
        categoryId: storeCategory.id,
        one: { id: productOne.id, price: "10.00" },
        two: { id: productTwo.id, price: "20.00" },
        fallback: {
          id: productFallback.id,
          price: "30.00",
          slug: `${input.storeKey}-product-fallback`,
        },
      };
    }

    const catalogA = await seedCatalog({
      storeId: a.storeId,
      storeKey: "browser-store-a",
      rootSortOrder: 0,
      productNames: {
        one: {
          ar: "منتج النور الأول",
          en: "Al Noor Product One",
        },
        two: { en: "Al Noor Product Two" },
      },
    });
    const catalogB = await seedCatalog({
      storeId: b.storeId,
      storeKey: "browser-store-b",
      rootSortOrder: 1,
      productNames: {
        one: {
          ar: "منتج القمر الأول",
          en: "Al Qamar Product One",
        },
        two: { en: "Al Qamar Product Two" },
      },
    });

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

    const throttle = await issue(
      "throttle.fixture@example.test",
      "متجر حد المحاولات",
      "browser-store-throttle",
    );

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
        products: catalogA,
      },
      b: {
        invitationId: b.invitationId,
        storeId: b.storeId,
        storeSlug: b.storeSlug,
        storeName: "متجر القمر",
        email: b.invitedEmail,
        token: b.token,
        products: catalogB,
      },
      empty: {
        invitationId: empty.invitationId,
        storeId: empty.storeId,
        storeSlug: empty.storeSlug,
        storeName: "متجر البداية",
        email: empty.invitedEmail,
        token: empty.token,
      },
      throttle: {
        invitationId: throttle.invitationId,
        email: throttle.invitedEmail,
        token: throttle.token,
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
