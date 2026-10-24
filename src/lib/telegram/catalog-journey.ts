import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  category,
  categoryTranslation,
  language,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
} from "@/db/schema";
import { interpolateTemplate } from "@/lib/bot-content/placeholders";
import {
  getCustomerByTelegramId,
  readSettings,
  resolveMessageText,
  setCustomerSelectedLanguage,
  upsertCustomer,
} from "@/lib/data";
import { parseToken, tokens } from "./tokens";
import type {
  TelegramCallbackQuery,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramTransport,
  TelegramUser,
} from "./types";

export const TELEGRAM_MENU_PAGE_SIZE = 10;
export const MAX_SAFEGUARD_DEPTH = 64;

interface ResolvedLanguageContext {
  id: string;
  code: string;
  label: string;
  isRtl: boolean;
}

function getLocalizedUiStrings(isRtl: boolean) {
  if (isRtl) {
    return {
      back: "◀ رجوع",
      home: "🏠 الرئيسية",
      returnToProduct: "📦 العودة إلى المنتج",
      prevPage: "◀ السابق",
      nextPage: "التالي ▶",
      priceLabel: "السعر:",
      categoryUnavailable: "هذا القسم غير متاح حالياً.",
      productUnavailable: "هذا المنتج غير متاح حالياً.",
      optionUnavailable: "هذا الخيار غير متاح حالياً.",
      noDetails: "لا توجد تفاصيل إضافية لهذا المنتج.",
      actionNotSupported: "هذا الإجراء غير مدعوم حالياً في هذا الإصدار.",
      storeUnavailable: "المتجر غير متاح حالياً.",
      selectLanguagePrompt: "يرجى اختيار اللغة / Please select your language:",
    };
  }
  return {
    back: "◀ Back",
    home: "🏠 Home",
    returnToProduct: "📦 Return to Product",
    prevPage: "◀ Prev",
    nextPage: "Next ▶",
    priceLabel: "Price:",
    categoryUnavailable: "This category is no longer available.",
    productUnavailable: "This product is no longer available.",
    optionUnavailable: "This option is no longer available.",
    noDetails: "No additional details available for this product.",
    actionNotSupported: "This action is not yet supported in this version.",
    storeUnavailable: "This store is currently unavailable.",
    selectLanguagePrompt: "Please select your language / يرجى اختيار اللغة:",
  };
}

/**
 * Resolves the effective language for a customer interaction.
 */
async function resolveCustomerLanguageContext(
  db: Database,
  customerTelegramId: number,
  fallbackDefaultLangId: string,
): Promise<ResolvedLanguageContext> {
  const customerRecord = await getCustomerByTelegramId(db, customerTelegramId);

  const enabledLanguages = await db
    .select({
      id: language.id,
      code: language.code,
      label: language.label,
      textDirection: language.textDirection,
    })
    .from(language)
    .where(eq(language.isEnabled, true));

  let matchedLang = enabledLanguages.find(
    (l) => customerRecord?.selectedLanguageId && l.id === customerRecord.selectedLanguageId,
  );

  if (!matchedLang) {
    matchedLang = enabledLanguages.find((l) => l.id === fallbackDefaultLangId);
  }

  if (!matchedLang && enabledLanguages.length > 0) {
    matchedLang = enabledLanguages[0];
  }

  if (!matchedLang) {
    return {
      id: fallbackDefaultLangId,
      code: "en",
      label: "English",
      isRtl: false,
    };
  }

  return {
    id: matchedLang.id,
    code: matchedLang.code,
    label: matchedLang.label,
    isRtl: matchedLang.textDirection === "rtl",
  };
}

/**
 * Safe Unicode-aware message text bounding to Telegram's 4096-character limit.
 * Never splits UTF-16 surrogate pairs.
 */
