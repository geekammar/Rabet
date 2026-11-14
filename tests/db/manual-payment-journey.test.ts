import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  category,
  inquiry,
  paymentMethod,
  product,
  productAction,
  sellerNotificationDelivery,
} from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  createCatalogCategory,
  createCatalogProduct,
  createPaymentMethod,
  createProductAction,
  editPaymentMethod,
  ensureLanguage,
  getCustomerByTelegramId,
  initializeSettings,
  readProductAction,
  setCustomerSelectedLanguage,
  togglePaymentMethodActive,
  upsertCustomer,
} from "@/lib/data";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import { handleTelegramWebhookRequest } from "@/lib/telegram/webhook";
import { tokens } from "@/lib/telegram/tokens";
import { isManualPaymentPrototypeEnabled } from "@/lib/payment-methods/prototype";
import {
  listEligiblePaymentMethodsForProduct,
  resolvePaymentMethodForAction,
} from "@/lib/payment-methods/journey";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let enLangId: string;
let arLangId: string;

const TEST_BOT_TOKEN = "123456:MANUAL_PAYMENT_TEST_TOKEN";
const TEST_WEBHOOK_SECRET = "manual-payment-webhook-secret-32chars";

let sequence = 0;
let updateId = 50_000;

function nextUpdateId(): number {
  updateId += 1;
  return updateId;
}

function nextTelegramId(): number {
  sequence += 1;
  return 700_000_000 + sequence;
}

function createWebhookRequest(body: unknown): Request {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
}

async function sendCallback(params: {
  telegramId: number;
  data: string;
  enabled: boolean;
  updateIdOverride?: number;
  messageId?: number;
}) {
  const transport = createFakeTelegramTransport();
  const id = params.updateIdOverride ?? nextUpdateId();
  const previousCapability = process.env.MANUAL_PAYMENT_PROTOTYPE_ENABLED;
  process.env.MANUAL_PAYMENT_PROTOTYPE_ENABLED = params.enabled ? "true" : "false";

  try {
    const res = await handleTelegramWebhookRequest(
      createWebhookRequest({
        update_id: id,
        callback_query: {
          id: `cb_${id}`,
          from: {
            id: params.telegramId,
            is_bot: false,
            first_name: "Synthetic Customer",
          },
          message: {
            message_id: params.messageId ?? 10,
            chat: { id: params.telegramId, type: "private" },
          },
          data: params.data,
        },
      }),
      {
        db: asAppDb(testDb!.db),
        transport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      },
    );
    return { res, transport, updateId: id };
  } finally {
    if (previousCapability === undefined) {
      delete process.env.MANUAL_PAYMENT_PROTOTYPE_ENABLED;
    } else {
      process.env.MANUAL_PAYMENT_PROTOTYPE_ENABLED = previousCapability;
    }
  }
}

async function seedProduct(): Promise<{ categoryId: string; productId: string }> {
  sequence += 1;
  const appDb = asAppDb(testDb!.db);
  const suffix = `${sequence}-${Date.now()}`;

  const createdCategory = await createCatalogCategory(appDb, {
    parentId: null,
    slug: `payment-journey-category-${suffix}`,
    translations: [
      { languageId: enLangId, name: "Payment Journey Category" },
      { languageId: arLangId, name: "فئة رحلة الدفع" },
    ],
  });
  await testDb!.db
    .update(category)
    .set({ isActive: true })
    .where(eq(category.id, createdCategory.categoryId));

  const createdProduct = await createCatalogProduct(appDb, {
    categoryId: createdCategory.categoryId,
    slug: `payment-journey-product-${suffix}`,
    price: "49.00",
    translations: [
      {
        languageId: enLangId,
        name: "Synthetic Product",
        description: "A product used only by the manual-payment prototype suite.",
      },
      {
        languageId: arLangId,
        name: "منتج تجريبي",
        description: "منتج يستخدم فقط في اختبارات الدفع اليدوي.",
      },
    ],
  });
  await testDb!.db
    .update(product)
    .set({ isActive: true })
    .where(eq(product.id, createdProduct.productId));

  return {
    categoryId: createdCategory.categoryId,
    productId: createdProduct.productId,
  };
}

async function seedMethod(params: {
  adminLabel: string;
  enTitle?: string;
  enInstructions?: string | null;
  arTitle?: string;
  arInstructions?: string | null;
  isActive?: boolean;
}): Promise<string> {
  const appDb = asAppDb(testDb!.db);
  const translations = [
    {
      languageId: enLangId,
      languageCode: "en",
      title: params.enTitle ?? params.adminLabel,
      instructions: params.enInstructions ?? null,
    },
  ];
  if (params.arTitle) {
    translations.push({
      languageId: arLangId,
      languageCode: "ar",
      title: params.arTitle,
      instructions: params.arInstructions ?? null,
    });
  }

  const created = await createPaymentMethod(appDb, {
    adminLabel: params.adminLabel,
    isActive: params.isActive ?? true,
    translations,
  });
  return created.methodId;
}

