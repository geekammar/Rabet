import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  category,
  paymentMethod,
  product,
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
  initializeSettings,
  readPaymentMethod,
  readProductAction,
  togglePaymentMethodActive,
} from "@/lib/data";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import { handleTelegramWebhookRequest } from "@/lib/telegram/webhook";
import { tokens } from "@/lib/telegram/tokens";

const shouldRun = hasTestCluster();
let testDb: TestDatabase | null = null;
let defaultLangId: string;
let arabicLangId: string;
let testCategoryId: string;
let testProductId: string;

const TEST_BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const TEST_WEBHOOK_SECRET = "super-secret-test-token-value-32chars";

function createWebhookRequest(body: unknown): Request {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("payment_methods_suite");
  const appDb = asAppDb(testDb.db);

  // 1. Languages
  const en = await ensureLanguage(appDb, {
    code: "en",
    label: "English",
    textDirection: "ltr",
    isEnabled: true,
  });
  defaultLangId = en.id;

  const ar = await ensureLanguage(appDb, {
    code: "ar",
    label: "العربية",
    textDirection: "rtl",
    isEnabled: true,
  });
  arabicLangId = ar.id;

  // 2. Settings
  await initializeSettings(appDb, {
    defaultLanguageCode: "en",
    displayName: "Acme Payments Test Store",
    currency: "USD",
  });

  // 3. Category & Product
  const cat = await createCatalogCategory(appDb, {
    parentId: null,
    slug: "digital-goods",
    translations: [{ languageId: defaultLangId, name: "Digital Goods" }],
  });
  testCategoryId = cat.categoryId;

  const prod = await createCatalogProduct(appDb, {
    categoryId: testCategoryId,
    slug: "software-license",
    price: "49.00",
    translations: [
      { languageId: defaultLangId, name: "Software License" },
      { languageId: arabicLangId, name: "ترخيص البرنامج" },
    ],
  });
  testProductId = prod.productId;

  // Activate category and product so Telegram displays product card actions
  await testDb.db
    .update(category)
    .set({ isActive: true })
    .where(eq(category.id, testCategoryId));
  await testDb.db
    .update(product)
    .set({ isActive: true })
    .where(eq(product.id, testProductId));
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("Central Payment Methods — Creation, Editing, Toggling & Status", () => {
  it("creates a payment method with default disabled state and localized titles/instructions", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Bank Transfer (Manual)",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Bank Wire Transfer",
          instructions: "Transfer to IBAN: XX00112233. Reference your order number.",
        },
        {
          languageId: arabicLangId,
          languageCode: "ar",
          title: "التحويل البنكي",
          instructions: "قم بالتحويل إلى رقم الآيبان: XX00112233 مع إرفاق رقم الطلب.",
        },
      ],
    });

    expect(created.methodId).toBeDefined();

    // Verify in database: defaults to isActive = false
    const method = await readPaymentMethod(appDb, created.methodId);
    expect(method).not.toBeNull();
    expect(method!.adminLabel).toBe("Bank Transfer (Manual)");
    expect(method!.isActive).toBe(false);

    // Verify translations
    expect(method!.translations["en"]?.title).toBe("Bank Wire Transfer");
    expect(method!.translations["en"]?.instructions).toContain("IBAN: XX00112233");
    expect(method!.translations["ar"]?.title).toBe("التحويل البنكي");
    expect(method!.translations["ar"]?.instructions).toContain("رقم الآيبان");
  });

  it("edits a payment method's admin label and localized content", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Cash on Delivery",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "COD",
          instructions: "Pay cash upon delivery.",
        },
      ],
    });

    // Edit: update adminLabel and English instructions, add Arabic translation
    await editPaymentMethod(appDb, {
      id: created.methodId,
      adminLabel: "Cash on Delivery (Courier)",
      translation: {
        languageId: defaultLangId,
        languageCode: "en",
        title: "Cash on Handover",
        instructions: "Pay exact cash to courier upon arrival.",
      },
    });
    await editPaymentMethod(appDb, {
      id: created.methodId,
      translation: {
        languageId: arabicLangId,
        languageCode: "ar",
        title: "الدفع عند الاستلام",
        instructions: "الدفع نقداً للمندوب عند الاستلام.",
      },
    });

    const updated = await readPaymentMethod(appDb, created.methodId);
    expect(updated!.adminLabel).toBe("Cash on Delivery (Courier)");
    expect(updated!.translations["en"]?.title).toBe("Cash on Handover");
    expect(updated!.translations["en"]?.instructions).toContain("exact cash");
    expect(updated!.translations["ar"]?.title).toBe("الدفع عند الاستلام");
  });

  it("toggles active/disabled state accurately", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Toggle Test Method",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Toggle Method",
        },
      ],
    });

    const initial = await readPaymentMethod(appDb, created.methodId);
    expect(initial!.isActive).toBe(false);

    // Enable
    const enabled = await togglePaymentMethodActive(appDb, created.methodId, true);
    expect(enabled.method.isActive).toBe(true);
    const readEnabled = await readPaymentMethod(appDb, created.methodId);
    expect(readEnabled!.isActive).toBe(true);

    // Disable
    const disabled = await togglePaymentMethodActive(appDb, created.methodId, false);
    expect(disabled.method.isActive).toBe(false);
    const readDisabled = await readPaymentMethod(appDb, created.methodId);
    expect(readDisabled!.isActive).toBe(false);
  });

  it("atomic multilingual save: updates EN and AR drafts and adminLabel simultaneously", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Initial Multilingual Method",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Initial EN Title",
          instructions: "Initial EN Instructions",
        },
        {
          languageId: arabicLangId,
          languageCode: "ar",
          title: "عنوان ابتدائي",
          instructions: "تعليمات ابتدائية",
        },
      ],
    });

    // Save both EN and AR drafts together in one atomic call
    const result = await editPaymentMethod(appDb, {
      id: created.methodId,
      adminLabel: "Updated Multilingual Method",
      translations: [
        {
          languageCode: "en",
          title: "Saved EN Title",
          instructions: "Saved EN Instructions",
        },
        {
          languageCode: "ar",
          title: "عنوان محفوظ",
          instructions: "تعليمات محفوظة",
        },
      ],
    });

    expect(result.method.adminLabel).toBe("Updated Multilingual Method");
    expect(result.method.translations["en"]?.title).toBe("Saved EN Title");
    expect(result.method.translations["en"]?.instructions).toBe("Saved EN Instructions");
    expect(result.method.translations["ar"]?.title).toBe("عنوان محفوظ");
    expect(result.method.translations["ar"]?.instructions).toBe("تعليمات محفوظة");

    // Verify in database
    const stored = await readPaymentMethod(appDb, created.methodId);
    expect(stored!.adminLabel).toBe("Updated Multilingual Method");
    expect(stored!.translations["en"]?.title).toBe("Saved EN Title");
    expect(stored!.translations["ar"]?.title).toBe("عنوان محفوظ");
  });

  it("atomic multilingual save: failure in either language leaves both languages and shared fields unchanged", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Stable Method",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Original EN Title",
          instructions: "Original EN Instructions",
        },
        {
          languageId: arabicLangId,
          languageCode: "ar",
          title: "العنوان الأصلي",
          instructions: "التعليمات الأصلية",
        },
      ],
    });

    // Attempt save with valid EN draft and invalid AR draft (empty title)
    await expect(
      editPaymentMethod(appDb, {
        id: created.methodId,
        adminLabel: "Modified Method Admin Label",
        translations: [
          {
            languageCode: "en",
            title: "Changed EN Title That Must Not Persist",
            instructions: "Changed EN Instructions",
          },
          {
            languageCode: "ar",
            title: "   ", // Empty title fails validation
            instructions: "Modified AR instructions",
          },
        ],
      }),
    ).rejects.toThrow("Customer-facing title cannot be empty");

    // Verify database state is 100% unchanged
    const unchanged = await readPaymentMethod(appDb, created.methodId);
    expect(unchanged!.adminLabel).toBe("Stable Method");
    expect(unchanged!.translations["en"]?.title).toBe("Original EN Title");
    expect(unchanged!.translations["en"]?.instructions).toBe("Original EN Instructions");
    expect(unchanged!.translations["ar"]?.title).toBe("العنوان الأصلي");
    expect(unchanged!.translations["ar"]?.instructions).toBe("التعليمات الأصلية");
  });

  it("partial update: title-only update preserves existing instructions", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Partial Title Method",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Version 1 Title",
          instructions: "Preserved Instructions Text",
        },
      ],
    });

    // Update title only (omitting instructions)
    await editPaymentMethod(appDb, {
      id: created.methodId,
      translations: [
        {
          languageCode: "en",
          title: "Version 2 Title",
        },
      ],
    });

    const stored = await readPaymentMethod(appDb, created.methodId);
    expect(stored!.translations["en"]?.title).toBe("Version 2 Title");
    expect(stored!.translations["en"]?.instructions).toBe("Preserved Instructions Text");
  });

  it("partial update: instructions-only update works and preserves existing title", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Partial Instructions Method",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Preserved Title",
          instructions: "Old instructions",
        },
      ],
    });

    // Update instructions only (omitting title)
    await editPaymentMethod(appDb, {
      id: created.methodId,
      translations: [
        {
          languageCode: "en",
          instructions: "Brand new instructions text",
        },
      ],
    });

    const stored = await readPaymentMethod(appDb, created.methodId);
    expect(stored!.translations["en"]?.title).toBe("Preserved Title");
    expect(stored!.translations["en"]?.instructions).toBe("Brand new instructions text");
  });

  it("partial update: explicit empty string instructions clears instructions", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Clear Instructions Method",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Method Title",
          instructions: "Instructions that will be cleared",
        },
      ],
    });

    // Explicit empty instructions
    await editPaymentMethod(appDb, {
      id: created.methodId,
      translations: [
        {
          languageCode: "en",
          instructions: "",
        },
      ],
    });

    const stored = await readPaymentMethod(appDb, created.methodId);
    expect(stored!.translations["en"]?.title).toBe("Method Title");
    expect(stored!.translations["en"]?.instructions).toBeNull();
  });

  it("partial update: empty optional translation tab does not block a valid save", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createPaymentMethod(appDb, {
      adminLabel: "Single Language Method",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "English Only Title",
          instructions: "English Only Instructions",
        },
      ],
    });

    // Send valid EN draft with completely empty optional AR draft
    const res = await editPaymentMethod(appDb, {
      id: created.methodId,
      adminLabel: "Single Language Method Updated",
      translations: [
        {
          languageCode: "en",
          title: "English Only Title V2",
          instructions: "English Only Instructions V2",
        },
        {
          languageCode: "ar",
          title: "",
          instructions: "",
        },
      ],
    });

    expect(res.method.adminLabel).toBe("Single Language Method Updated");
    expect(res.method.translations["en"]?.title).toBe("English Only Title V2");
    expect(res.method.translations["ar"]).toBeUndefined();
  });
});

