import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { inArray, isNull, sql } from "drizzle-orm";

import {
  appUser,
  category,
  language,
  product,
  productTranslation,
} from "@/db/schema";
import { createTransactionClient } from "@/db/transaction-client";
import { issueMerchantInvitation } from "@/lib/merchant-invitation/service";

const DESKTOP_PASSWORD = "desktop-qa-password-123";

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
        email: `desktop-admin-${crypto.randomUUID()}@example.test`,
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
      "desktop.a@example.test",
      "متجر سطح المكتب أ",
      "desktop-store-a",
    );
    const b = await issue(
      "desktop.b@example.test",
      "متجر سطح المكتب ب",
      "desktop-store-b",
    );
    const empty = await issue(
      "desktop.empty@example.test",
      "متجر سطح المكتب فارغ",
      "desktop-store-empty",
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

    const [rootOrder] = await db
      .select({
        next: sql<number>`coalesce(max(${category.sortOrder}), 0) + 1`,
      })
      .from(category)
      .where(isNull(category.parentId));

    const firstRootOrder = Number(rootOrder?.next ?? 1);

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
      storeKey: "desktop-store-a",
      rootSortOrder: firstRootOrder,
      names: {
        oneAr: "منتج سطح المكتب الأول",
        oneEn: "Desktop Product One",
        twoAr: "منتج سطح المكتب الثاني",
        twoEn: "Desktop Product Two",
      },
    });

    const catalogB = await seedCatalog({
      storeId: b.storeId,
      storeKey: "desktop-store-b",
      rootSortOrder: firstRootOrder + 1,
      names: {
        oneAr: "منتج سطح المكتب ب الأول",
        oneEn: "Desktop B Product One",
        twoAr: "منتج سطح المكتب ب الثاني",
        twoEn: "Desktop B Product Two",
      },
    });

    const output = {
      password: DESKTOP_PASSWORD,
      a: {
        invitationId: a.invitationId,
        storeId: a.storeId,
        storeSlug: a.storeSlug,
        storeName: "متجر سطح المكتب أ",
        email: a.invitedEmail,
        expiresAt: a.expiresAt,
        token: a.token,
        products: catalogA,
      },
      b: {
        invitationId: b.invitationId,
        storeId: b.storeId,
        storeSlug: b.storeSlug,
        storeName: "متجر سطح المكتب ب",
        email: b.invitedEmail,
        expiresAt: b.expiresAt,
        token: b.token,
        products: catalogB,
      },
      empty: {
        invitationId: empty.invitationId,
        storeId: empty.storeId,
        storeSlug: empty.storeSlug,
        storeName: "متجر سطح المكتب فارغ",
        email: empty.invitedEmail,
        expiresAt: empty.expiresAt,
        token: empty.token,
      },
    };

    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
      mode: 0o600,
    });

    process.stdout.write(
      "Desktop QA staging fixture seeded through the transactional invitation service.\n",
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Desktop QA staging seed failed: ${
      error instanceof Error ? error.message : "unknown error"
    }\n`,
  );
  process.exit(1);
});