async function seedMenu(params: {
  productId: string;
  enLabel?: string;
  arLabel?: string;
  enMenuText?: string;
  arMenuText?: string;
}): Promise<string> {
  const appDb = asAppDb(testDb!.db);
  const created = await createProductAction(appDb, {
    productId: params.productId,
    actionType: "OPEN_SUBMENU",
    isActive: true,
    translations: [
      {
        languageId: enLangId,
        languageCode: "en",
        label: params.enLabel ?? "Purchase",
        menuText: params.enMenuText ?? "Choose a payment method:",
      },
      ...(params.arLabel
        ? [
            {
              languageId: arLangId,
              languageCode: "ar",
              label: params.arLabel,
              menuText: params.arMenuText ?? "اختر طريقة الدفع:",
            },
          ]
        : []),
    ],
  });
  return created.actionId;
}

async function seedPaymentAction(params: {
  productId: string;
  parentActionId?: string | null;
  methodId: string;
  enLabel: string;
  arLabel?: string;
}): Promise<string> {
  const appDb = asAppDb(testDb!.db);
  const created = await createProductAction(appDb, {
    productId: params.productId,
    parentActionId: params.parentActionId ?? null,
    actionType: "PAYMENT_METHOD",
    isActive: true,
    paymentMethodId: params.methodId,
    translations: [
      {
        languageId: enLangId,
        languageCode: "en",
        label: params.enLabel,
      },
      ...(params.arLabel
        ? [
            {
              languageId: arLangId,
              languageCode: "ar",
              label: params.arLabel,
            },
          ]
        : []),
    ],
  });
  return created.actionId;
}

async function seedRootSupportAction(productId: string): Promise<string> {
  const appDb = asAppDb(testDb!.db);
  const created = await createProductAction(appDb, {
    productId,
    actionType: "START_INQUIRY",
    isActive: true,
    translations: [
      {
        languageId: enLangId,
        languageCode: "en",
        label: "Ask the seller",
      },
      {
        languageId: arLangId,
        languageCode: "ar",
        label: "اسأل البائع",
      },
    ],
  });
  return created.actionId;
}

function latestEdited(transport: ReturnType<typeof createFakeTelegramTransport>) {
  return transport.editedMessages[transport.editedMessages.length - 1];
}

function flatButtons(transport: ReturnType<typeof createFakeTelegramTransport>) {
  return (latestEdited(transport)?.replyMarkup?.inline_keyboard ?? []).flat();
}

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("manual_payment_journey");
  const appDb = asAppDb(testDb.db);

  const en = await ensureLanguage(appDb, {
    code: "en",
    label: "English",
    textDirection: "ltr",
    isEnabled: true,
  });
  enLangId = en.id;

  const ar = await ensureLanguage(appDb, {
    code: "ar",
    label: "العربية",
    textDirection: "rtl",
    isEnabled: true,
  });
  arLangId = ar.id;

  await initializeSettings(appDb, {
    defaultLanguageCode: "en",
    displayName: "Synthetic Rabet Store",
    currency: "USD",
    askForLanguage: false,
  });
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe("manual-payment prototype capability", () => {
  it("is disabled by default and enabled only by the explicit server capability", () => {
    expect(isManualPaymentPrototypeEnabled({})).toBe(false);
    expect(
      isManualPaymentPrototypeEnabled({
        MANUAL_PAYMENT_PROTOTYPE_ENABLED: "false",
      }),
    ).toBe(false);
    expect(
      isManualPaymentPrototypeEnabled({
        MANUAL_PAYMENT_PROTOTYPE_ENABLED: "true",
      }),
    ).toBe(true);
  });
});

