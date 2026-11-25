import crypto from "node:crypto";
import fs from "node:fs";

import { sql } from "drizzle-orm";

import { createTransactionClient } from "../src/db/transaction-client";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "../src/lib/merchant-invitation/service";
import { suggestedBotUsername } from "../src/lib/telegram/manager-config";

const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const SERVICE_ID = "srv-dc3jiiff3r2c738okfsg";
const SUMMARY_PATH = process.env.SUMMARY_OUT ?? "/tmp/pr59-fresh-stores-summary.json";
const CREDENTIALS_PATH = process.env.CREDENTIALS_OUT ?? "/tmp/pr59-fresh-stores-credentials.json";
const SUFFIX = crypto.randomBytes(3).toString("hex");

type StoreSpec = {
  key: "a" | "b";
  name: string;
  slug: string;
  email: string;
  locale: "ar" | "en";
  product: {
    slug: string;
    nameEn: string;
    nameAr?: string;
    price: string;
    quantity: number;
    subtotal: string;
    deliveryFee: string;
    total: string;
  };
  fallback?: {
    slug: string;
    nameEn: string;
    price: string;
    quantity: number;
    subtotal: string;
    deliveryFee: string;
    total: string;
  };
};

const STORES: StoreSpec[] = [
  {
    key: "a",
    name: "PR59 QA Arabic Store",
    slug: `pr59-qa-ar-${SUFFIX}`,
    email: `pr59.qa.ar.${SUFFIX}@example.test`,
    locale: "ar",
    product: {
      slug: `pr59-qa-ar-product-${SUFFIX}`,
      nameEn: "PR59 Arabic Store Product",
      nameAr: "منتج المتجر العربي",
      price: "12.00",
      quantity: 2,
      subtotal: "24.00",
      deliveryFee: "7.00",
      total: "31.00",
    },
    fallback: {
      slug: `pr59-qa-ar-fallback-${SUFFIX}`,
      nameEn: "PR59 Arabic Store English Only",
      price: "5.00",
      quantity: 1,
      subtotal: "5.00",
      deliveryFee: "7.00",
      total: "12.00",
    },
  },
  {
    key: "b",
    name: "PR59 QA English Store",
    slug: `pr59-qa-en-${SUFFIX}`,
    email: `pr59.qa.en.${SUFFIX}@example.test`,
    locale: "en",
    product: {
      slug: `pr59-qa-en-product-${SUFFIX}`,
      nameEn: "PR59 English Store Product",
      price: "15.00",
      quantity: 1,
      subtotal: "15.00",
      deliveryFee: "9.00",
      total: "24.00",
    },
  },
];