export function boundMessageText(text: string, maxLen = 4096): string {
  if (text.length <= maxLen) return text;
  let end = maxLen;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

/**
 * Checks category existence, active flag, and whether all ancestors are active and not soft-deleted.
 */
async function isCategoryHierarchyActive(
  db: Database,
  categoryId: string,
): Promise<{ valid: boolean; categoryRow?: typeof category.$inferSelect }> {
  let currentId: string | null = categoryId;
  let depth = 0;
  let targetRow: typeof category.$inferSelect | undefined;

  const visited = new Set<string>();

  while (currentId !== null && depth < MAX_SAFEGUARD_DEPTH) {
    if (visited.has(currentId)) {
      return { valid: false }; // Cycle detected
    }
    visited.add(currentId);

    const [row] = await db
      .select()
      .from(category)
      .where(and(eq(category.id, currentId), isNull(category.deletedAt)))
      .limit(1);

    if (!row || !row.isActive) {
      return { valid: false };
    }

    if (currentId === categoryId) {
      targetRow = row;
    }

    currentId = row.parentId;
    depth += 1;
  }

  // If loop exited with depth safeguard while ancestors remain unresolved, fail closed.
  if (currentId !== null || !targetRow) {
    return { valid: false };
  }

  return { valid: true, categoryRow: targetRow };
}

/**
 * Checks product existence, active flag, and whether its category hierarchy is fully active.
 */
async function isProductHierarchyActive(
  db: Database,
  productId: string,
): Promise<{ valid: boolean; productRow?: typeof product.$inferSelect }> {
  const [prod] = await db
    .select()
    .from(product)
    .where(and(eq(product.id, productId), isNull(product.deletedAt)))
    .limit(1);

  if (!prod || !prod.isActive) {
    return { valid: false };
  }

  const categoryCheck = await isCategoryHierarchyActive(db, prod.categoryId);
  if (!categoryCheck.valid) {
    return { valid: false };
  }

  return { valid: true, productRow: prod };
}

/**
 * Checks action existence, active flag, ancestor actions active and OPEN_SUBMENU,
 * and product/category hierarchy fully active.
 */
async function isActionHierarchyActive(
  db: Database,
  actionId: string,
): Promise<{ valid: boolean; actionRow?: typeof productAction.$inferSelect }> {
  let currentId: string | null = actionId;
  let depth = 0;
  let targetRow: typeof productAction.$inferSelect | undefined;

  const visited = new Set<string>();

  while (currentId !== null && depth < MAX_SAFEGUARD_DEPTH) {
    if (visited.has(currentId)) {
      return { valid: false };
    }
    visited.add(currentId);

    const [row] = await db
      .select()
      .from(productAction)
      .where(eq(productAction.id, currentId))
      .limit(1);

    if (!row || !row.isActive) {
      return { valid: false };
    }

    if (currentId === actionId) {
      targetRow = row;
    } else {
      // All ancestors must be OPEN_SUBMENU
      if (row.actionType !== "OPEN_SUBMENU") {
        return { valid: false };
      }
    }

    currentId = row.parentActionId;
    depth += 1;
  }

  // If loop exited with depth safeguard while ancestors remain unresolved, fail closed.
  if (currentId !== null || !targetRow) {
    return { valid: false };
  }

  // Check product hierarchy
  const productCheck = await isProductHierarchyActive(db, targetRow.productId);
  if (!productCheck.valid) {
    return { valid: false };
  }

  return { valid: true, actionRow: targetRow };
}

async function sendOrThrow(
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  },
): Promise<void> {
  const boundedParams = {
    ...params,
    text: boundMessageText(params.text),
  };
  const res = await transport.sendMessage(boundedParams);
  if (!res.ok) {
    throw new Error(res.error ?? "Failed to send Telegram message");
  }
}

async function editOrThrow(
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    messageId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  },
): Promise<void> {
  const boundedParams = {
    ...params,
    text: boundMessageText(params.text),
  };
  const res = await transport.editMessageText(boundedParams);
  if (!res.ok) {
    // Only fall back to sendMessage if the message was not editable
    if (res.errorKind === "not_editable") {
      const sendRes = await transport.sendMessage({
        chatId: boundedParams.chatId,
        text: boundedParams.text,
        replyMarkup: boundedParams.replyMarkup,
      });
      if (!sendRes.ok) {
        throw new Error(sendRes.error ?? "Failed to send replacement Telegram message");
      }
      return;
    }
    throw new Error(res.error ?? "Failed to edit Telegram message");
  }
}

/**
 * Renders the Root Catalog view (Welcome message + root categories).
 */