describe.skipIf(!shouldRun)("manual-payment journey acceptance", () => {
  it("serves one eligible method from product → Purchase → instructions", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({
      adminLabel: "Synthetic Bank Transfer",
      enTitle: "Synthetic Bank Transfer",
      enInstructions: "Use the synthetic test account only. No real transfer is required.",
    });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Pay by bank transfer",
    });
    const telegramId = nextTelegramId();

    const productStep = await sendCallback({
      telegramId,
      data: tokens.product(productId),
      enabled: true,
    });
    expect(productStep.res.status).toBe(200);
    expect(flatButtons(productStep.transport).map((button) => button.text)).toContain(
      "Purchase",
    );

    const menuStep = await sendCallback({
      telegramId,
      data: tokens.action(menuId),
      enabled: true,
    });
    expect(latestEdited(menuStep.transport).text).toContain("Choose a payment method");
    expect(flatButtons(menuStep.transport).map((button) => button.text)).toContain(
      "Pay by bank transfer",
    );

    const instructionsStep = await sendCallback({
      telegramId,
      data: tokens.action(actionId),
      enabled: true,
    });
    const text = latestEdited(instructionsStep.transport).text;
    expect(text).toContain("Synthetic Product");
    expect(text).toContain("Synthetic Bank Transfer");
    expect(text).toContain("synthetic test account");
    expect(text).toContain("Prototype only");
    expect(text).not.toContain("Paid");
    expect(text).not.toMatch(/payment verified/i);
    expect(text).not.toMatch(/I paid/i);

    const buttons = flatButtons(instructionsStep.transport);
    expect(buttons.some((button) => button.text.includes("Contact seller about this method"))).toBe(
      true,
    );
    expect(
      buttons.some((button) => button.callback_data === tokens.action(menuId)),
    ).toBe(true);
    expect(
      buttons.some((button) => button.callback_data === tokens.product(productId)),
    ).toBe(true);
    expect(buttons.some((button) => button.callback_data === tokens.home())).toBe(true);
  });

  it("keeps multiple configured methods in stable order", async () => {
    const { productId } = await seedProduct();
    const firstMethod = await seedMethod({ adminLabel: "First method" });
    const secondMethod = await seedMethod({ adminLabel: "Second method" });
    const thirdMethod = await seedMethod({ adminLabel: "Third method" });

    const menuId = await seedMenu({ productId });
    const firstAction = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId: firstMethod,
      enLabel: "First configured",
    });
    const secondAction = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId: secondMethod,
      enLabel: "Second configured",
    });
    const thirdAction = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId: thirdMethod,
      enLabel: "Third configured",
    });

    const resolver = await listEligiblePaymentMethodsForProduct(asAppDb(testDb!.db), {
      productId,
      parentActionId: menuId,
      requestedLanguageId: enLangId,
      defaultLanguageId: enLangId,
    });
    expect(resolver.status).toBe("ok");
    if (resolver.status !== "ok") return;
    expect(resolver.methods.map((method) => method.actionId)).toEqual([
      firstAction,
      secondAction,
      thirdAction,
    ]);

    const step = await sendCallback({
      telegramId: nextTelegramId(),
      data: tokens.action(menuId),
      enabled: true,
    });
    const labels = flatButtons(step.transport)
      .map((button) => button.text)
      .filter((label) => label.includes("configured"));
    expect(labels).toEqual(["First configured", "Second configured", "Third configured"]);
  });

  it("supports both a root method action and a method nested under Purchase", async () => {
    const { productId } = await seedProduct();
    const rootMethod = await seedMethod({ adminLabel: "Root synthetic wallet" });
    const nestedMethod = await seedMethod({ adminLabel: "Nested synthetic wallet" });
    const menuId = await seedMenu({ productId });
    const nestedAction = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId: nestedMethod,
      enLabel: "Nested wallet",
    });
    const rootAction = await seedPaymentAction({
      productId,
      methodId: rootMethod,
      enLabel: "Root wallet",
    });
    const telegramId = nextTelegramId();

    const productStep = await sendCallback({
      telegramId,
      data: tokens.product(productId),
      enabled: true,
    });
    const rootLabels = flatButtons(productStep.transport).map((button) => button.text);
    expect(rootLabels).toContain("Purchase");
    expect(rootLabels).toContain("Root wallet");

    const rootInstructions = await sendCallback({
      telegramId,
      data: tokens.action(rootAction),
      enabled: true,
    });
    expect(latestEdited(rootInstructions.transport).text).toContain("Root synthetic wallet");
    expect(latestEdited(rootInstructions.transport).text).toContain("Prototype only");

    const menuStep = await sendCallback({
      telegramId,
      data: tokens.action(menuId),
      enabled: true,
    });
    expect(flatButtons(menuStep.transport).map((button) => button.text)).toContain(
      "Nested wallet",
    );

    const nestedInstructions = await sendCallback({
      telegramId,
      data: tokens.action(nestedAction),
      enabled: true,
    });
    expect(latestEdited(nestedInstructions.transport).text).toContain(
      "Nested synthetic wallet",
    );
  });

  it("uses requested language, second language, and the documented default fallback", async () => {
    const { productId } = await seedProduct();
    const bilingualMethod = await seedMethod({
      adminLabel: "Bilingual method",
      enTitle: "English stored title",
      enInstructions: "English stored instructions",
      arTitle: "عنوان عربي محفوظ",
      arInstructions: "تعليمات عربية محفوظة",
    });
    const englishOnlyMethod = await seedMethod({
      adminLabel: "English only method",
      enTitle: "English fallback title",
      enInstructions: "English fallback instructions",
    });
    const menuId = await seedMenu({
      productId,
      enLabel: "Purchase",
      arLabel: "الشراء",
    });
    const bilingualAction = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId: bilingualMethod,
      enLabel: "Bilingual option",
      arLabel: "خيار ثنائي اللغة",
    });
    const englishOnlyAction = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId: englishOnlyMethod,
      enLabel: "Fallback option",
    });

    const appDb = asAppDb(testDb!.db);

    const english = await resolvePaymentMethodForAction(appDb, {
      productId,
      actionId: bilingualAction,
      requestedLanguageId: enLangId,
      defaultLanguageId: enLangId,
    });
    expect(english.status).toBe("ok");
    if (english.status === "ok") {
      expect(english.method.title).toBe("English stored title");
      expect(english.method.usedFallback).toBe(false);
    }

    const arabic = await resolvePaymentMethodForAction(appDb, {
      productId,
      actionId: bilingualAction,
      requestedLanguageId: arLangId,
      defaultLanguageId: enLangId,
    });
    expect(arabic.status).toBe("ok");
    if (arabic.status === "ok") {
      expect(arabic.method.title).toBe("عنوان عربي محفوظ");
      expect(arabic.method.instructions).toBe("تعليمات عربية محفوظة");
      expect(arabic.method.usedFallback).toBe(false);
    }

    const fallback = await resolvePaymentMethodForAction(appDb, {
      productId,
      actionId: englishOnlyAction,
      requestedLanguageId: arLangId,
      defaultLanguageId: enLangId,
    });
    expect(fallback.status).toBe("ok");
    if (fallback.status === "ok") {
      expect(fallback.method.title).toBe("English fallback title");
      expect(fallback.method.instructions).toBe("English fallback instructions");
      expect(fallback.method.usedFallback).toBe(true);
    }

    const telegramId = nextTelegramId();
    await upsertCustomer(appDb, {
      telegramId,
      telegramUsername: null,
      firstName: "Arabic",
      lastName: "Customer",
      languageCode: "ar",
    });
    await setCustomerSelectedLanguage(appDb, telegramId, arLangId);

    const arabicStep = await sendCallback({
      telegramId,
      data: tokens.action(bilingualAction),
      enabled: true,
    });
    const arabicText = latestEdited(arabicStep.transport).text;
    expect(arabicText).toContain("عنوان عربي محفوظ");
    expect(arabicText).toContain("تعليمات عربية محفوظة");
    expect(arabicText).toContain("نسخة تجريبية فقط");

    const fallbackStep = await sendCallback({
      telegramId,
      data: tokens.action(englishOnlyAction),
      enabled: true,
    });
    const fallbackText = latestEdited(fallbackStep.transport).text;
    expect(fallbackText).toContain("English fallback title");
    expect(fallbackText).toContain("English fallback instructions");
  });

  it("rejects a method disabled after the menu was rendered", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({
      adminLabel: "Disposable method",
      enTitle: "Disposable method",
      enInstructions: "Synthetic instructions",
    });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Disposable option",
    });
    const telegramId = nextTelegramId();

    const menuStep = await sendCallback({
      telegramId,
      data: tokens.action(menuId),
      enabled: true,
    });
    expect(flatButtons(menuStep.transport).map((button) => button.text)).toContain(
      "Disposable option",
    );

    await togglePaymentMethodActive(asAppDb(testDb!.db), methodId, false);

    const staleStep = await sendCallback({
      telegramId,
      data: tokens.action(actionId),
      enabled: true,
    });
    expect(latestEdited(staleStep.transport).text).toContain(
      "This option is no longer available.",
    );
    expect(latestEdited(staleStep.transport).text).not.toContain("Disposable method");

    const freshMenu = await sendCallback({
      telegramId,
      data: tokens.action(menuId),
      enabled: true,
    });
    expect(latestEdited(freshMenu.transport).text).toContain(
      "No payment methods are currently available",
    );
  });

  it("rejects a deleted method reference without exposing internal labels", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({
      adminLabel: "Deleted admin label",
      enTitle: "Deleted customer title",
      enInstructions: "Deleted customer instructions",
    });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Deleted option",
    });
    await seedRootSupportAction(productId);

    await testDb!.db.delete(paymentMethod).where(eq(paymentMethod.id, methodId));

    const [storedAction] = await testDb!.db
      .select({ paymentMethodId: productAction.paymentMethodId })
      .from(productAction)
      .where(eq(productAction.id, actionId));
    expect(storedAction.paymentMethodId).toBeNull();

    const step = await sendCallback({
      telegramId: nextTelegramId(),
      data: tokens.action(actionId),
      enabled: true,
    });
    const text = latestEdited(step.transport).text;
    expect(text).toContain("This option is no longer available.");
    expect(text).not.toContain("Deleted admin label");

    const menuStep = await sendCallback({
      telegramId: nextTelegramId(),
      data: tokens.action(menuId),
      enabled: true,
    });
    expect(latestEdited(menuStep.transport).text).toContain(
      "No payment methods are currently available",
    );
    expect(flatButtons(menuStep.transport).map((button) => button.text)).toContain(
      "Ask the seller",
    );
  });

  it("rejects inactive product, category, action, and ancestor paths", async () => {
    const appDb = asAppDb(testDb!.db);
    const { productId, categoryId } = await seedProduct();
    const methodId = await seedMethod({ adminLabel: "Availability method" });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Availability option",
    });

    await testDb!.db
      .update(productAction)
      .set({ isActive: false })
      .where(eq(productAction.id, actionId));
    expect(
      await resolvePaymentMethodForAction(appDb, {
        productId,
        actionId,
        requestedLanguageId: enLangId,
        defaultLanguageId: enLangId,
      }),
    ).toMatchObject({ status: "unavailable", reason: "action_unavailable" });
    await testDb!.db
      .update(productAction)
      .set({ isActive: true })
      .where(eq(productAction.id, actionId));

    await testDb!.db
      .update(productAction)
      .set({ isActive: false })
      .where(eq(productAction.id, menuId));
    expect(
      await resolvePaymentMethodForAction(appDb, {
        productId,
        actionId,
        requestedLanguageId: enLangId,
        defaultLanguageId: enLangId,
      }),
    ).toMatchObject({ status: "unavailable", reason: "action_unavailable" });
    expect(
      await listEligiblePaymentMethodsForProduct(appDb, {
        productId,
        parentActionId: menuId,
        requestedLanguageId: enLangId,
        defaultLanguageId: enLangId,
      }),
    ).toMatchObject({ status: "unavailable", reason: "action_unavailable" });
    await testDb!.db
      .update(productAction)
      .set({ isActive: true })
      .where(eq(productAction.id, menuId));

    await testDb!.db
      .update(product)
      .set({ isActive: false })
      .where(eq(product.id, productId));
    expect(
      await listEligiblePaymentMethodsForProduct(appDb, {
        productId,
        parentActionId: menuId,
        requestedLanguageId: enLangId,
        defaultLanguageId: enLangId,
      }),
    ).toMatchObject({ status: "unavailable", reason: "product_unavailable" });
    await testDb!.db
      .update(product)
      .set({ isActive: true })
      .where(eq(product.id, productId));

    await testDb!.db
      .update(category)
      .set({ isActive: false })
      .where(eq(category.id, categoryId));
    expect(
      await listEligiblePaymentMethodsForProduct(appDb, {
        productId,
        parentActionId: menuId,
        requestedLanguageId: enLangId,
        defaultLanguageId: enLangId,
      }),
    ).toMatchObject({ status: "unavailable", reason: "product_unavailable" });
    await testDb!.db
      .update(category)
      .set({ isActive: true })
      .where(eq(category.id, categoryId));

    const staleAction = await sendCallback({
      telegramId: nextTelegramId(),
      data: tokens.action(actionId),
      enabled: true,
    });
    expect(staleAction.res.status).toBe(200);
  });

  it("rejects a forged action/method reference borrowed from another product", async () => {
    const appDb = asAppDb(testDb!.db);
    const first = await seedProduct();
    const second = await seedProduct();

    const firstMenu = await seedMenu({ productId: first.productId });
    const firstMethod = await seedMethod({ adminLabel: "First product method" });
    const firstAction = await seedPaymentAction({
      productId: first.productId,
      parentActionId: firstMenu,
      methodId: firstMethod,
      enLabel: "First product option",
    });

    const secondMenu = await seedMenu({ productId: second.productId });
    const secondMethod = await seedMethod({ adminLabel: "Second product method" });
    const secondAction = await seedPaymentAction({
      productId: second.productId,
      parentActionId: secondMenu,
      methodId: secondMethod,
      enLabel: "Second product option",
    });

    expect(
      await resolvePaymentMethodForAction(appDb, {
        productId: first.productId,
        actionId: secondAction,
        requestedLanguageId: enLangId,
        defaultLanguageId: enLangId,
      }),
    ).toMatchObject({ status: "unavailable", reason: "action_unavailable" });

    expect(
      await listEligiblePaymentMethodsForProduct(appDb, {
        productId: first.productId,
        parentActionId: secondMenu,
        requestedLanguageId: enLangId,
        defaultLanguageId: enLangId,
      }),
    ).toMatchObject({ status: "unavailable", reason: "action_unavailable" });

    expect(firstAction).not.toBe(secondAction);
  });

  it("shows a localized no-methods message and a product support route", async () => {
    const { productId } = await seedProduct();
    const inactiveMethod = await seedMethod({
      adminLabel: "Inactive method",
      enTitle: "Inactive method",
      isActive: false,
    });
    const menuId = await seedMenu({ productId });
    await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId: inactiveMethod,
      enLabel: "Inactive option",
    });
    const supportActionId = await seedRootSupportAction(productId);
    const telegramId = nextTelegramId();

    const step = await sendCallback({
      telegramId,
      data: tokens.action(menuId),
      enabled: true,
    });
    const text = latestEdited(step.transport).text;
    expect(text).toContain("No payment methods are currently available for this product.");
    expect(text).toContain("Prototype only");

    const buttons = flatButtons(step.transport);
    expect(buttons.some((button) => button.text === "Ask the seller")).toBe(true);
    expect(
      buttons.some(
        (button) => button.callback_data === tokens.action(supportActionId),
      ),
    ).toBe(true);
    expect(
      buttons.some((button) => button.callback_data === tokens.product(productId)),
    ).toBe(true);
    expect(buttons.some((button) => button.callback_data === tokens.home())).toBe(true);
  });

  it("keeps Back, Return to Product, and Home navigation working", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({ adminLabel: "Navigation method" });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Navigation option",
    });
    const telegramId = nextTelegramId();

    const instructions = await sendCallback({
      telegramId,
      data: tokens.action(actionId),
      enabled: true,
    });
    const buttons = flatButtons(instructions.transport);
    expect(
      buttons.some((button) => button.callback_data === tokens.action(menuId)),
    ).toBe(true);
    expect(
      buttons.some((button) => button.callback_data === tokens.product(productId)),
    ).toBe(true);
    expect(buttons.some((button) => button.callback_data === tokens.home())).toBe(true);

    const backStep = await sendCallback({
      telegramId,
      data: tokens.back(actionId),
      enabled: true,
    });
    expect(latestEdited(backStep.transport).text).toContain("Choose a payment method");

    const productStep = await sendCallback({
      telegramId,
      data: tokens.product(productId),
      enabled: true,
    });
    expect(latestEdited(productStep.transport).text).toContain("Synthetic Product");

    const homeStep = await sendCallback({
      telegramId,
      data: tokens.home(),
      enabled: true,
    });
    expect(homeStep.res.status).toBe(200);
    expect(latestEdited(homeStep.transport).text.length).toBeGreaterThan(0);
  });

  it("does not create an inquiry or financial state merely by viewing instructions", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({
      adminLabel: "View only method",
      enTitle: "View only method",
      enInstructions: "Synthetic view-only instructions",
    });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "View only option",
    });
    const telegramId = nextTelegramId();

    await sendCallback({ telegramId, data: tokens.product(productId), enabled: true });
    await sendCallback({ telegramId, data: tokens.action(menuId), enabled: true });
    await sendCallback({ telegramId, data: tokens.action(actionId), enabled: true });

    const customerRecord = await getCustomerByTelegramId(asAppDb(testDb!.db), telegramId);
    expect(customerRecord).not.toBeNull();
    const inquiries = await testDb!.db
      .select()
      .from(inquiry)
      .where(eq(inquiry.customerId, customerRecord!.id));
    expect(inquiries).toHaveLength(0);

    const deliveries = await testDb!.db.select().from(sellerNotificationDelivery);
    expect(deliveries).toHaveLength(0);
  });

  it("creates, then resumes, one inquiry with frozen product and method context on explicit contact", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({
      adminLabel: "Contact method",
      enTitle: "Bank Transfer",
      enInstructions: "Synthetic bank instructions",
    });
    const menuId = await seedMenu({ productId, enLabel: "Purchase" });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Pay by bank transfer",
    });
    const telegramId = nextTelegramId();

    await sendCallback({ telegramId, data: tokens.action(menuId), enabled: true });
    await sendCallback({ telegramId, data: tokens.action(actionId), enabled: true });

    const customerRecord = await getCustomerByTelegramId(asAppDb(testDb!.db), telegramId);
    expect(customerRecord).not.toBeNull();
    expect(
      await testDb!.db
        .select()
        .from(inquiry)
        .where(eq(inquiry.customerId, customerRecord!.id)),
    ).toHaveLength(0);

    const contact = await sendCallback({
      telegramId,
      data: tokens.paymentContact(actionId),
      enabled: true,
    });
    expect(contact.res.status).toBe(200);
    expect(latestEdited(contact.transport).text).toContain("Thank you for your inquiry");
    expect(latestEdited(contact.transport).text).toContain("Reference: INQ-");

    const firstInquiries = await testDb!.db
      .select()
      .from(inquiry)
      .where(eq(inquiry.customerId, customerRecord!.id));
    expect(firstInquiries).toHaveLength(1);
    const first = firstInquiries[0];
    expect(first.productId).toBe(productId);
    expect(first.selectedOptions).toEqual([
      "Purchase",
      "Pay by bank transfer",
      "Bank Transfer",
    ]);
    expect(first.productSnapshot).toMatchObject({
      productId,
      name: "Synthetic Product",
      price: "49.00",
      currency: "USD",
    });

    const resumed = await sendCallback({
      telegramId,
      data: tokens.paymentContact(actionId),
      enabled: true,
    });
    expect(resumed.res.status).toBe(200);
    expect(latestEdited(resumed.transport).text).toContain(first.reference);

    const resumedInquiries = await testDb!.db
      .select()
      .from(inquiry)
      .where(eq(inquiry.customerId, customerRecord!.id));
    expect(resumedInquiries).toHaveLength(1);
    expect(resumedInquiries[0].id).toBe(first.id);
    expect(resumedInquiries[0].selectedOptions).toEqual(first.selectedOptions);
  });

  it("does not duplicate an inquiry or notification on a redelivered update", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({ adminLabel: "Duplicate-safe method" });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Duplicate-safe option",
    });
    const telegramId = nextTelegramId();
    const contactUpdateId = nextUpdateId();

    const first = await sendCallback({
      telegramId,
      data: tokens.paymentContact(actionId),
      enabled: true,
      updateIdOverride: contactUpdateId,
    });
    expect(first.res.status).toBe(200);

    const duplicate = await sendCallback({
      telegramId,
      data: tokens.paymentContact(actionId),
      enabled: true,
      updateIdOverride: contactUpdateId,
    });
    const duplicateJson = (await duplicate.res.json()) as { status?: string };
    expect(duplicateJson.status).toBe("already_processed");
    expect(duplicate.transport.editedMessages).toHaveLength(0);

    const customerRecord = await getCustomerByTelegramId(asAppDb(testDb!.db), telegramId);
    const inquiries = await testDb!.db
      .select()
      .from(inquiry)
      .where(eq(inquiry.customerId, customerRecord!.id));
    expect(inquiries).toHaveLength(1);

    const deliveries = await testDb!.db.select().from(sellerNotificationDelivery);
    expect(deliveries).toHaveLength(0);
  });

  it("preserves existing filtering and safe rejection when the capability is OFF", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({ adminLabel: "Off method" });
    const menuId = await seedMenu({ productId });
    const nestedAction = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Off nested option",
    });
    const rootAction = await seedPaymentAction({
      productId,
      methodId,
      enLabel: "Off root option",
    });
    const telegramId = nextTelegramId();

    const productStep = await sendCallback({
      telegramId,
      data: tokens.product(productId),
      enabled: false,
    });
    const rootLabels = flatButtons(productStep.transport).map((button) => button.text);
    expect(rootLabels).toContain("Purchase");
    expect(rootLabels).not.toContain("Off root option");
    expect(latestEdited(productStep.transport).text).not.toContain("Prototype");

    const menuStep = await sendCallback({
      telegramId,
      data: tokens.action(menuId),
      enabled: false,
    });
    expect(flatButtons(menuStep.transport).map((button) => button.text)).not.toContain(
      "Off nested option",
    );
    expect(latestEdited(menuStep.transport).text).not.toContain(
      "No payment methods are currently available",
    );

    const rootExecution = await sendCallback({
      telegramId,
      data: tokens.action(rootAction),
      enabled: false,
    });
    expect(latestEdited(rootExecution.transport).text).toContain(
      "This option is no longer available.",
    );

    const contactAttempt = await sendCallback({
      telegramId,
      data: tokens.paymentContact(nestedAction),
      enabled: false,
    });
    expect(latestEdited(contactAttempt.transport).text).toContain(
      "This option is no longer available.",
    );

    const customerRecord = await getCustomerByTelegramId(asAppDb(testDb!.db), telegramId);
    expect(
      await testDb!.db
        .select()
        .from(inquiry)
        .where(eq(inquiry.customerId, customerRecord!.id)),
    ).toHaveLength(0);
  });

  it("enables only the synthetic prototype when the capability is ON", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({
      adminLabel: "On method",
      enTitle: "Synthetic prototype title",
      enInstructions: "Synthetic prototype instructions",
    });
    const rootAction = await seedPaymentAction({
      productId,
      methodId,
      enLabel: "On root option",
    });
    const telegramId = nextTelegramId();

    const productStep = await sendCallback({
      telegramId,
      data: tokens.product(productId),
      enabled: true,
    });
    expect(flatButtons(productStep.transport).map((button) => button.text)).toContain(
      "On root option",
    );

    const instructions = await sendCallback({
      telegramId,
      data: tokens.action(rootAction),
      enabled: true,
    });
    const text = latestEdited(instructions.transport).text;
    expect(text).toContain("Synthetic prototype title");
    expect(text).toContain("Synthetic prototype instructions");
    expect(text).toContain("Prototype only");
    expect(text).toContain("no real transfer or charge is required");
    expect(text).not.toContain("Paid");
    expect(text).not.toContain("I paid");
    expect(text).not.toMatch(/verified/i);

    const buttons = flatButtons(instructions.transport);
    expect(buttons.some((button) => button.text.includes("Contact seller about this method"))).toBe(
      true,
    );
    expect(buttons.some((button) => button.text.includes("I paid"))).toBe(false);
  });

  it("keeps the dashboard binding by reference and reflects central edits after refresh", async () => {
    const appDb = asAppDb(testDb!.db);
    const { productId } = await seedProduct();
    const methodId = await seedMethod({
      adminLabel: "Reload method",
      enTitle: "Original central title",
      enInstructions: "Original central instructions",
    });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Stored button label",
    });

    const storedAction = await readProductAction(appDb, actionId);
    expect(storedAction).not.toBeNull();
    expect(storedAction!.paymentMethodId).toBe(methodId);
    expect(storedAction!.translations.en?.label).toBe("Stored button label");
    expect(storedAction!.translations.en?.templateBody).toBeNull();
    expect(storedAction!.translations.en?.menuText).toBeNull();

    const beforeEdit = await resolvePaymentMethodForAction(appDb, {
      productId,
      actionId,
      requestedLanguageId: enLangId,
      defaultLanguageId: enLangId,
    });
    expect(beforeEdit.status).toBe("ok");
    if (beforeEdit.status === "ok") {
      expect(beforeEdit.method.title).toBe("Original central title");
    }

    await editPaymentMethod(appDb, {
      id: methodId,
      adminLabel: "Reload method (edited)",
      translation: {
        languageId: enLangId,
        languageCode: "en",
        title: "Fresh central title",
        instructions: "Fresh central instructions",
      },
    });

    const afterReload = await readProductAction(appDb, actionId);
    expect(afterReload!.paymentMethodId).toBe(methodId);
    expect(afterReload!.translations.en?.label).toBe("Stored button label");
    expect(afterReload!.translations.en?.templateBody).toBeNull();

    const afterEdit = await resolvePaymentMethodForAction(appDb, {
      productId,
      actionId,
      requestedLanguageId: enLangId,
      defaultLanguageId: enLangId,
    });
    expect(afterEdit.status).toBe("ok");
    if (afterEdit.status === "ok") {
      expect(afterEdit.method.title).toBe("Fresh central title");
      expect(afterEdit.method.instructions).toBe("Fresh central instructions");
    }

    const instructions = await sendCallback({
      telegramId: nextTelegramId(),
      data: tokens.action(actionId),
      enabled: true,
    });
    expect(latestEdited(instructions.transport).text).toContain("Fresh central title");
    expect(latestEdited(instructions.transport).text).toContain(
      "Fresh central instructions",
    );
  });

  it("keeps the inquiry dedup index scoped to the product and customer", async () => {
    const { productId } = await seedProduct();
    const methodId = await seedMethod({ adminLabel: "Scope method" });
    const menuId = await seedMenu({ productId });
    const actionId = await seedPaymentAction({
      productId,
      parentActionId: menuId,
      methodId,
      enLabel: "Scope option",
    });
    const firstCustomer = nextTelegramId();
    const secondCustomer = nextTelegramId();

    await sendCallback({
      telegramId: firstCustomer,
      data: tokens.paymentContact(actionId),
      enabled: true,
    });
    await sendCallback({
      telegramId: secondCustomer,
      data: tokens.paymentContact(actionId),
      enabled: true,
    });

    const firstCustomerRecord = await getCustomerByTelegramId(
      asAppDb(testDb!.db),
      firstCustomer,
    );
    const secondCustomerRecord = await getCustomerByTelegramId(
      asAppDb(testDb!.db),
      secondCustomer,
    );
    expect(firstCustomerRecord).not.toBeNull();
    expect(secondCustomerRecord).not.toBeNull();

    const firstInquiries = await testDb!.db
      .select()
      .from(inquiry)
      .where(eq(inquiry.customerId, firstCustomerRecord!.id));
    const secondInquiries = await testDb!.db
      .select()
      .from(inquiry)
      .where(eq(inquiry.customerId, secondCustomerRecord!.id));
    expect(firstInquiries).toHaveLength(1);
    expect(secondInquiries).toHaveLength(1);
    expect(firstInquiries[0].productId).toBe(productId);
    expect(secondInquiries[0].productId).toBe(productId);
  });
});
