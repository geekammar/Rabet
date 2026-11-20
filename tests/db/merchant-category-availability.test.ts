import crypto from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  category,
  categoryTranslation,
  language,
  product,
  productTranslation,
  store,
  storeMembership,
} from "@/db/schema";
import { resolveMerchantAccess } from "@/lib/auth/merchant-session";
import {
  listCatalogCategoriesForStore,
  listCatalogProductsForStore,
} from "@/lib/data";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import { updateMerchantCatalogCategoryAvailability } from "@/lib/merchant/category";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "merchant-category-availability-password-123";

let testDb: TestDatabase | null = null;
let arabicLanguageId = "";
let englishLanguageId = "";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_category_availability");

  const [arabic] = await testDb.db
    .insert(language)
    .values({
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    })
    .returning({ id: language.id });
  const [english] = await testDb.db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .returning({ id: language.id });

  arabicLanguageId = arabic.id;
  englishLanguageId = english.id;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from merchant_auth_throttle`);
  await testDb.db.execute(sql`delete from merchant_invitation`);
  await testDb.db.execute(sql`delete from merchant_credential`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from product_translation`);
  await testDb.db.execute(sql`delete from product`);
  await testDb.db.execute(sql`delete from category_translation`);
  await testDb.db.execute(sql`delete from category`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);
});

function db() {
  return testDb!.db;
}

function appDb() {
  return asAppDb(db());
}

function claims(userId: string, sessionVersion = 0) {
  return { userId, sessionVersion };
}