describe.skipIf(!shouldRun)("Product Action Binding — PAYMENT_METHOD Button Type", () => {
  it("binds a PAYMENT_METHOD button via typed reference without copying texts", async () => {
    const appDb = asAppDb(testDb!.db);

    const method = await createPaymentMethod(appDb, {
      adminLabel: "Card via Terminal",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Debit/Credit Card",
          instructions: "Card instructions centrally defined.",
        },
      ],
    });

    // Create inactive PAYMENT_METHOD button
    const btn = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "PAYMENT_METHOD",
      isActive: false,
      paymentMethodId: method.methodId,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Pay with Card",
        },
      ],
    });

    expect(btn.actionId).toBeDefined();

    const storedAction = await readProductAction(appDb, btn.actionId);
    expect(storedAction).not.toBeNull();
    expect(storedAction!.actionType).toBe("PAYMENT_METHOD");
    expect(storedAction!.paymentMethodId).toBe(method.methodId);
    // Verified: stored button translation only contains button label; text is NOT duplicated into button
    expect(storedAction!.translations["en"]?.label).toBe("Pay with Card");
    expect(storedAction!.translations["en"]?.templateBody).toBeNull();
    expect(storedAction!.translations["en"]?.menuText).toBeNull();
  });

  it("supports two distinct buttons sharing the same central payment method", async () => {
    const appDb = asAppDb(testDb!.db);

    const sharedMethod = await createPaymentMethod(appDb, {
      adminLabel: "Shared Crypto USDT",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "USDT Transfer",
          instructions: "Send USDT TRC20 to address TXYZ...",
        },
      ],
    });

    // Button 1 on test product
    const btn1 = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "PAYMENT_METHOD",
      isActive: false,
      paymentMethodId: sharedMethod.methodId,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Pay with USDT",
        },
      ],
    });

    // Button 2 on test product
    const btn2 = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "PAYMENT_METHOD",
      isActive: false,
      paymentMethodId: sharedMethod.methodId,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Crypto Payment",
        },
      ],
    });

    const b1 = await readProductAction(appDb, btn1.actionId);
    const b2 = await readProductAction(appDb, btn2.actionId);

    expect(b1!.paymentMethodId).toBe(sharedMethod.methodId);
    expect(b2!.paymentMethodId).toBe(sharedMethod.methodId);
    expect(b1!.id).not.toBe(b2!.id);

    // Edit propagation: Updating the central method updates preview for both buttons
    await editPaymentMethod(appDb, {
      id: sharedMethod.methodId,
      adminLabel: "Shared Crypto USDT (ERC20/TRC20)",
      translation: {
        languageId: defaultLangId,
        languageCode: "en",
        title: "Multi-Chain USDT Transfer",
        instructions: "Send to TRC20 or ERC20 address with txid.",
      },
    });

    // Central method resolved content updated
    const freshMethod = await readPaymentMethod(appDb, sharedMethod.methodId);
    expect(freshMethod!.translations["en"]?.title).toBe("Multi-Chain USDT Transfer");
    expect(freshMethod!.translations["en"]?.instructions).toContain("TRC20 or ERC20");

    // Both buttons still point to the same central method
    const b1After = await readProductAction(appDb, btn1.actionId);
    const b2After = await readProductAction(appDb, btn2.actionId);
    expect(b1After!.paymentMethodId).toBe(sharedMethod.methodId);
    expect(b2After!.paymentMethodId).toBe(sharedMethod.methodId);
  });

  it("disabling a payment method preserves button references and indicates disabled status", async () => {
    const appDb = asAppDb(testDb!.db);

    const method = await createPaymentMethod(appDb, {
      adminLabel: "Paypal Personal",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "PayPal",
          instructions: "Send payment to paypal@example.com",
        },
      ],
    });

    // Enable method first
    await togglePaymentMethodActive(appDb, method.methodId, true);

    const btn = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "PAYMENT_METHOD",
      isActive: false,
      paymentMethodId: method.methodId,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "PayPal Checkout",
        },
      ],
    });

    // Now disable the payment method
    await togglePaymentMethodActive(appDb, method.methodId, false);

    // Button reference is preserved
    const btnRecord = await readProductAction(appDb, btn.actionId);
    expect(btnRecord!.paymentMethodId).toBe(method.methodId);

    // Method status is disabled
    const methodRecord = await readPaymentMethod(appDb, method.methodId);
    expect(methodRecord!.isActive).toBe(false);
  });

  it("rejects creating or activating a PAYMENT_METHOD button with invalid or non-existent paymentMethodId", async () => {
    const appDb = asAppDb(testDb!.db);
    const fakeMethodId = "00000000-0000-0000-0000-000000000999";

    // Rejection on non-existent reference
    await expect(
      createProductAction(appDb, {
        productId: testProductId,
        actionType: "PAYMENT_METHOD",
        isActive: false,
        paymentMethodId: fakeMethodId,
        translations: [
          {
            languageId: defaultLangId,
            languageCode: "en",
            label: "Invalid Target",
          },
        ],
      }),
    ).rejects.toThrow("Referenced payment method does not exist");

    // Rejection on activating without target
    await expect(
      createProductAction(appDb, {
        productId: testProductId,
        actionType: "PAYMENT_METHOD",
        isActive: true,
        paymentMethodId: null,
        translations: [
          {
            languageId: defaultLangId,
            languageCode: "en",
            label: "Missing Target Active",
          },
        ],
      }),
    ).rejects.toThrow("payment method target is required before activating");
  });

  it("nullifies paymentMethodId on action when referenced method is deleted (onDelete set null)", async () => {
    const appDb = asAppDb(testDb!.db);

    const method = await createPaymentMethod(appDb, {
      adminLabel: "Temporary Payment Option",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Temporary",
        },
      ],
    });

    const btn = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "PAYMENT_METHOD",
      isActive: false,
      paymentMethodId: method.methodId,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Temporary Pay",
        },
      ],
    });

    expect(btn.actionId).toBeDefined();

    // Delete paymentMethod directly
    await testDb!.db.delete(paymentMethod).where(eq(paymentMethod.id, method.methodId));

    // Button still exists, but paymentMethodId is set to null
    const btnAfter = await readProductAction(appDb, btn.actionId);
    expect(btnAfter).not.toBeNull();
    expect(btnAfter!.paymentMethodId).toBeNull();
  });
});