async function renderRootCatalog(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  user: TelegramUser,
  messageIdToEdit?: number,
  page = 1,
): Promise<void> {
  const settings = await readSettings(db);
  if (!settings) {
    await sendOrThrow(transport, {
      chatId,
      text: "This store is currently unavailable.",
    });
    return;
  }

  const langContext = await resolveCustomerLanguageContext(
    db,
    user.id,
    settings.defaultLanguageId,
  );
  const ui = getLocalizedUiStrings(langContext.isRtl);

  // Resolve welcome text
  let welcomeBody = `Welcome to ${settings.displayName}!`;
  try {
    const resolved = await resolveMessageText(db, {
      templateKey: "bot_welcome",
      languageCode: langContext.code,
    });
    if (resolved.status === "resolved") {
      welcomeBody = interpolateTemplate(resolved.body, {
        store_name: settings.displayName,
      });
    }
  } catch {
    // Fall back to simple greeting
  }

  // Read root categories with deterministic tie-breaking
  const rootCategories = await db
    .select({
      id: category.id,
      slug: category.slug,
      sortOrder: category.sortOrder,
    })
    .from(category)
    .where(
      and(
        isNull(category.parentId),
        eq(category.isActive, true),
        isNull(category.deletedAt),
      ),
    )
    .orderBy(asc(category.sortOrder), asc(category.id));

  const totalPages = Math.max(1, Math.ceil(rootCategories.length / TELEGRAM_MENU_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * TELEGRAM_MENU_PAGE_SIZE;
  const pageCategories = rootCategories.slice(startIndex, startIndex + TELEGRAM_MENU_PAGE_SIZE);

  // Get translations for root categories
  const keyboard: TelegramInlineKeyboardButton[][] = [];

  for (const cat of pageCategories) {
    const translations = await db
      .select({
        languageId: categoryTranslation.languageId,
        name: categoryTranslation.name,
      })
      .from(categoryTranslation)
      .where(eq(categoryTranslation.categoryId, cat.id));

    const preferred = translations.find((t) => t.languageId === langContext.id);
    const fallback = translations.find((t) => t.languageId === settings.defaultLanguageId);
    const catName = preferred?.name ?? fallback?.name ?? cat.slug;

    keyboard.push([
      {
        text: catName,
        callback_data: tokens.category(cat.id),
      },
    ]);
  }

  // Pagination row if multiple pages
  if (totalPages > 1) {
    const navButtons: TelegramInlineKeyboardButton[] = [];
    if (currentPage > 1) {
      navButtons.push({
        text: ui.prevPage,
        callback_data: tokens.rootCategory(currentPage - 1),
      });
    }
    if (currentPage < totalPages) {
      navButtons.push({
        text: ui.nextPage,
        callback_data: tokens.rootCategory(currentPage + 1),
      });
    }
    keyboard.push(navButtons);
  }

  const replyMarkup: TelegramInlineKeyboardMarkup = { inline_keyboard: keyboard };

  if (messageIdToEdit) {
    await editOrThrow(transport, {
      chatId,
      messageId: messageIdToEdit,
      text: welcomeBody,
      replyMarkup,
    });
  } else {
    await sendOrThrow(transport, { chatId, text: welcomeBody, replyMarkup });
  }
}

/**
 * Handles /start command in a private chat.
 */
export async function handleStartCommand(
  db: Database,
  transport: TelegramTransport,
  message: TelegramMessage,
): Promise<void> {
  const from = message.from;
  if (!from) return;

  const customerRecord = await upsertCustomer(db, {
    telegramId: from.id,
    telegramUsername: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    languageCode: from.language_code ?? null,
  });

  if (customerRecord.isBlocked) return;

  const settings = await readSettings(db);
  if (!settings) {
    await sendOrThrow(transport, {
      chatId: message.chat.id,
      text: "This store is currently unavailable.",
    });
    return;
  }

  // Get all enabled languages
  const enabledLanguages = await db
    .select({
      id: language.id,
      code: language.code,
      label: language.label,
    })
    .from(language)
    .where(eq(language.isEnabled, true));

  if (enabledLanguages.length === 0) {
    await sendOrThrow(transport, {
      chatId: message.chat.id,
      text: "This store is currently unavailable.",
    });
    return;
  }

  // Language choice required if askForLanguage is true, > 1 enabled languages, and no valid language selected
  const hasValidSelected =
    customerRecord.selectedLanguageId &&
    enabledLanguages.some((l) => l.id === customerRecord.selectedLanguageId);

  if (settings.askForLanguage && enabledLanguages.length > 1 && !hasValidSelected) {
    const langKeyboard: TelegramInlineKeyboardButton[][] = enabledLanguages.map((l) => [
      {
        text: l.label,
        callback_data: tokens.lang(l.code),
      },
    ]);

    await sendOrThrow(transport, {
      chatId: message.chat.id,
      text: "Please select your language / يرجى اختيار اللغة:",
      replyMarkup: { inline_keyboard: langKeyboard },
    });
    return;
  }

  // Otherwise, proceed to root catalog
  await renderRootCatalog(db, transport, message.chat.id, from);
}

/**
 * Handles callback queries for catalog browsing and product actions.
 */
export async function handleCallbackQuery(
  db: Database,
  transport: TelegramTransport,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  // Acknowledge callback immediately to clear loading indicator
  await transport.answerCallbackQuery({ callbackQueryId: callbackQuery.id });

  const message = callbackQuery.message;
  if (!message) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const user = callbackQuery.from;

  const customerRecord = await upsertCustomer(db, {
    telegramId: user.id,
    telegramUsername: user.username ?? null,
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    languageCode: user.language_code ?? null,
  });

  if (customerRecord.isBlocked) return;

  const settings = await readSettings(db);
  if (!settings) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: "This store is currently unavailable.",
    });
    return;
  }

  const parsed = parseToken(callbackQuery.data);

  // 1. Language selection callback: lang:<code>
  if (parsed.type === "lang") {
    const [targetLang] = await db
      .select({ id: language.id, isEnabled: language.isEnabled })
      .from(language)
      .where(eq(language.code, parsed.code))
      .limit(1);

    if (targetLang && targetLang.isEnabled) {
      await setCustomerSelectedLanguage(db, user.id, targetLang.id);
    }

    await renderRootCatalog(db, transport, chatId, user, messageId);
    return;
  }

  // Resolve language context for subsequent rendering
  const langContext = await resolveCustomerLanguageContext(
    db,
    user.id,
    settings.defaultLanguageId,
  );
  const ui = getLocalizedUiStrings(langContext.isRtl);

  // 2. Home or Root callback
  if (parsed.type === "home") {
    await renderRootCatalog(db, transport, chatId, user, messageId, 1);
    return;
  }

  if (parsed.type === "root") {
    await renderRootCatalog(db, transport, chatId, user, messageId, parsed.page);
    return;
  }

  // 3. Category callback: c:<categoryId>[:<page>]
  if (parsed.type === "category") {
    const categoryCheck = await isCategoryHierarchyActive(db, parsed.categoryId);
    if (!categoryCheck.valid || !categoryCheck.categoryRow) {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.categoryUnavailable,
        replyMarkup: {
          inline_keyboard: [[{ text: ui.home, callback_data: tokens.home() }]],
        },
      });
      return;
    }

    const catRow = categoryCheck.categoryRow;

    // Load translations
    const catTranslations = await db
      .select({
        languageId: categoryTranslation.languageId,
        name: categoryTranslation.name,
        description: categoryTranslation.description,
      })
      .from(categoryTranslation)
      .where(eq(categoryTranslation.categoryId, catRow.id));

    const preferred = catTranslations.find((t) => t.languageId === langContext.id);
    const fallback = catTranslations.find((t) => t.languageId === settings.defaultLanguageId);
    const catName = preferred?.name ?? fallback?.name ?? catRow.slug;
    const catDesc = preferred?.description ?? fallback?.description ?? null;

    let bodyText = catName;
    if (catDesc && catDesc.trim().length > 0) {
      bodyText += `\n\n${catDesc.trim()}`;
    }

    // Active subcategories with deterministic tie-breaking
    const subcategories = await db
      .select({
        id: category.id,
        slug: category.slug,
        sortOrder: category.sortOrder,
      })
      .from(category)
      .where(
        and(
          eq(category.parentId, catRow.id),
          eq(category.isActive, true),
          isNull(category.deletedAt),
        ),
      )
      .orderBy(asc(category.sortOrder), asc(category.id));

    // Active products with deterministic tie-breaking
    const productsList = await db
      .select({
        id: product.id,
        slug: product.slug,
        price: product.price,
        sortOrder: product.sortOrder,
      })
      .from(product)
      .where(
        and(
          eq(product.categoryId, catRow.id),
          eq(product.isActive, true),
          isNull(product.deletedAt),
        ),
      )
      .orderBy(asc(product.sortOrder), asc(product.id));

    // Combine items for deterministic pagination
    const allItems: Array<
      | { type: "subcat"; id: string; slug: string }
      | { type: "product"; id: string; slug: string; price: string }
    > = [
      ...subcategories.map((s) => ({ type: "subcat" as const, id: s.id, slug: s.slug })),
      ...productsList.map((p) => ({
        type: "product" as const,
        id: p.id,
        slug: p.slug,
        price: p.price,
      })),
    ];

    const totalPages = Math.max(1, Math.ceil(allItems.length / TELEGRAM_MENU_PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, parsed.page), totalPages);
    const startIndex = (currentPage - 1) * TELEGRAM_MENU_PAGE_SIZE;
    const pageItems = allItems.slice(startIndex, startIndex + TELEGRAM_MENU_PAGE_SIZE);

    const keyboard: TelegramInlineKeyboardButton[][] = [];

    for (const item of pageItems) {
      if (item.type === "subcat") {
        const trans = await db
          .select({
            languageId: categoryTranslation.languageId,
            name: categoryTranslation.name,
          })
          .from(categoryTranslation)
          .where(eq(categoryTranslation.categoryId, item.id));

        const pTrans = trans.find((t) => t.languageId === langContext.id);
        const fTrans = trans.find((t) => t.languageId === settings.defaultLanguageId);
        const subName = pTrans?.name ?? fTrans?.name ?? item.slug;

        keyboard.push([
          {
            text: subName,
            callback_data: tokens.category(item.id),
          },
        ]);
      } else {
        const trans = await db
          .select({
            languageId: productTranslation.languageId,
            name: productTranslation.name,
          })
          .from(productTranslation)
          .where(eq(productTranslation.productId, item.id));

        const pTrans = trans.find((t) => t.languageId === langContext.id);
        const fTrans = trans.find((t) => t.languageId === settings.defaultLanguageId);
        const prodName = pTrans?.name ?? fTrans?.name ?? item.slug;

        keyboard.push([
          {
            text: prodName,
            callback_data: tokens.product(item.id),
          },
        ]);
      }
    }

    // Pagination row
    if (totalPages > 1) {
      const navButtons: TelegramInlineKeyboardButton[] = [];
      if (currentPage > 1) {
        navButtons.push({
          text: ui.prevPage,
          callback_data: tokens.category(catRow.id, currentPage - 1),
        });
      }
      if (currentPage < totalPages) {
        navButtons.push({
          text: ui.nextPage,
          callback_data: tokens.category(catRow.id, currentPage + 1),
        });
      }
      keyboard.push(navButtons);
    }

    // Navigation row: Back & Home
    const backTarget = catRow.parentId ? tokens.category(catRow.parentId) : tokens.home();
    keyboard.push([
      { text: ui.back, callback_data: backTarget },
      { text: ui.home, callback_data: tokens.home() },
    ]);

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: bodyText,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // 4. Product card callback: p:<productId>
  if (parsed.type === "product") {
    const productCheck = await isProductHierarchyActive(db, parsed.productId);
    if (!productCheck.valid || !productCheck.productRow) {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.productUnavailable,
        replyMarkup: {
          inline_keyboard: [[{ text: ui.home, callback_data: tokens.home() }]],
        },
      });
      return;
    }

    const prodRow = productCheck.productRow;

    // Load translations
    const prodTranslations = await db
      .select({
        languageId: productTranslation.languageId,
        name: productTranslation.name,
        description: productTranslation.description,
      })
      .from(productTranslation)
      .where(eq(productTranslation.productId, prodRow.id));

    const preferred = prodTranslations.find((t) => t.languageId === langContext.id);
    const fallback = prodTranslations.find((t) => t.languageId === settings.defaultLanguageId);
    const prodName = preferred?.name ?? fallback?.name ?? prodRow.slug;
    const prodDesc = preferred?.description ?? fallback?.description ?? null;

    let bodyText = prodName;
    if (prodDesc && prodDesc.trim().length > 0) {
      bodyText += `\n\n${prodDesc.trim()}`;
    }
    // Exact decimal price display without floating-point conversion
    bodyText += `\n\n${ui.priceLabel} ${prodRow.price} ${settings.currency}`;

    // Root product actions with deterministic tie-breaking
    const rootActions = await db
      .select({
        id: productAction.id,
        actionType: productAction.actionType,
        sortOrder: productAction.sortOrder,
      })
      .from(productAction)
      .where(
        and(
          eq(productAction.productId, prodRow.id),
          isNull(productAction.parentActionId),
          eq(productAction.isActive, true),
        ),
      )
      .orderBy(asc(productAction.sortOrder), asc(productAction.id));

    const keyboard: TelegramInlineKeyboardButton[][] = [];

    for (const act of rootActions) {
      const trans = await db
        .select({
          languageId: productActionTranslation.languageId,
          label: productActionTranslation.label,
        })
        .from(productActionTranslation)
        .where(eq(productActionTranslation.actionId, act.id));

      const pTrans = trans.find((t) => t.languageId === langContext.id);
      const fTrans = trans.find((t) => t.languageId === settings.defaultLanguageId);
      const label = pTrans?.label ?? fTrans?.label ?? act.actionType;

      keyboard.push([
        {
          text: label,
          callback_data: tokens.action(act.id),
        },
      ]);
    }

    // Navigation row: Back to category & Home
    keyboard.push([
      { text: ui.back, callback_data: tokens.category(prodRow.categoryId) },
      { text: ui.home, callback_data: tokens.home() },
    ]);

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: bodyText,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // 5. Back from action: b:<actionId>
  if (parsed.type === "back") {
    const [act] = await db
      .select({
        id: productAction.id,
        productId: productAction.productId,
        parentActionId: productAction.parentActionId,
      })
      .from(productAction)
      .where(eq(productAction.id, parsed.actionId))
      .limit(1);

    if (!act) {
      await renderRootCatalog(db, transport, chatId, user, messageId);
      return;
    }

    if (act.parentActionId) {
      // Re-route to parent action submenu
      callbackQuery.data = tokens.action(act.parentActionId);
      await handleCallbackQuery(db, transport, callbackQuery);
    } else {
      // Re-route to product card
      callbackQuery.data = tokens.product(act.productId);
      await handleCallbackQuery(db, transport, callbackQuery);
    }
    return;
  }

  // 6. Submenu pagination: m:<actionId>:<page>
  if (parsed.type === "submenu") {
    // Re-route to action handler with page
    callbackQuery.data = tokens.action(parsed.actionId);
    await handleActionExecution(
      db,
      transport,
      chatId,
      messageId,
      user,
      parsed.actionId,
      settings,
      langContext,
      ui,
      parsed.page,
    );
    return;
  }

  // 7. Action execution: a:<actionId>
  if (parsed.type === "action") {
    await handleActionExecution(
      db,
      transport,
      chatId,
      messageId,
      user,
      parsed.actionId,
      settings,
      langContext,
      ui,
      1,
    );
    return;
  }

  // Fallback for unknown tokens
  await renderRootCatalog(db, transport, chatId, user, messageId);
}