async function seedMerchant(
  email: string,
  storeName: string,
  storeKey: string,
) {
  const [admin] = await db()
    .insert(appUser)
    .values({
      email: `category-availability-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
    })
    .returning();

  const issued = await issueMerchantInvitation(db(), {
    actorUserId: admin.id,
    storeName,
    storeSlug: `${storeKey}-${crypto.randomUUID()}`,
    invitedEmail: email,
  });

  const accepted = await acceptMerchantInvitation(db(), {
    token: issued.token,
    password: PASSWORD,
  });

  return {
    userId: accepted.userId,
    storeId: accepted.storeId,
  };
}

async function seedCategory(
  storeId: string,
  storeKey: string,
  options: {
    isActive?: boolean;
    deleted?: boolean;
    parentId?: string;
  } = {},
) {
  const [row] = await db()
    .insert(category)
    .values({
      storeId,
      parentId: options.parentId ?? null,
      slug: `${storeKey}-category-${crypto.randomUUID()}`,
      sortOrder: nextOrder(),
      isActive: options.isActive ?? true,
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning({ id: category.id });

  await db().insert(categoryTranslation).values({
    categoryId: row.id,
    languageId: arabicLanguageId,
    name: `قسم ${storeKey}`,
  });

  return row.id;
}

async function seedProduct(
  storeId: string,
  categoryId: string,
  storeKey: string,
  options: {
    isActive?: boolean;
    deleted?: boolean;
  } = {},
) {
  const [row] = await db()
    .insert(product)
    .values({
      storeId,
      categoryId,
      slug: `${storeKey}-product-${crypto.randomUUID()}`,
      price: "10.00",
      isActive: options.isActive ?? false,
      deletedAt: options.deleted ? new Date() : null,
      sortOrder: nextOrder(),
    })
    .returning({ id: product.id });

  await db().insert(productTranslation).values({
    productId: row.id,
    languageId: englishLanguageId,
    name: `${storeKey} product`,
  });

  return row.id;
}

async function readCategoryState(categoryId: string) {
  const [row] = await db()
    .select()
    .from(category)
    .where(eq(category.id, categoryId));

  const translations = await db()
    .select()
    .from(categoryTranslation)
    .where(eq(categoryTranslation.categoryId, categoryId))
    .orderBy(categoryTranslation.id);

  return { row, translations };
}

async function readProductState(productId: string) {
  const [row] = await db()
    .select()
    .from(product)
    .where(eq(product.id, productId));

  const translations = await db()
    .select()
    .from(productTranslation)
    .where(eq(productTranslation.productId, productId))
    .orderBy(productTranslation.id);

  return { row, translations };
}

async function readCategoryRevision(categoryId: string) {
  const [row] = await db()
    .select({
      revision: sql<string>`to_char(${category.updatedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(category)
    .where(eq(category.id, categoryId));
  return row.revision;
}

function expectOnlyCategoryAvailabilityChanged(
  before: Awaited<ReturnType<typeof readCategoryState>>,
  after: Awaited<ReturnType<typeof readCategoryState>>,
  expectedIsActive: boolean,
  expectedRevision: string,
) {
  expect(after.row.id).toBe(before.row.id);
  expect(after.row.storeId).toBe(before.row.storeId);
  expect(after.row.parentId).toBe(before.row.parentId);
  expect(after.row.slug).toBe(before.row.slug);
  expect(after.row.sortOrder).toBe(before.row.sortOrder);
  expect(after.row.deletedAt).toBe(before.row.deletedAt);
  expect(after.row.isActive).toBe(expectedIsActive);
  expect(after.translations).toEqual(before.translations);
  expect(after.row.updatedAt.getTime()).toBeGreaterThanOrEqual(
    before.row.updatedAt.getTime(),
  );
  expect(expectedRevision).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
  );
}

async function listOwnedCategories(storeId: string) {
  return db()
    .select({
      id: category.id,
      parentId: category.parentId,
      isActive: category.isActive,
      deletedAt: category.deletedAt,
      updatedAt: category.updatedAt,
    })
    .from(category)
    .where(eq(category.storeId, storeId))
    .orderBy(category.id);
}

async function listOwnedProducts(storeId: string) {
  return db()
    .select({
      id: product.id,
      categoryId: product.categoryId,
      isActive: product.isActive,
      price: product.price,
      deletedAt: product.deletedAt,
      updatedAt: product.updatedAt,
    })
    .from(product)
    .where(eq(product.storeId, storeId))
    .orderBy(product.id);
}

describe.skipIf(!shouldRun)("merchant category availability mutation", () => {
  it("enables and disables an own category during onboarding and in an active store without touching descendants, products or prices", async () => {
    const a = await seedMerchant(
      "category.onboarding@example.test",
      "Category Onboarding Store",
      "category-onboarding",
    );
    const rootId = await seedCategory(a.storeId, "category-onboarding-root", {
      isActive: false,
    });
    const childId = await seedCategory(a.storeId, "category-onboarding-child", {
      isActive: true,
      parentId: rootId,
    });
    const emptyCategoryId = await seedCategory(
      a.storeId,
      "category-onboarding-empty",
      { isActive: false },
    );
    const activeProductId = await seedProduct(
      a.storeId,
      childId,
      "category-onboarding-active",
      { isActive: true },
    );
    const draftProductId = await seedProduct(
      a.storeId,
      childId,
      "category-onboarding-draft",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));

    expect(access).toMatchObject({
      readOnly: false,
      store: { status: "onboarding" },
    });

    const categoriesBefore = await listOwnedCategories(a.storeId);
    const productsBefore = await listOwnedProducts(a.storeId);
    const rootBefore = await readCategoryState(rootId);
    const scopedBefore = await listCatalogCategoriesForStore(
      appDb(),
      access!.scope,
    );
    expect(scopedBefore.some((row) => row.id === emptyCategoryId)).toBe(true);

    const enabled = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: rootId,
        isActive: true,
        revision: await readCategoryRevision(rootId),
      },
    );

    expect(enabled).toEqual({
      ok: true,
      categoryId: rootId,
      isActive: true,
      revision: await readCategoryRevision(rootId),
    });
    if (!enabled.ok) throw new Error("expected enable to succeed");
    expectOnlyCategoryAvailabilityChanged(
      rootBefore,
      await readCategoryState(rootId),
      true,
      enabled.revision,
    );

    const categoriesAfterEnable = await listOwnedCategories(a.storeId);
    expect(
      categoriesAfterEnable.filter((row) => row.id !== rootId),
    ).toEqual(categoriesBefore.filter((row) => row.id !== rootId));
    expect(await listOwnedProducts(a.storeId)).toEqual(productsBefore);

    const rootAfterEnable = await readCategoryState(rootId);
    const disabled = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: rootId,
        isActive: false,
        revision: await readCategoryRevision(rootId),
      },
    );

    expect(disabled).toEqual({
      ok: true,
      categoryId: rootId,
      isActive: false,
      revision: await readCategoryRevision(rootId),
    });
    if (!disabled.ok) throw new Error("expected disable to succeed");
    expectOnlyCategoryAvailabilityChanged(
      rootAfterEnable,
      await readCategoryState(rootId),
      false,
      disabled.revision,
    );

    await db()
      .update(store)
      .set({ status: "active" })
      .where(eq(store.id, a.storeId));

    const activeAccess = await resolveMerchantAccess(db(), claims(a.userId));
    expect(activeAccess).toMatchObject({
      readOnly: false,
      store: { status: "active" },
    });

    const beforeActiveEnable = await readCategoryState(rootId);
    const enabledInActiveStore =
      await updateMerchantCatalogCategoryAvailability(
        appDb(),
        activeAccess!,
        {
          categoryId: rootId,
          isActive: true,
          revision: await readCategoryRevision(rootId),
        },
      );

    expect(enabledInActiveStore).toMatchObject({
      ok: true,
      categoryId: rootId,
      isActive: true,
    });
    if (!enabledInActiveStore.ok) {
      throw new Error("expected active-store enable to succeed");
    }
    expectOnlyCategoryAvailabilityChanged(
      beforeActiveEnable,
      await readCategoryState(rootId),
      true,
      enabledInActiveStore.revision,
    );
    expect(await listOwnedProducts(a.storeId)).toEqual(productsBefore);
    expect(
      (await readProductState(activeProductId)).row.isActive,
    ).toBe(true);
    expect((await readProductState(draftProductId)).row.isActive).toBe(false);
  });

  it("rejects foreign, missing, soft-deleted and malformed targets without writing", async () => {
    const a = await seedMerchant(
      "category.safe.a@example.test",
      "Category Safe Store A",
      "category-safe-a",
    );
    const b = await seedMerchant(
      "category.safe.b@example.test",
      "Category Safe Store B",
      "category-safe-b",
    );
    const categoryAId = await seedCategory(
      a.storeId,
      "category-safe-a",
      { isActive: false },
    );
    const categoryBId = await seedCategory(
      b.storeId,
      "category-safe-b",
      { isActive: true },
    );
    const deletedCategoryAId = await seedCategory(
      a.storeId,
      "category-safe-a-deleted",
      { deleted: true },
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const categoryABefore = await readCategoryState(categoryAId);
    const categoryBBefore = await readCategoryState(categoryBId);
    const deletedBefore = await readCategoryState(deletedCategoryAId);

    const foreign = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: categoryBId,
        isActive: false,
        revision: await readCategoryRevision(categoryBId),
      },
    );
    expect(foreign).toEqual({ ok: false, error: "NOT_FOUND" });

    const missing = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: globalThis.crypto.randomUUID(),
        isActive: true,
        revision: "2026-11-19T22:42:44.123456Z",
      },
    );
    expect(missing).toEqual({ ok: false, error: "NOT_FOUND" });

    const deleted = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: deletedCategoryAId,
        isActive: true,
        revision: await readCategoryRevision(deletedCategoryAId),
      },
    );
    expect(deleted).toEqual({ ok: false, error: "NOT_FOUND" });

    const malformedId = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: "not-a-uuid",
        isActive: true,
        revision: await readCategoryRevision(categoryAId),
      },
    );
    expect(malformedId).toEqual({ ok: false, error: "NOT_FOUND" });

    const malformedBoolean = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: categoryAId,
        isActive: "true",
        revision: await readCategoryRevision(categoryAId),
      },
    );
    expect(malformedBoolean).toEqual({ ok: false, error: "INVALID_INPUT" });

    const malformedRevision = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: categoryAId,
        isActive: true,
        revision: "2026-11-19T22:42:44.123Z",
      },
    );
    expect(malformedRevision).toEqual({
      ok: false,
      error: "INVALID_REVISION",
    });

    expect(await readCategoryState(categoryAId)).toEqual(categoryABefore);
    expect(await readCategoryState(categoryBId)).toEqual(categoryBBefore);
    expect(await readCategoryState(deletedCategoryAId)).toEqual(deletedBefore);
  });

  it("rejects writes after revocation, a session-version change or suspension committed before the guarded write", async () => {
    const a = await seedMerchant(
      "category.authorization@example.test",
      "Category Authorization Store",
      "category-authorization",
    );
    const categoryId = await seedCategory(
      a.storeId,
      "category-authorization",
      { isActive: false },
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const [membership] = await db()
      .select({ id: storeMembership.id })
      .from(storeMembership)
      .where(eq(storeMembership.storeId, a.storeId));
    const before = await readCategoryState(categoryId);

    await db()
      .update(storeMembership)
      .set({ status: "revoked" })
      .where(eq(storeMembership.id, membership.id));

    const revoked = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId,
        isActive: true,
        revision: await readCategoryRevision(categoryId),
      },
    );
    expect(revoked).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readCategoryState(categoryId)).toEqual(before);

    await db()
      .update(storeMembership)
      .set({ status: "active" })
      .where(eq(storeMembership.id, membership.id));

    const freshAccess = await resolveMerchantAccess(db(), claims(a.userId));
    expect(freshAccess).not.toBeNull();

    await db()
      .update(appUser)
      .set({ sessionVersion: sql`${appUser.sessionVersion} + 1` })
      .where(eq(appUser.id, a.userId));

    const staleSession = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      freshAccess!,
      {
        categoryId,
        isActive: true,
        revision: await readCategoryRevision(categoryId),
      },
    );
    expect(staleSession).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readCategoryState(categoryId)).toEqual(before);

    await db()
      .update(appUser)
      .set({ sessionVersion: 0 })
      .where(eq(appUser.id, a.userId));

    const restoredAccess = await resolveMerchantAccess(
      db(),
      claims(a.userId),
    );
    expect(restoredAccess).not.toBeNull();

    await db()
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, a.storeId));

    const suspended = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      restoredAccess!,
      {
        categoryId,
        isActive: true,
        revision: await readCategoryRevision(categoryId),
      },
    );
    expect(suspended).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readCategoryState(categoryId)).toEqual(before);
  });

  it("returns a conflict only for an authorized target and requires a fresh explicit decision after a stale revision", async () => {
    const a = await seedMerchant(
      "category.conflict.a@example.test",
      "Category Conflict Store A",
      "category-conflict-a",
    );
    const b = await seedMerchant(
      "category.conflict.b@example.test",
      "Category Conflict Store B",
      "category-conflict-b",
    );
    const categoryAId = await seedCategory(
      a.storeId,
      "category-conflict-a",
      { isActive: false },
    );
    const categoryBId = await seedCategory(
      b.storeId,
      "category-conflict-b",
      { isActive: true },
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const staleRevision = await readCategoryRevision(categoryAId);

    await db()
      .update(category)
      .set({ isActive: true })
      .where(eq(category.id, categoryAId));
    const winningRevision = await readCategoryRevision(categoryAId);

    const conflict = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: categoryAId,
        isActive: false,
        revision: staleRevision,
      },
    );
    expect(conflict).toEqual({
      ok: false,
      error: "CONFLICT",
      current: { isActive: true, revision: winningRevision },
    });
    expect((await readCategoryState(categoryAId)).row.isActive).toBe(true);

    const foreign = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: categoryBId,
        isActive: false,
        revision: staleRevision,
      },
    );
    expect(foreign).toEqual({ ok: false, error: "NOT_FOUND" });
    expect((await readCategoryState(categoryBId)).row.isActive).toBe(true);

    const explicitDecision =
      await updateMerchantCatalogCategoryAvailability(appDb(), access!, {
        categoryId: categoryAId,
        isActive: false,
        revision: winningRevision,
      });
    expect(explicitDecision).toMatchObject({
      ok: true,
      categoryId: categoryAId,
      isActive: false,
    });
    expect((await readCategoryState(categoryAId)).row.isActive).toBe(false);
  });

  it("keeps child and product flags intact when an ancestor is disabled and re-enabled, and follows the effective path", async () => {
    const a = await seedMerchant(
      "category.ancestor@example.test",
      "Category Ancestor Store",
      "category-ancestor",
    );
    const rootId = await seedCategory(a.storeId, "category-ancestor-root", {
      isActive: true,
    });
    const childId = await seedCategory(a.storeId, "category-ancestor-child", {
      isActive: true,
      parentId: rootId,
    });
    const grandchildId = await seedCategory(
      a.storeId,
      "category-ancestor-grandchild",
      { isActive: true, parentId: childId },
    );
    const availableProductId = await seedProduct(
      a.storeId,
      grandchildId,
      "category-ancestor-available",
      { isActive: true },
    );
    const draftProductId = await seedProduct(
      a.storeId,
      grandchildId,
      "category-ancestor-draft",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const categoriesBefore = await listOwnedCategories(a.storeId);
    const productsBefore = await listOwnedProducts(a.storeId);

    const initial = await listCatalogCategoriesForStore(
      appDb(),
      access!.scope,
    );
    expect(
      initial.find((row) => row.id === rootId)?.pathVisible,
    ).toBe(true);
    expect(
      initial.find((row) => row.id === childId)?.pathVisible,
    ).toBe(true);
    expect(
      initial.find((row) => row.id === grandchildId)?.pathVisible,
    ).toBe(true);

    const disabledAncestor =
      await updateMerchantCatalogCategoryAvailability(appDb(), access!, {
        categoryId: rootId,
        isActive: false,
        revision: await readCategoryRevision(rootId),
      });
    expect(disabledAncestor).toMatchObject({
      ok: true,
      categoryId: rootId,
      isActive: false,
    });

    const afterDisable = await listCatalogCategoriesForStore(
      appDb(),
      access!.scope,
    );
    expect(afterDisable.find((row) => row.id === rootId)).toMatchObject({
      isActive: false,
      pathVisible: false,
    });
    expect(afterDisable.find((row) => row.id === childId)).toMatchObject({
      isActive: true,
      pathVisible: false,
    });
    expect(
      afterDisable.find((row) => row.id === grandchildId),
    ).toMatchObject({
      isActive: true,
      pathVisible: false,
    });

    expect(
      (await listOwnedCategories(a.storeId)).filter(
        (row) => row.id !== rootId,
      ),
    ).toEqual(categoriesBefore.filter((row) => row.id !== rootId));
    expect(await listOwnedProducts(a.storeId)).toEqual(productsBefore);
    expect(
      (await readProductState(availableProductId)).row.isActive,
    ).toBe(true);
    expect((await readProductState(draftProductId)).row.isActive).toBe(false);

    const productsAfterDisable = await listCatalogProductsForStore(
      appDb(),
      access!.scope,
    );
    expect(
      productsAfterDisable.find(
        (row) => row.id === availableProductId,
      ),
    ).toMatchObject({
      isActive: true,
      categoryPathVisible: false,
    });
    expect(
      productsAfterDisable.find((row) => row.id === draftProductId),
    ).toMatchObject({
      isActive: false,
      categoryPathVisible: false,
    });

    const reEnabledAncestor =
      await updateMerchantCatalogCategoryAvailability(appDb(), access!, {
        categoryId: rootId,
        isActive: true,
        revision: await readCategoryRevision(rootId),
      });
    expect(reEnabledAncestor).toMatchObject({
      ok: true,
      categoryId: rootId,
      isActive: true,
    });

    const afterEnable = await listCatalogCategoriesForStore(
      appDb(),
      access!.scope,
    );
    expect(afterEnable.find((row) => row.id === childId)?.pathVisible).toBe(
      true,
    );
    expect(
      afterEnable.find((row) => row.id === grandchildId)?.pathVisible,
    ).toBe(true);

    const productsAfterEnable = await listCatalogProductsForStore(
      appDb(),
      access!.scope,
    );
    expect(
      productsAfterEnable.find((row) => row.id === availableProductId),
    ).toMatchObject({
      isActive: true,
      categoryPathVisible: true,
    });
    expect(
      productsAfterEnable.find((row) => row.id === draftProductId),
    ).toMatchObject({
      isActive: false,
      categoryPathVisible: true,
    });

    expect(
      (await listOwnedCategories(a.storeId)).filter(
        (row) => row.id !== rootId,
      ),
    ).toEqual(categoriesBefore.filter((row) => row.id !== rootId));
    expect(await listOwnedProducts(a.storeId)).toEqual(productsBefore);
  });

  it("reports invalid ancestry as unavailable, still allows saving the own category, and never exposes foreign category details", async () => {
    const a = await seedMerchant(
      "category.invalid.a@example.test",
      "Category Invalid Store A",
      "category-invalid-a",
    );
    const b = await seedMerchant(
      "category.invalid.b@example.test",
      "Category Invalid Store B",
      "category-invalid-b",
    );
    const foreignParentId = await seedCategory(
      b.storeId,
      "category-invalid-foreign-parent",
      { isActive: true },
    );
    const [foreignParent] = await db()
      .select({
        id: category.id,
        slug: category.slug,
        isActive: category.isActive,
      })
      .from(category)
      .where(eq(category.id, foreignParentId));
    const foreignChildId = await seedCategory(
      a.storeId,
      "category-invalid-foreign-child",
      { isActive: true, parentId: foreignParentId },
    );

    const deletedParentId = await seedCategory(
      a.storeId,
      "category-invalid-deleted-parent",
      { isActive: true },
    );
    const deletedAncestorChildId = await seedCategory(
      a.storeId,
      "category-invalid-deleted-child",
      { isActive: true, parentId: deletedParentId },
    );
    await db()
      .update(category)
      .set({ deletedAt: new Date() })
      .where(eq(category.id, deletedParentId));

    const cycleParentId = await seedCategory(
      a.storeId,
      "category-invalid-cycle-parent",
      { isActive: true },
    );
    const cycleChildId = await seedCategory(
      a.storeId,
      "category-invalid-cycle-child",
      { isActive: true, parentId: cycleParentId },
    );
    await db().execute(
      sql`alter table category disable trigger category_check_ancestry`,
    );
    try {
      await db()
        .update(category)
        .set({ parentId: cycleChildId })
        .where(eq(category.id, cycleParentId));
    } finally {
      await db().execute(
        sql`alter table category enable trigger category_check_ancestry`,
      );
    }

    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const foreignParentBefore = await readCategoryState(foreignParentId);
    const scoped = await listCatalogCategoriesForStore(
      appDb(),
      access!.scope,
    );
    const byId = new Map(scoped.map((row) => [row.id, row]));

    expect(byId.get(foreignChildId)).toMatchObject({
      isActive: true,
      pathVisible: false,
    });
    expect(byId.get(deletedAncestorChildId)).toMatchObject({
      isActive: true,
      pathVisible: false,
    });
    expect(byId.get(cycleChildId)).toMatchObject({
      isActive: true,
      pathVisible: false,
    });
    expect(byId.has(foreignParent.id)).toBe(false);

    const serialized = JSON.stringify(scoped);
    expect(serialized).not.toContain(foreignParent.id);
    expect(serialized).not.toContain(foreignParent.slug);
    expect(serialized).not.toContain("category-invalid-foreign-parent");

    const saved = await updateMerchantCatalogCategoryAvailability(
      appDb(),
      access!,
      {
        categoryId: foreignChildId,
        isActive: false,
        revision: await readCategoryRevision(foreignChildId),
      },
    );
    expect(saved).toMatchObject({
      ok: true,
      categoryId: foreignChildId,
      isActive: false,
    });

    const afterSave = await listCatalogCategoriesForStore(
      appDb(),
      access!.scope,
    );
    const savedChild = afterSave.find((row) => row.id === foreignChildId);
    expect(savedChild).toMatchObject({
      isActive: false,
      pathVisible: false,
    });
    expect(JSON.stringify(afterSave)).not.toContain(foreignParent.id);
    expect(JSON.stringify(afterSave)).not.toContain(foreignParent.slug);
    expect(await readCategoryState(foreignParentId)).toEqual(
      foreignParentBefore,
    );
  });
});
