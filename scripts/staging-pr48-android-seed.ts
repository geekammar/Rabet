import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { inArray } from "drizzle-orm";

import {
  appUser,
  category,
  language,
  product,
  productTranslation,
} from "@/db/schema";
import { createTransactionClient } from "@/db/transaction-client";
import { issueMerchantInvitation } from "@/lib/merchant-invitation/service";

const ANDROID_PASSWORD = "android-gate-a-password-123";

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
        email: `android-admin-${crypto.randomUUID()}@example.test`,
        platformRole: "super_admin",
      })
      .returning();

    async function issue(email: string, storeName: string, storeSlug: string) {
      return issueMerchantInvitation(db, {
        actorUserId: admin.id,
        storeName,
        storeSlug,
        invitedEmail: email,
      });
    }

    const a = await issue(
      "android.a@example.test",
      "متجر أندرويد أ",
      "android-store-a",
    );
    const b = await issue(
      "android.b@example.test",
      "متجر أندرويد ب",
      "android-store-b",
    );
    const empty = await issue(
      "android.empty@example.test",
      "متجر أندرويد فارغ",
      "android-store-empty",
    );

    await db
      .insert(language)
      .values([
        { code: "ar", label: "العربية", textDirection: "rtl", isEnabled: true },
        { code: "en", label: "English", textDirection: "ltr", isEnabled: true },
      ])
      .onConflictDoNothing();

    const languages = await db
      .select({ id: language.id, code: language.code })
      .from(language)
      .where(inArray(language.code, ["ar", "en"]));

    const arLanguageId = languages.find((entry) => entry.code === "ar")?.id;
    const enLanguageId = languages.find((entry) => entry.code === "en")?.id;

    if (!arLanguageId || !enLanguageId) {
      throw new Error("The seed languages were not created.");
    }

    async function seedCatalog(input: {
      storeId: string;
      storeKey: string;
      rootSortOrder: number;
      names: {
        oneAr: string;
        oneEn: string;
        twoAr: string;
        twoEn: string;
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

      await db.insert(productTranslation).values([
        {
          productId: productOne.id,
          languageId: arLanguageId,
          name: input.names.oneAr,
        },
        {
          productId: productOne.id,
          languageId: enLanguageId,
          name: input.names.oneEn,
        },
        {
          productId: productTwo.id,
          languageId: arLanguageId,
          name: input.names.twoAr,
        },
        {
          productId: productTwo.id,
          languageId: enLanguageId,
          name: input.names.twoEn,
        },
      ]);

      return {
        categoryId: storeCategory.id,
        one: { id: productOne.id, price: "10.00" },
        two: { id: productTwo.id, price: "20.00" },
      };
    }

    const catalogA = await seedCatalog({
      storeId: a.storeId,
      storeKey: "android-store-a",
      rootSortOrder: 100,
      names: {
        oneAr: "منتج أندرويد الأول",
        oneEn: "Android Product One",
        twoAr: "منتج أندرويد الثاني",
        twoEn: "Android Product Two",
      },
    });

    const catalogB = await seedCatalog({
      storeId: b.storeId,
      storeKey: "android-store-b",
      rootSortOrder: 101,
      names: {
        oneAr: "منتج أندرويد ب الأول",
        oneEn: "Android B Product One",
        twoAr: "منتج أندرويد ب الثاني",
        twoEn: "Android B Product Two",
      },
    });

    const output = {
      password: ANDROID_PASSWORD,
      a: {
        invitationId: a.invitationId,
        storeId: a.storeId,
        storeSlug: a.storeSlug,
        storeName: "متجر أندرويد أ",
        email: a.invitedEmail,
        token: a.token,
        products: catalogA,
      },
      b: {
        invitationId: b.invitationId,
        storeId: b.storeId,
        storeSlug: b.storeSlug,
        storeName: "متجر أندرويد ب",
        email: b.invitedEmail,
        token: b.token,
        products: catalogB,
      },
      empty: {
        invitationId: empty.invitationId,
        storeId: empty.storeId,
        storeSlug: empty.storeSlug,
        storeName: "متجر أندرويد فارغ",
        email: empty.invitedEmail,
        token: empty.token,
      },
    };

    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
      mode: 0o600,
    });

    process.stdout.write(
      "Android staging fixture seeded through the transactional invitation service.\n",
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Android staging seed failed: ${
      error instanceof Error ? error.message : "unknown error"
    }\n`,
  );
  process.exit(1);
});