/**
 * Handles action execution (OPEN_SUBMENU, SHOW_DETAILS, or truthful deferred response).
 */
async function handleActionExecution(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  messageId: number,
  user: TelegramUser,
  actionId: string,
  settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>,
  langContext: ResolvedLanguageContext,
  ui: ReturnType<typeof getLocalizedUiStrings>,
  page = 1,
): Promise<void> {
  const actionCheck = await isActionHierarchyActive(db, actionId);
  if (!actionCheck.valid || !actionCheck.actionRow) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: ui.optionUnavailable,
      replyMarkup: {
        inline_keyboard: [[{ text: ui.home, callback_data: tokens.home() }]],
      },
    });
    return;
  }

  const actRow = actionCheck.actionRow;

  // Navigation targets
  const backTarget = actRow.parentActionId
    ? tokens.action(actRow.parentActionId)
    : tokens.product(actRow.productId);
  const returnToProductTarget = tokens.product(actRow.productId);

  // A. OPEN_SUBMENU
  if (actRow.actionType === "OPEN_SUBMENU") {
    const actTranslations = await db
      .select({
        languageId: productActionTranslation.languageId,
        label: productActionTranslation.label,
        menuText: productActionTranslation.menuText,
      })
      .from(productActionTranslation)
      .where(eq(productActionTranslation.actionId, actRow.id));

    const preferred = actTranslations.find((t) => t.languageId === langContext.id);
    const fallback = actTranslations.find((t) => t.languageId === settings.defaultLanguageId);
    const label = preferred?.label ?? fallback?.label ?? "Menu";
    const menuText = preferred?.menuText ?? fallback?.menuText ?? null;

    const bodyText = menuText && menuText.trim().length > 0 ? menuText.trim() : label;

    // Active children with deterministic tie-breaking
    const children = await db
      .select({
        id: productAction.id,
        actionType: productAction.actionType,
        sortOrder: productAction.sortOrder,
      })
      .from(productAction)
      .where(
        and(
          eq(productAction.parentActionId, actRow.id),
          eq(productAction.isActive, true),
        ),
      )
      .orderBy(asc(productAction.sortOrder), asc(productAction.id));

    const totalPages = Math.max(1, Math.ceil(children.length / TELEGRAM_MENU_PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * TELEGRAM_MENU_PAGE_SIZE;
    const pageChildren = children.slice(startIndex, startIndex + TELEGRAM_MENU_PAGE_SIZE);

    const keyboard: TelegramInlineKeyboardButton[][] = [];

    for (const child of pageChildren) {
      const cTrans = await db
        .select({
          languageId: productActionTranslation.languageId,
          label: productActionTranslation.label,
        })
        .from(productActionTranslation)
        .where(eq(productActionTranslation.actionId, child.id));

      const cpTrans = cTrans.find((t) => t.languageId === langContext.id);
      const cfTrans = cTrans.find((t) => t.languageId === settings.defaultLanguageId);
      const childLabel = cpTrans?.label ?? cfTrans?.label ?? child.actionType;

      keyboard.push([
        {
          text: childLabel,
          callback_data: tokens.action(child.id),
        },
      ]);
    }

    // Pagination row
    if (totalPages > 1) {
      const pageButtons: TelegramInlineKeyboardButton[] = [];
      if (currentPage > 1) {
        pageButtons.push({
          text: ui.prevPage,
          callback_data: tokens.submenu(actRow.id, currentPage - 1),
        });
      }
      if (currentPage < totalPages) {
        pageButtons.push({
          text: ui.nextPage,
          callback_data: tokens.submenu(actRow.id, currentPage + 1),
        });
      }
      keyboard.push(pageButtons);
    }

    // Navigation buttons
    keyboard.push([{ text: ui.back, callback_data: backTarget }]);
    if (actRow.parentActionId) {
      keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
    }
    keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: bodyText,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // B. SHOW_DETAILS
  if (actRow.actionType === "SHOW_DETAILS") {
    const prodTranslations = await db
      .select({
        languageId: productTranslation.languageId,
        name: productTranslation.name,
        description: productTranslation.description,
        details: productTranslation.details,
      })
      .from(productTranslation)
      .where(eq(productTranslation.productId, actRow.productId));

    const preferred = prodTranslations.find((t) => t.languageId === langContext.id);
    const fallback = prodTranslations.find((t) => t.languageId === settings.defaultLanguageId);

    const prodName = preferred?.name ?? fallback?.name ?? "Product Details";
    const details = preferred?.details ?? fallback?.details ?? null;
    const description = preferred?.description ?? fallback?.description ?? null;

    let bodyText = prodName + "\n\n";
    if (details && details.trim().length > 0) {
      bodyText += details.trim();
    } else if (description && description.trim().length > 0) {
      bodyText += description.trim();
    } else {
      bodyText += ui.noDetails;
    }

    const keyboard: TelegramInlineKeyboardButton[][] = [
      [{ text: ui.back, callback_data: backTarget }],
    ];
    if (actRow.parentActionId) {
      keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
    }
    keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: bodyText,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // C. DEFERRED RUNTIME ACTIONS:
  // START_INQUIRY, OPEN_SUPPORT, SEND_TEMPLATE_MESSAGE, OPEN_URL, NAVIGATE_CATALOG
  // Truthful unavailable response. Does NOT execute or claim a message was sent.
  const keyboard: TelegramInlineKeyboardButton[][] = [
    [{ text: ui.back, callback_data: backTarget }],
  ];
  if (actRow.parentActionId) {
    keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
  }
  keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: ui.actionNotSupported,
    replyMarkup: { inline_keyboard: keyboard },
  });
}