async function readDatabaseUrl(): Promise<string> {
  const response = await fetch(
    `https://api.render.com/v1/services/${SERVICE_ID}/env-vars?limit=100`,
    {
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Render env read failed HTTP ${response.status}`);
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload) ? payload : payload?.envVars ?? [];
  for (const entry of rows) {
    const row = entry?.envVar ?? entry;
    if (row?.key === "DATABASE_URL" && typeof row.value === "string") return row.value;
  }
  throw new Error("PR59 service DATABASE_URL is missing");
}

async function ensureCategory(
  db: ReturnType<typeof createTransactionClient>["db"],
  storeId: string,
  slug: string,
) {
  const result = await db.execute<{ id: string }>(sql`
    select id from category
    where store_id = ${storeId} and parent_id is null and deleted_at is null
    order by is_active desc, sort_order, id
    limit 1
  `);
  if (result[0]) return result[0].id;
  const max = await db.execute<{ next: number }>(sql`
    select coalesce(max(sort_order), 0) + 1 as next
    from category where store_id = ${storeId} and parent_id is null
  `);
  const created = await db.execute<{ id: string }>(sql`
    insert into category (store_id, slug, sort_order, is_active)
    values (${storeId}, ${slug}, ${max[0]?.next ?? 1}, true)
    returning id
  `);
  return created[0].id;
}

async function ensureProduct(
  db: ReturnType<typeof createTransactionClient>["db"],
  input: {
    storeId: string;
    categoryId: string;
    slug: string;
    price: string;
    nameEn: string;
    nameAr?: string;
    languageIds: { en: string; ar: string | null };
  },
) {
  const existing = await db.execute<{ id: string }>(sql`
    select id from product
    where store_id = ${input.storeId} and slug = ${input.slug}
    limit 1
  `);
  let productId = existing[0]?.id;
  if (productId) {
    await db.execute(sql`
      update product
      set category_id = ${input.categoryId}, price = ${input.price},
        is_active = true, deleted_at = null, updated_at = now()
      where id = ${productId}
    `);
  } else {
    const max = await db.execute<{ next: number }>(sql`
      select coalesce(max(sort_order), 0) + 1 as next
      from product where store_id = ${input.storeId}
    `);
    const created = await db.execute<{ id: string }>(sql`
      insert into product (
        store_id, category_id, slug, price, is_active, sort_order
      ) values (
        ${input.storeId}, ${input.categoryId}, ${input.slug}, ${input.price},
        true, ${max[0]?.next ?? 1}
      ) returning id
    `);
    productId = created[0].id;
  }
  await db.execute(sql`
    insert into product_inventory (product_id, store_id, on_hand, reserved)
    values (${productId}, ${input.storeId}, 20, 0)
    on conflict (product_id)
    do update set on_hand = 20, reserved = 0, updated_at = now()
  `);
  await db.execute(sql`
    insert into product_translation (product_id, language_id, name, description)
    values (
      ${productId}, ${input.languageIds.en}, ${input.nameEn},
      'PR59 buyer-language QA fixture'
    )
    on conflict (product_id, language_id)
    do update set name = excluded.name, description = excluded.description,
      updated_at = now()
  `);
  if (input.nameAr && input.languageIds.ar) {
    await db.execute(sql`
      insert into product_translation (product_id, language_id, name, description)
      values (
        ${productId}, ${input.languageIds.ar}, ${input.nameAr},
        'منتج اختبار لغة المشتري'
      )
      on conflict (product_id, language_id)
      do update set name = excluded.name, description = excluded.description,
        updated_at = now()
    `);
  }
  return productId;
}

async function main() {
  if (!RENDER_API_KEY) throw new Error("RENDER_API_KEY is missing");
  const databaseUrl = await readDatabaseUrl();
  const client = createTransactionClient(databaseUrl);
  const db = client.db;
  const summary: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    serviceId: SERVICE_ID,
    stores: [],
    credentialsFile: CREDENTIALS_PATH,
  };
  const credentials: Array<{ storeSlug: string; email: string; password: string }> = [];

  try {
    const admins = await db.execute<{ id: string; email: string }>(sql`
      select id, email from app_user
      where platform_role = 'super_admin' and status = 'active'
      order by created_at
      limit 1
    `);
    const admin = admins[0];
    if (!admin) throw new Error("No active platform Super Admin exists in PR59 QA DB");

    const languageRows = await db.execute<{ id: string; code: string }>(sql`
      select id, code from language where code in ('en', 'ar')
    `);
    const languageIds = {
      en: languageRows.find((row) => row.code === "en")?.id ?? null,
      ar: languageRows.find((row) => row.code === "ar")?.id ?? null,
    };
    if (!languageIds.en) throw new Error("English language row is missing");

    for (const spec of STORES) {
      const issued = await issueMerchantInvitation(db, {
        actorUserId: admin.id,
        storeName: spec.name,
        storeSlug: spec.slug,
        invitedEmail: spec.email,
      });
      const password = crypto.randomBytes(18).toString("base64url");
      const accepted = await acceptMerchantInvitation(db, {
        token: issued.token,
        password,
      });
      credentials.push({ storeSlug: spec.slug, email: spec.email, password });

      const categoryId = await ensureCategory(
        db,
        accepted.storeId,
        `${spec.slug}-root`,
      );
      const productId = await ensureProduct(db, {
        storeId: accepted.storeId,
        categoryId,
        slug: spec.product.slug,
        price: spec.product.price,
        nameEn: spec.product.nameEn,
        nameAr: spec.product.nameAr,
        languageIds,
      });
      let fallbackId: string | null = null;
      if (spec.fallback) {
        fallbackId = await ensureProduct(db, {
          storeId: accepted.storeId,
          categoryId,
          slug: spec.fallback.slug,
          price: spec.fallback.price,
          nameEn: spec.fallback.nameEn,
          languageIds,
        });
      }
      await db.execute(sql`
        insert into store_commerce_setting (store_id, currency, delivery_fee, cod_enabled)
        values (${accepted.storeId}, 'SAR', ${spec.product.deliveryFee}, true)
        on conflict (store_id)
        do update set currency = 'SAR', delivery_fee = excluded.delivery_fee,
          cod_enabled = true, updated_at = now()
      `);
      await db.execute(sql`
        insert into store_language_setting (store_id, locale)
        values (${accepted.storeId}, ${spec.locale})
        on conflict (store_id)
        do update set locale = excluded.locale, updated_at = now()
      `);

      summary.stores.push({
        key: spec.key,
        name: spec.name,
        slug: spec.slug,
        storeId: accepted.storeId,
        storeStatus: "onboarding",
        locale: spec.locale,
        merchantEmail: spec.email,
        expectedBotUsername: suggestedBotUsername(spec.slug),
        product: {
          id: productId,
          ...spec.product,
        },
        fallback: spec.fallback
          ? { id: fallbackId, ...spec.fallback }
          : null,
      });
    }

    const [storeCount] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from store
    `);
    summary.storeCount = storeCount?.count ?? null;
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o600 });
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ stores: credentials }, null, 2), {
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[pr59-stores:FAIL] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