describe.skipIf(!shouldRun)("Telegram Guardrails — Keyboard Exclusion & Safe Execution Rejection", () => {
  it("excludes PAYMENT_METHOD actions from Telegram product keyboard", async () => {
    const appDb = asAppDb(testDb!.db);
    const fakeTransport = createFakeTelegramTransport();

    // Create an active payment method
    const method = await createPaymentMethod(appDb, {
      adminLabel: "Direct Bank",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Direct Bank",
        },
      ],
    });
    await togglePaymentMethodActive(appDb, method.methodId, true);

    // Create an active SHOW_DETAILS button
    await createProductAction(appDb, {
      productId: testProductId,
      actionType: "SHOW_DETAILS",
      isActive: true,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "View Details",
        },
      ],
    });

    // Create an active PAYMENT_METHOD button
    await createProductAction(appDb, {
      productId: testProductId,
      actionType: "PAYMENT_METHOD",
      isActive: true,
      paymentMethodId: method.methodId,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Pay Now",
        },
      ],
    });

    // Customer opens product via webhook callback: p:<productId>
    const req = createWebhookRequest({
      update_id: 1001,
      callback_query: {
        id: "cb_product_view",
        from: {
          id: 99901,
          is_bot: false,
          first_name: "Customer",
        },
        message: {
          message_id: 501,
          chat: { id: 99901, type: "private" },
          text: "Previous",
        },
        data: tokens.product(testProductId),
      },
    });

    const res = await handleTelegramWebhookRequest(req, {
      db: appDb,
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

    expect(res.status).toBe(200);
    expect(fakeTransport.editedMessages).toHaveLength(1);

    const edited = fakeTransport.editedMessages[0];
    const inlineKeyboard = edited.replyMarkup?.inline_keyboard ?? [];
    const flattenedButtons = inlineKeyboard.flat();

    // SHOW_DETAILS button is present
    expect(flattenedButtons.some((b) => b.text === "View Details")).toBe(true);

    // PAYMENT_METHOD button ("Pay Now") is explicitly EXCLUDED from Telegram inline keyboard
    expect(flattenedButtons.some((b) => b.text === "Pay Now")).toBe(false);
  });

  it("safely rejects execution of PAYMENT_METHOD if invoked via forged callback query", async () => {
    const appDb = asAppDb(testDb!.db);
    const fakeTransport = createFakeTelegramTransport();

    const method = await createPaymentMethod(appDb, {
      adminLabel: "Offline Wire",
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          title: "Offline Wire",
        },
      ],
    });
    await togglePaymentMethodActive(appDb, method.methodId, true);

    const pmBtn = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "PAYMENT_METHOD",
      isActive: true,
      paymentMethodId: method.methodId,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Pay Wire",
        },
      ],
    });

    // Malicious or crafted callback invoking action token: a:<actionId>
    const req = createWebhookRequest({
      update_id: 1002,
      callback_query: {
        id: "cb_forged_pay",
        from: {
          id: 99902,
          is_bot: false,
          first_name: "Attacker",
        },
        message: {
          message_id: 502,
          chat: { id: 99902, type: "private" },
          text: "Previous",
        },
        data: tokens.action(pmBtn.actionId),
      },
    });

    const res = await handleTelegramWebhookRequest(req, {
      db: appDb,
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

    expect(res.status).toBe(200);

    // Verified: Callback query is acknowledged cleanly
    expect(fakeTransport.answeredCallbacks).toHaveLength(1);
    expect(fakeTransport.answeredCallbacks[0].callbackQueryId).toBe("cb_forged_pay");

    // Verified: The message text returned is ui.optionUnavailable ("This option is no longer available.")
    expect(fakeTransport.editedMessages).toHaveLength(1);
    const edited = fakeTransport.editedMessages[0];
    expect(edited.text).toContain("This option is no longer available.");

    // Verified: Navigation keyboard with Back/Home is rendered safely
    const buttons = (edited.replyMarkup?.inline_keyboard ?? []).flat();
    expect(buttons.some((b) => b.text.includes("Back") || b.text.includes("Home"))).toBe(true);

    // Verified: NO live payment routes, orders, or external calls made
    expect(fakeTransport.sentMessages).toHaveLength(0);
  });
});
