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
  isActionHierarchyActive,
  isCategoryHierarchyActive,
  isProductHierarchyActive,
} from "@/lib/catalog/eligibility";
import {
  getEligibleStorefrontCategoryIds,
  hasEligibleStorefrontProducts,
  listEligibleStorefrontCategories,
  listEligibleStorefrontProducts,
} from "@/lib/catalog/storefront";
import {
  getCustomerByTelegramId,
  listEnabledLanguages,
  readSettings,
  resolveMessageText,
  setCustomerSelectedLanguage,
  upsertCustomer,
} from "@/lib/data";
import {
  handleProductInquiryCallback,
  handleSupportInquiryCallback,
  recoverAndRenderCommittedInquiryCallback,
  renderCustomerInquiriesList,
  renderCustomerInquiriesOverview,
  type InquiryJourneyOptions,
} from "./inquiry-journey";
import { parseToken, tokens, UUID_REGEX, type ParsedToken } from "./tokens";
import {
  interpolateActionTemplate,
  validateActionTemplateBody,
} from "@/lib/product-actions/templates";
import { validateHttpsUrl } from "@/lib/product-actions/validation";
import {
  listEligiblePaymentMethodsForProduct,
  resolvePaymentMethodForAction,
} from "@/lib/payment-methods/journey";
import { isManualPaymentPrototypeEnabled } from "@/lib/payment-methods/prototype";
import {
  TELEGRAM_MAX_MESSAGE_CHARS,
} from "./transport";
import type {
  TelegramCallbackQuery,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramTransport,
  TelegramUser,
} from "./types";
import { TelegramTransportError } from "./types";

export const TELEGRAM_MENU_PAGE_SIZE = 10;
export { MAX_SAFEGUARD_DEPTH } from "@/lib/catalog/eligibility";

export interface ResolvedLanguageContext {
  id: string;
  code: string;
  label: string;
  isRtl: boolean;
}

export interface ChannelJourneyOptions {
  /** Enables the synthetic manual-payment prototype for this channel only. */
  manualPaymentPrototypeEnabled?: boolean;
}

function orderEnabledLanguages<T extends { id: string; code: string }>(
  languages: T[],
  defaultLanguageId: string,
): T[] {
  return [...languages].sort((a, b) => {
    if (a.id === defaultLanguageId) return -1;
    if (b.id === defaultLanguageId) return 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

export function getLocalizedUiStrings(isRtl: boolean) {
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
      browseProducts: "🛍 تصفح المنتجات",
      browseCategories: "🗂 تصفح الأقسام",
      contactSupport: "💬 تواصل مع الدعم",
      changeLanguage: "🌐 تغيير اللغة",
      myInquiries: "📨 استفساراتي النشطة",
      noProducts: "لا توجد منتجات متاحة حالياً.",
      pageInfo: "الصفحة",
      noActiveInquiries: "ليس لديك استفسارات نشطة.",
      activeInquiriesTitle: "استفساراتك النشطة:",
      inquiriesReplyHint:
        "للرد، أرسل رسالتك هنا أو استخدم /reply <المرجع> <رسالتك>.",
      openLink: "🌐 فتح الرابط",
      customerFallback: "عميلنا العزيز",
      paymentPrototypeNotice:
        "نسخة تجريبية فقط — لا يلزم إجراء تحويل أو دفع حقيقي. لا تؤكد هذه الشاشة أي عملية دفع ولا تسجلها.",
      contactSellerAboutMethod: "💬 تواصل مع البائع بخصوص هذه الطريقة",
      contactSeller: "💬 تواصل مع البائع",
      contactSellerAboutProduct: "💬 تواصل مع البائع بخصوص هذا المنتج",
      noPaymentMethods: "لا توجد طرق دفع متاحة حالياً لهذا المنتج.",
      noPaymentInstructions:
        "لم يضف البائع تعليمات تفصيلية لهذه الطريقة. يمكنك التواصل مع البائع للاستفسار.",
      paymentContactUnavailable:
        "تعذر فتح محادثة بخصوص طريقة الدفع هذه. يرجى المحاولة مرة أخرى.",
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
    browseProducts: "🛍 Browse Products",
    browseCategories: "🗂 Browse Categories",
    contactSupport: "💬 Contact Support",
    changeLanguage: "🌐 Change Language",
    myInquiries: "📨 My Active Inquiries",
    noProducts: "No products are available right now.",
    pageInfo: "Page",
    noActiveInquiries: "You have no active inquiries.",
    activeInquiriesTitle: "Your active inquiries:",
    inquiriesReplyHint:
      "To reply, send a message here or use /reply <reference> <message>.",
    openLink: "🌐 Open link",
    customerFallback: "Customer",
    paymentPrototypeNotice:
      "Prototype only — no real transfer or charge is required. This screen does not confirm or record a payment.",
    contactSellerAboutMethod: "💬 Contact seller about this method",
    contactSeller: "💬 Contact seller",
    contactSellerAboutProduct: "💬 Contact seller about this product",
    noPaymentMethods: "No payment methods are currently available for this product.",
    noPaymentInstructions:
      "The seller has not added detailed instructions for this method. You can contact the seller to ask.",
    paymentContactUnavailable:
      "Could not open a conversation about this payment method. Please try again.",
  };
}

/**
 * Resolves the effective language for a customer interaction.
 */
export async function resolveCustomerLanguageContext(
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

  if (!matchedLang && customerRecord?.languageCode) {
    const hintCode = customerRecord.languageCode.toLowerCase().slice(0, 2);
    matchedLang = enabledLanguages.find((l) => l.code === hintCode);
  }

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
 * Splits rendered message text into chunks of at most `maxChunkLength` characters.
 * Preserves exact text content and ordering such that `chunks.join("") === text`.
 * Ensures UTF-16 surrogate pairs (e.g. multibyte emojis) are never split across chunks.
 * Attempts to break cleanly at paragraph (\n\n), newline (\n), or word boundary when possible.
 */
export function splitMessageText(text: string, maxChunkLength = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  if (text.length <= maxChunkLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChunkLength) {
    let splitIdx = maxChunkLength;

    // Search for natural break points within the final 500 chars of the window
    const windowStart = Math.max(0, maxChunkLength - 500);
    const windowText = remaining.slice(windowStart, maxChunkLength);

    const paragraphBreak = windowText.lastIndexOf("\n\n");
    if (paragraphBreak !== -1) {
      // Split right after the paragraph break
      splitIdx = windowStart + paragraphBreak + 2;
    } else {
      const lineBreak = windowText.lastIndexOf("\n");
      if (lineBreak !== -1) {
        splitIdx = windowStart + lineBreak + 1;
      } else {
        const spaceBreak = windowText.lastIndexOf(" ");
        if (spaceBreak !== -1) {
          splitIdx = windowStart + spaceBreak + 1;
        }
      }
    }

    // Surrogate pair safeguard: never split between high surrogate and low surrogate
    const prevCode = remaining.charCodeAt(splitIdx - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      splitIdx -= 1;
    }

    // Safety fallback: ensure forward progress
    if (splitIdx <= 0) {
      splitIdx = maxChunkLength;
      const code = remaining.charCodeAt(splitIdx - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        splitIdx -= 1;
      }
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Safe Unicode-aware message text bounding helper.
 */
export function boundMessageText(text: string, maxLen = 4096): string {
  const [firstChunk] = splitMessageText(text, maxLen);
  return firstChunk ?? "";
}

export async function sendOrThrow(
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  },
): Promise<void> {
  const chunks = splitMessageText(params.text, TELEGRAM_MAX_MESSAGE_CHARS);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const res = await transport.sendMessage({
      chatId: params.chatId,
      text: chunks[i],
      replyMarkup: isLast ? params.replyMarkup : undefined,
    });
    if (!res.ok) {
      throw new TelegramTransportError(res.error ?? "Failed to send Telegram message", {
        errorKind: res.errorKind ?? "api_error",
        retryAfterSeconds: res.retryAfterSeconds,
      });
    }
  }
}

export async function editOrThrow(
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    messageId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  },
): Promise<void> {
  const chunks = splitMessageText(params.text, TELEGRAM_MAX_MESSAGE_CHARS);
  const firstChunk = chunks[0];
  const isOnlyChunk = chunks.length === 1;

  const res = await transport.editMessageText({
    chatId: params.chatId,
    messageId: params.messageId,
    text: firstChunk,
    replyMarkup: isOnlyChunk ? params.replyMarkup : undefined,
  });

  if (!res.ok) {
    // Only fall back to sendMessage if the message was not editable
    if (res.errorKind === "not_editable") {
      const sendRes = await transport.sendMessage({
        chatId: params.chatId,
        text: firstChunk,
        replyMarkup: isOnlyChunk ? params.replyMarkup : undefined,
      });
      if (!sendRes.ok) {
        throw new TelegramTransportError(
          sendRes.error ?? "Failed to send replacement Telegram message",
          {
            errorKind: sendRes.errorKind ?? "api_error",
            retryAfterSeconds: sendRes.retryAfterSeconds,
          },
        );
      }
    } else {
      throw new TelegramTransportError(res.error ?? "Failed to edit Telegram message", {
        errorKind: res.errorKind ?? "api_error",
        retryAfterSeconds: res.retryAfterSeconds,
      });
    }
  }

  // Deliver remaining chunks sequentially, placing replyMarkup on the final chunk
  for (let i = 1; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const nextRes = await transport.sendMessage({
      chatId: params.chatId,
      text: chunks[i],
      replyMarkup: isLast ? params.replyMarkup : undefined,
    });
    if (!nextRes.ok) {
      throw new TelegramTransportError(
        nextRes.error ?? "Failed to send follow-up message chunk",
        {
          errorKind: nextRes.errorKind ?? "api_error",
          retryAfterSeconds: nextRes.retryAfterSeconds,
        },
      );
    }
  }
}

async function resolveWelcomeBody(
  db: Database,
  settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>,
  langContext: ResolvedLanguageContext,
): Promise<string> {
  let welcomeBody = (langContext.isRtl || langContext.code === "ar")
    ? `مرحبًا بك في ${settings.displayName}!`
    : `Welcome to ${settings.displayName}!`;
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
  return welcomeBody;
}

/**
 * Renders the virtual default storefront home derived from the configured
 * settings and the live catalog. Nothing is persisted and opening it creates no
 * inquiry.
 */
async function renderStorefrontHome(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  user: TelegramUser,
  messageIdToEdit?: number,
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
  const welcomeBody = await resolveWelcomeBody(db, settings, langContext);

  const [hasProducts, enabledLanguages] = await Promise.all([
    hasEligibleStorefrontProducts(db),
    listEnabledLanguages(db),
  ]);

  const keyboard: TelegramInlineKeyboardButton[][] = [
    [{ text: ui.browseProducts, callback_data: tokens.products() }],
  ];

  if (hasProducts) {
    keyboard.push([
      { text: ui.browseCategories, callback_data: tokens.storefrontCategories() },
    ]);
  }

  keyboard.push([{ text: ui.contactSupport, callback_data: tokens.support() }]);

  if (enabledLanguages.length > 1) {
    keyboard.push([{ text: ui.changeLanguage, callback_data: tokens.languages() }]);
  }

  keyboard.push([{ text: ui.myInquiries, callback_data: tokens.myInquiries() }]);

  if (messageIdToEdit) {
    await editOrThrow(transport, {
      chatId,
      messageId: messageIdToEdit,
      text: welcomeBody,
      replyMarkup: { inline_keyboard: keyboard },
    });
  } else {
    await sendOrThrow(transport, {
      chatId,
      text: welcomeBody,
      replyMarkup: { inline_keyboard: keyboard },
    });
  }
}

/**
 * Renders a root-category listing. Legacy `c:root[:page]` navigation uses the
 * full configured tree; the storefront discovery entry point uses the filtered
 * mode so branches without eligible products are not offered.
 */
async function renderRootCategories(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  user: TelegramUser,
  messageIdToEdit?: number,
  page = 1,
  storefrontMode = false,
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
  const bodyText = await resolveWelcomeBody(db, settings, langContext);

  const keyboard: TelegramInlineKeyboardButton[][] = [];
  let currentPage = 1;
  let totalPages = 1;

  if (storefrontMode) {
    const result = await listEligibleStorefrontCategories(db, {
      parentId: null,
      languageId: langContext.id,
      defaultLanguageId: settings.defaultLanguageId,
      page,
      pageSize: TELEGRAM_MENU_PAGE_SIZE,
    });

    currentPage = result.page;
    totalPages = result.totalPages;

    for (const item of result.items) {
      keyboard.push([
        {
          text: item.name,
          callback_data: tokens.storefrontCategory(item.id),
        },
      ]);
    }
  } else {
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

    totalPages = Math.max(1, Math.ceil(rootCategories.length / TELEGRAM_MENU_PAGE_SIZE));
    currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * TELEGRAM_MENU_PAGE_SIZE;
    const pageCategories = rootCategories.slice(
      startIndex,
      startIndex + TELEGRAM_MENU_PAGE_SIZE,
    );

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
  }

  // Pagination row if multiple pages
  if (totalPages > 1) {
    const navButtons: TelegramInlineKeyboardButton[] = [];
    if (currentPage > 1) {
      navButtons.push({
        text: ui.prevPage,
        callback_data: storefrontMode
          ? tokens.storefrontCategories(currentPage - 1)
          : tokens.rootCategory(currentPage - 1),
      });
    }
    if (currentPage < totalPages) {
      navButtons.push({
        text: ui.nextPage,
        callback_data: storefrontMode
          ? tokens.storefrontCategories(currentPage + 1)
          : tokens.rootCategory(currentPage + 1),
      });
    }
    keyboard.push(navButtons);
  }

  keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

  if (messageIdToEdit) {
    await editOrThrow(transport, {
      chatId,
      messageId: messageIdToEdit,
      text: bodyText,
      replyMarkup: { inline_keyboard: keyboard },
    });
  } else {
    await sendOrThrow(transport, {
      chatId,
      text: bodyText,
      replyMarkup: { inline_keyboard: keyboard },
    });
  }
}

/**
 * Renders direct, paginated product discovery across the eligible catalog.
 */
async function renderStorefrontProducts(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  messageId: number,
  settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>,
  langContext: ResolvedLanguageContext,
  ui: ReturnType<typeof getLocalizedUiStrings>,
  page = 1,
): Promise<void> {
  const result = await listEligibleStorefrontProducts(db, {
    languageId: langContext.id,
    defaultLanguageId: settings.defaultLanguageId,
    page,
    pageSize: TELEGRAM_MENU_PAGE_SIZE,
  });

  const keyboard: TelegramInlineKeyboardButton[][] = result.items.map((item) => [
    { text: item.name, callback_data: tokens.product(item.id) },
  ]);

  if (result.totalPages > 1) {
    const navButtons: TelegramInlineKeyboardButton[] = [];
    if (result.page > 1) {
      navButtons.push({
        text: ui.prevPage,
        callback_data: tokens.products(result.page - 1),
      });
    }
    if (result.page < result.totalPages) {
      navButtons.push({
        text: ui.nextPage,
        callback_data: tokens.products(result.page + 1),
      });
    }
    keyboard.push(navButtons);
  }

  keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

  const bodyText =
    result.totalCount === 0
      ? ui.noProducts
      : result.totalPages > 1
        ? `${ui.browseProducts}\n\n${ui.pageInfo} ${result.page}/${result.totalPages}`
        : ui.browseProducts;

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: bodyText,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

/**
 * Renders the explicit language menu. With a single enabled language the menu
 * is not offered and the storefront home is shown instead.
 */
async function renderLanguageMenu(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  messageId: number,
  user: TelegramUser,
  defaultLanguageId: string,
): Promise<void> {
  const langContext = await resolveCustomerLanguageContext(db, user.id, defaultLanguageId);
  const ui = getLocalizedUiStrings(langContext.isRtl);
  const enabledLanguages = orderEnabledLanguages(
    await listEnabledLanguages(db),
    defaultLanguageId,
  );
  if (enabledLanguages.length <= 1) {
    await renderStorefrontHome(db, transport, chatId, user, messageId);
    return;
  }

  const langKeyboard: TelegramInlineKeyboardButton[][] = enabledLanguages.map((l) => [
    {
      text: l.label,
      callback_data: tokens.lang(l.code),
    },
  ]);
  langKeyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: ui.selectLanguagePrompt,
    replyMarkup: { inline_keyboard: langKeyboard },
  });
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
  const enabledLanguages = orderEnabledLanguages(
    await listEnabledLanguages(db),
    settings.defaultLanguageId,
  );

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

  // Otherwise, proceed to the virtual default storefront home
  await renderStorefrontHome(db, transport, message.chat.id, from);
}

/**
 * Renders a category view (subcategories, products, pagination, Back/Home).
 */
async function renderCategory(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  messageId: number,
  catRow: typeof category.$inferSelect,
  settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>,
  langContext: ResolvedLanguageContext,
  ui: ReturnType<typeof getLocalizedUiStrings>,
  page = 1,
  storefrontMode = false,
  eligibleCategoryIds?: Set<string>,
): Promise<void> {
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

  // Active subcategories with deterministic tie-breaking. The storefront
  // discovery mode additionally hides branches with no eligible descendant
  // products; legacy category callbacks keep the full configured tree.
  const allSubcategories = await db
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

  const subcategories = storefrontMode && eligibleCategoryIds
    ? allSubcategories.filter((row) => eligibleCategoryIds.has(row.id))
    : allSubcategories;

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
  const currentPage = Math.min(Math.max(1, page), totalPages);
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
          callback_data: storefrontMode
            ? tokens.storefrontCategory(item.id)
            : tokens.category(item.id),
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
        callback_data: storefrontMode
          ? tokens.storefrontCategory(catRow.id, currentPage - 1)
          : tokens.category(catRow.id, currentPage - 1),
      });
    }
    if (currentPage < totalPages) {
      navButtons.push({
        text: ui.nextPage,
        callback_data: storefrontMode
          ? tokens.storefrontCategory(catRow.id, currentPage + 1)
          : tokens.category(catRow.id, currentPage + 1),
      });
    }
    keyboard.push(navButtons);
  }

  // Navigation row: Back & Home
  const backTarget = catRow.parentId
    ? storefrontMode
      ? tokens.storefrontCategory(catRow.parentId)
      : tokens.category(catRow.parentId)
    : storefrontMode
      ? tokens.storefrontCategories()
      : tokens.home();
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
}

/**
 * Handles callback queries for catalog browsing and product actions.
 */
export async function handleCallbackQuery(
  db: Database,
  transport: TelegramTransport,
  callbackQuery: TelegramCallbackQuery,
  preValidatedToken?: ParsedToken,
  journeyOptions?: InquiryJourneyOptions,
  channelOptions?: ChannelJourneyOptions,
): Promise<void> {
  const manualPaymentPrototypeEnabled =
    channelOptions?.manualPaymentPrototypeEnabled ??
    isManualPaymentPrototypeEnabled();
  // Acknowledge callback immediately to clear loading indicator
  const ack = await transport.answerCallbackQuery({ callbackQueryId: callbackQuery.id });
  if (!ack.ok) {
    if (ack.errorKind === "callback_expired") {
      // Confirmed terminal acknowledgement condition caused by an expired callback query.
      // Continue catalog rendering under existing attempt ownership and execution deadline.
    } else {
      throw new TelegramTransportError(ack.error ?? "Failed to answer callback query", {
        errorKind: ack.errorKind ?? "api_error",
        retryAfterSeconds: ack.retryAfterSeconds,
      });
    }
  }

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

  const parsed = preValidatedToken ?? parseToken(callbackQuery.data);
  if (parsed.type === "unknown") {
    throw new Error("Unrecognized callback token");
  }

  // 1. Language menu callback: langs
  if (parsed.type === "languages") {
    await renderLanguageMenu(
      db,
      transport,
      chatId,
      messageId,
      user,
      settings.defaultLanguageId,
    );
    return;
  }

  // 1.1. Language selection callback: lang:<code>
  if (parsed.type === "lang") {
    const [targetLang] = await db
      .select({ id: language.id, isEnabled: language.isEnabled })
      .from(language)
      .where(eq(language.code, parsed.code))
      .limit(1);

    if (targetLang && targetLang.isEnabled) {
      await setCustomerSelectedLanguage(db, user.id, targetLang.id);
    }

    // A stale selection for a now-disabled language changes nothing and safely
    // returns to the storefront in the effective fallback language.
    await renderStorefrontHome(db, transport, chatId, user, messageId);
    return;
  }

  // Resolve language context for subsequent rendering
  const langContext = await resolveCustomerLanguageContext(
    db,
    user.id,
    settings.defaultLanguageId,
  );
  const ui = getLocalizedUiStrings(langContext.isRtl);

  // 1.5. Committed inquiry callback recovery: process committed receipt before live action/hierarchy checks
  if (journeyOptions?.receipt && journeyOptions.receipt.kind === "inquiry") {
    await recoverAndRenderCommittedInquiryCallback(db, transport, {
      chatId,
      messageId,
      user,
      customerRecord,
      settings,
      langContext,
      ui,
      receipt: journeyOptions.receipt,
    });
    return;
  }

  // Inquiries pagination callback: inq[:<page>]
  if (parsed.type === "inquiries") {
    await renderCustomerInquiriesList(
      db,
      transport,
      chatId,
      messageId,
      customerRecord.id,
      parsed.page,
      langContext,
      ui,
    );
    return;
  }

  // My Inquiries overview callback: myinq[:<page>]
  if (parsed.type === "myInquiries") {
    await renderCustomerInquiriesOverview(
      db,
      transport,
      chatId,
      messageId,
      customerRecord.id,
      parsed.page,
      langContext,
      ui,
    );
    return;
  }

  // Direct storefront product discovery: prods[:<page>]
  if (parsed.type === "products") {
    await renderStorefrontProducts(
      db,
      transport,
      chatId,
      messageId,
      settings,
      langContext,
      ui,
      parsed.page,
    );
    return;
  }

  // Explicit storefront support entry point. There is no source product action;
  // the explicit tap reuses the existing general support create-or-resume path.
  if (parsed.type === "support") {
    if (!journeyOptions || journeyOptions.updateId <= 0 || !journeyOptions.attemptId) {
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

    await handleSupportInquiryCallback(db, transport, {
      chatId,
      messageId,
      user,
      langContext,
      ui,
      backTarget: tokens.home(),
      returnToProductTarget: tokens.home(),
      options: journeyOptions,
    });
    return;
  }

  // 2. Home or Root callback
  if (parsed.type === "home") {
    await renderStorefrontHome(db, transport, chatId, user, messageId);
    return;
  }

  if (parsed.type === "root") {
    await renderRootCategories(db, transport, chatId, user, messageId, parsed.page);
    return;
  }

  // 2.1. Storefront category discovery: scats[:page] / sc:<categoryId>[:<page>]
  if (parsed.type === "storefrontCategories") {
    await renderRootCategories(
      db,
      transport,
      chatId,
      user,
      messageId,
      parsed.page,
      true,
    );
    return;
  }

  if (parsed.type === "storefrontCategory") {
    const eligibleCategoryIds = await getEligibleStorefrontCategoryIds(db);
    const categoryCheck = await isCategoryHierarchyActive(db, parsed.categoryId);

    if (
      !categoryCheck.valid ||
      !categoryCheck.categoryRow ||
      !eligibleCategoryIds.has(parsed.categoryId)
    ) {
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

    await renderCategory(
      db,
      transport,
      chatId,
      messageId,
      categoryCheck.categoryRow,
      settings,
      langContext,
      ui,
      parsed.page,
      true,
      eligibleCategoryIds,
    );
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

    await renderCategory(
      db,
      transport,
      chatId,
      messageId,
      categoryCheck.categoryRow,
      settings,
      langContext,
      ui,
      parsed.page,
    );
    return;
  }

  // 4. Product card callback: p:<productId>
  if (parsed.type === "product") {
    await renderProductCard(
      db,
      transport,
      chatId,
      messageId,
      user,
      parsed.productId,
      settings,
      langContext,
      ui,
      manualPaymentPrototypeEnabled,
    );
    return;
  }

  // 4.5. Guaranteed product-inquiry fallback: pi:<productId>
  if (parsed.type === "productInquiry") {
    if (!manualPaymentPrototypeEnabled) {
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

    const productTarget = tokens.product(parsed.productId);
    if (!journeyOptions || journeyOptions.updateId <= 0 || !journeyOptions.attemptId) {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.paymentContactUnavailable,
        replyMarkup: {
          inline_keyboard: [
            [{ text: ui.returnToProduct, callback_data: productTarget }],
            [{ text: ui.home, callback_data: tokens.home() }],
          ],
        },
      });
      return;
    }

    await handleProductInquiryCallback(db, transport, {
      chatId,
      messageId,
      user,
      productRow: productCheck.productRow,
      langContext,
      ui,
      backTarget: productTarget,
      returnToProductTarget: productTarget,
      options: journeyOptions,
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
      await renderStorefrontHome(db, transport, chatId, user, messageId);
      return;
    }

    if (act.parentActionId) {
      // Direct navigation to parent action submenu (no redundant answerCallbackQuery)
      await handleActionExecution(
        db,
        transport,
        chatId,
        messageId,
        user,
        act.parentActionId,
        settings,
        langContext,
        ui,
        1,
        journeyOptions,
        manualPaymentPrototypeEnabled,
      );
    } else {
      // Direct navigation to product card (no redundant answerCallbackQuery)
      await renderProductCard(
        db,
        transport,
        chatId,
        messageId,
        user,
        act.productId,
        settings,
        langContext,
        ui,
        manualPaymentPrototypeEnabled,
      );
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
      journeyOptions,
      manualPaymentPrototypeEnabled,
    );
    return;
  }

  // 6.5. Explicit contact about a selected payment method: pm:<actionId>
  if (parsed.type === "paymentContact") {
    if (!manualPaymentPrototypeEnabled) {
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

    const actionCheck = await isActionHierarchyActive(db, parsed.actionId);
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

    const productTarget = tokens.product(actionCheck.actionRow.productId);
    const fallbackKeyboard: TelegramInlineKeyboardButton[][] = [
      [{ text: ui.returnToProduct, callback_data: productTarget }],
      [{ text: ui.home, callback_data: tokens.home() }],
    ];

    if (!journeyOptions || journeyOptions.updateId <= 0 || !journeyOptions.attemptId) {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.paymentContactUnavailable,
        replyMarkup: { inline_keyboard: fallbackKeyboard },
      });
      return;
    }

    const resolved = await resolvePaymentMethodForAction(db, {
      productId: actionCheck.actionRow.productId,
      actionId: parsed.actionId,
      requestedLanguageId: langContext.id,
      defaultLanguageId: settings.defaultLanguageId,
    });

    if (resolved.status !== "ok") {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: fallbackKeyboard },
      });
      return;
    }

    const method = resolved.method;
    const productCheck = await isProductHierarchyActive(db, method.product.id);
    if (!productCheck.valid || !productCheck.productRow) {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.productUnavailable,
        replyMarkup: { inline_keyboard: fallbackKeyboard },
      });
      return;
    }

    await handleProductInquiryCallback(db, transport, {
      chatId,
      messageId,
      user,
      actionRow: {
        id: method.actionId,
        parentActionId: method.actionParentId,
      },
      productRow: productCheck.productRow,
      langContext,
      ui,
      backTarget: tokens.action(method.actionId),
      returnToProductTarget: tokens.product(method.product.id),
      options: journeyOptions,
      selectedOptionSuffix: method.selectionSuffix,
    });
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
      journeyOptions,
      manualPaymentPrototypeEnabled,
    );
    return;
  }

  // Fallback for unknown tokens
  await renderStorefrontHome(db, transport, chatId, user, messageId);
}

async function findProductContactRoute(
  db: Database,
  productId: string,
  langContext: ResolvedLanguageContext,
  settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>,
  ui: ReturnType<typeof getLocalizedUiStrings>,
): Promise<{ actionId: string; label: string } | null> {
  const candidates = await db
    .select({
      id: productAction.id,
      actionType: productAction.actionType,
      sortOrder: productAction.sortOrder,
    })
    .from(productAction)
    .where(
      and(
        eq(productAction.productId, productId),
        isNull(productAction.parentActionId),
        eq(productAction.isActive, true),
      ),
    )
    .orderBy(asc(productAction.sortOrder), asc(productAction.id));

  for (const candidate of candidates) {
    if (
      candidate.actionType !== "START_INQUIRY" &&
      candidate.actionType !== "OPEN_SUPPORT"
    ) {
      continue;
    }

    const translations = await db
      .select({
        languageId: productActionTranslation.languageId,
        label: productActionTranslation.label,
      })
      .from(productActionTranslation)
      .where(eq(productActionTranslation.actionId, candidate.id));

    const preferred = translations.find((t) => t.languageId === langContext.id);
    const fallback = translations.find(
      (t) => t.languageId === settings.defaultLanguageId,
    );
    const label = preferred?.label ?? fallback?.label ?? ui.contactSeller;
    return { actionId: candidate.id, label };
  }

  return null;
}

function appendPrototypeNotice(
  bodyText: string,
  notice: string,
): string {
  return bodyText.trim().length > 0 ? `${bodyText.trim()}\n\n${notice}` : notice;
}

/**
 * Renders the product card view with localized name, description, price, and root actions.
 */
async function renderProductCard(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  messageId: number,
  user: TelegramUser,
  productId: string,
  settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>,
  langContext: ResolvedLanguageContext,
  ui: ReturnType<typeof getLocalizedUiStrings>,
  manualPaymentPrototypeEnabled = false,
): Promise<void> {
  const productCheck = await isProductHierarchyActive(db, productId);
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

  let eligibleRootMethods = new Map<
    string,
    { actionId: string; label: string }
  >();
  if (
    manualPaymentPrototypeEnabled &&
    rootActions.some((action) => action.actionType === "PAYMENT_METHOD")
  ) {
    const eligible = await listEligiblePaymentMethodsForProduct(db, {
      productId: prodRow.id,
      parentActionId: null,
      requestedLanguageId: langContext.id,
      defaultLanguageId: settings.defaultLanguageId,
    });
    if (eligible.status === "ok") {
      eligibleRootMethods = new Map(
        eligible.methods.map((method) => [
          method.actionId,
          { actionId: method.actionId, label: method.label },
        ]),
      );
    }
  }

  const keyboard: TelegramInlineKeyboardButton[][] = [];

  for (const act of rootActions) {
    if (act.actionType === "PAYMENT_METHOD") {
      if (!manualPaymentPrototypeEnabled) continue;
      const method = eligibleRootMethods.get(act.id);
      if (!method) continue;
      keyboard.push([
        {
          text: method.label,
          callback_data: tokens.action(method.actionId),
        },
      ]);
      continue;
    }

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
  journeyOptions?: InquiryJourneyOptions,
  manualPaymentPrototypeEnabled = false,
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

    let bodyText = menuText && menuText.trim().length > 0 ? menuText.trim() : label;

    // All configured children in stable order. Eligibility is applied per
    // child: payment-method children additionally require the shared resolver's
    // fresh live checks and must stay hidden unless the prototype is enabled.
    const allChildren = await db
      .select({
        id: productAction.id,
        actionType: productAction.actionType,
        isActive: productAction.isActive,
        sortOrder: productAction.sortOrder,
      })
      .from(productAction)
      .where(eq(productAction.parentActionId, actRow.id))
      .orderBy(asc(productAction.sortOrder), asc(productAction.id));

    const configuredPaymentChildren = allChildren.some(
      (child) => child.actionType === "PAYMENT_METHOD",
    );

    let eligibleChildMethods = new Map<
      string,
      { actionId: string; label: string }
    >();
    if (manualPaymentPrototypeEnabled && configuredPaymentChildren) {
      const eligible = await listEligiblePaymentMethodsForProduct(db, {
        productId: actRow.productId,
        parentActionId: actRow.id,
        requestedLanguageId: langContext.id,
        defaultLanguageId: settings.defaultLanguageId,
      });
      if (eligible.status === "ok") {
        eligibleChildMethods = new Map(
          eligible.methods.map((method) => [
            method.actionId,
            { actionId: method.actionId, label: method.label },
          ]),
        );
      }
    }

    const children: Array<{
      id: string;
      label: string;
      isPaymentMethod: boolean;
    }> = [];

    for (const child of allChildren) {
      if (!child.isActive) continue;

      if (child.actionType === "PAYMENT_METHOD") {
        if (!manualPaymentPrototypeEnabled) continue;
        const method = eligibleChildMethods.get(child.id);
        if (!method) continue;
        children.push({
          id: child.id,
          label: method.label,
          isPaymentMethod: true,
        });
        continue;
      }

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

      children.push({
        id: child.id,
        label: childLabel,
        isPaymentMethod: false,
      });
    }

    const paymentMethodsUnavailable =
      manualPaymentPrototypeEnabled &&
      configuredPaymentChildren &&
      !children.some((child) => child.isPaymentMethod);

    if (manualPaymentPrototypeEnabled && configuredPaymentChildren) {
      bodyText = appendPrototypeNotice(bodyText, ui.paymentPrototypeNotice);
    }

    if (paymentMethodsUnavailable) {
      bodyText = appendPrototypeNotice(bodyText, ui.noPaymentMethods);
    }

    const totalPages = Math.max(1, Math.ceil(children.length / TELEGRAM_MENU_PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * TELEGRAM_MENU_PAGE_SIZE;
    const pageChildren = children.slice(startIndex, startIndex + TELEGRAM_MENU_PAGE_SIZE);

    const keyboard: TelegramInlineKeyboardButton[][] = [];

    for (const child of pageChildren) {
      keyboard.push([
        {
          text: child.label,
          callback_data: tokens.action(child.id),
        },
      ]);
    }

    if (paymentMethodsUnavailable) {
      const contactRoute = await findProductContactRoute(
        db,
        actRow.productId,
        langContext,
        settings,
        ui,
      );
      if (contactRoute) {
        keyboard.push([
          {
            text: contactRoute.label,
            callback_data: tokens.action(contactRoute.actionId),
          },
        ]);
      } else {
        // Guaranteed product-scoped contact fallback. This does not invent a
        // source action or attach a payment method; the callback revalidates
        // the live product hierarchy before reusing the inquiry journey.
        keyboard.push([
          {
            text: ui.contactSellerAboutProduct,
            callback_data: tokens.productInquiry(actRow.productId),
          },
        ]);
      }
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

  // C. SEND_TEMPLATE_MESSAGE
  if (actRow.actionType === "SEND_TEMPLATE_MESSAGE") {
    const actTranslations = await db
      .select({
        languageId: productActionTranslation.languageId,
        label: productActionTranslation.label,
        templateBody: productActionTranslation.templateBody,
      })
      .from(productActionTranslation)
      .where(eq(productActionTranslation.actionId, actRow.id));

    const preferred = actTranslations.find((t) => t.languageId === langContext.id);
    const fallback = actTranslations.find((t) => t.languageId === settings.defaultLanguageId);

    const preferredBody =
      preferred?.templateBody && preferred.templateBody.trim().length > 0
        ? preferred.templateBody.trim()
        : null;
    const fallbackBody =
      fallback?.templateBody && fallback.templateBody.trim().length > 0
        ? fallback.templateBody.trim()
        : null;
    const rawBody = preferredBody ?? fallbackBody;

    const keyboard: TelegramInlineKeyboardButton[][] = [
      [{ text: ui.back, callback_data: backTarget }],
    ];
    if (actRow.parentActionId) {
      keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
    }
    keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

    if (!rawBody) {
      await sendOrThrow(transport, {
        chatId,
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    const syntaxCheck = validateActionTemplateBody(rawBody, {
      required: true,
      skipPreviewLengthCheck: true,
    });
    if (!syntaxCheck.success) {
      await sendOrThrow(transport, {
        chatId,
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    const prodTranslations = await db
      .select({
        languageId: productTranslation.languageId,
        name: productTranslation.name,
      })
      .from(productTranslation)
      .where(eq(productTranslation.productId, actRow.productId));

    const preferredProd = prodTranslations.find((t) => t.languageId === langContext.id);
    const fallbackProd = prodTranslations.find((t) => t.languageId === settings.defaultLanguageId);
    const productName = preferredProd?.name ?? fallbackProd?.name ?? actionCheck.productRow!.slug;

    const first = user.first_name ? user.first_name.trim() : "";
    const last = user.last_name ? user.last_name.trim() : "";
    const nameParts = [first, last].filter((part) => part.length > 0);
    const customerName = nameParts.length > 0 ? nameParts.join(" ") : ui.customerFallback;

    const priceStr = `${actionCheck.productRow!.price} ${settings.currency}`;

    const renderedText = interpolateActionTemplate(rawBody, {
      store_name: settings.displayName,
      product_name: productName,
      customer_name: customerName,
      price: priceStr,
    });

    await sendOrThrow(transport, {
      chatId,
      text: renderedText,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // D. OPEN_URL
  if (actRow.actionType === "OPEN_URL") {
    const urlValidation = validateHttpsUrl(actRow.url);
    const keyboard: TelegramInlineKeyboardButton[][] = [];

    if (!urlValidation.success) {
      keyboard.push([{ text: ui.back, callback_data: backTarget }]);
      if (actRow.parentActionId) {
        keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
      }
      keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    const actTranslations = await db
      .select({
        languageId: productActionTranslation.languageId,
        label: productActionTranslation.label,
      })
      .from(productActionTranslation)
      .where(eq(productActionTranslation.actionId, actRow.id));

    const preferred = actTranslations.find((t) => t.languageId === langContext.id);
    const fallback = actTranslations.find((t) => t.languageId === settings.defaultLanguageId);
    const label = preferred?.label ?? fallback?.label ?? (langContext.isRtl ? "رابط" : "Link");

    keyboard.push([{ text: ui.openLink, url: urlValidation.data }]);
    keyboard.push([{ text: ui.back, callback_data: backTarget }]);
    if (actRow.parentActionId) {
      keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
    }
    keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: label,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // E. NAVIGATE_CATALOG
  if (actRow.actionType === "NAVIGATE_CATALOG") {
    const hasCat = Boolean(actRow.navigateCategoryId);
    const hasProd = Boolean(actRow.navigateProductId);

    const unavailableKeyboard: TelegramInlineKeyboardButton[][] = [
      [{ text: ui.back, callback_data: backTarget }],
    ];
    if (actRow.parentActionId) {
      unavailableKeyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
    }
    unavailableKeyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

    if ((!hasCat && !hasProd) || (hasCat && hasProd)) {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: unavailableKeyboard },
      });
      return;
    }

    if (hasCat) {
      const catId = actRow.navigateCategoryId!;
      if (!UUID_REGEX.test(catId)) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: ui.optionUnavailable,
          replyMarkup: { inline_keyboard: unavailableKeyboard },
        });
        return;
      }

      const catCheck = await isCategoryHierarchyActive(db, catId);
      if (!catCheck.valid || !catCheck.categoryRow) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: ui.categoryUnavailable,
          replyMarkup: { inline_keyboard: unavailableKeyboard },
        });
        return;
      }

      await renderCategory(
        db,
        transport,
        chatId,
        messageId,
        catCheck.categoryRow,
        settings,
        langContext,
        ui,
        1,
      );
      return;
    }

    if (hasProd) {
      const prodId = actRow.navigateProductId!;
      if (!UUID_REGEX.test(prodId)) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: ui.optionUnavailable,
          replyMarkup: { inline_keyboard: unavailableKeyboard },
        });
        return;
      }

      const prodCheck = await isProductHierarchyActive(db, prodId);
      if (!prodCheck.valid || !prodCheck.productRow) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: ui.productUnavailable,
          replyMarkup: { inline_keyboard: unavailableKeyboard },
        });
        return;
      }

      await renderProductCard(
        db,
        transport,
        chatId,
        messageId,
        user,
        prodId,
        settings,
        langContext,
        ui,
        manualPaymentPrototypeEnabled,
      );
      return;
    }
  }

  // F. START_INQUIRY
  if (actRow.actionType === "START_INQUIRY") {
    if (!journeyOptions || journeyOptions.updateId <= 0 || !journeyOptions.attemptId) {
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
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    await handleProductInquiryCallback(db, transport, {
      chatId,
      messageId,
      user,
      actionRow: actRow,
      productRow: actionCheck.productRow!,
      langContext,
      ui,
      backTarget,
      returnToProductTarget,
      options: journeyOptions,
    });
    return;
  }

  // G. OPEN_SUPPORT
  if (actRow.actionType === "OPEN_SUPPORT") {
    if (!journeyOptions || journeyOptions.updateId <= 0 || !journeyOptions.attemptId) {
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
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    await handleSupportInquiryCallback(db, transport, {
      chatId,
      messageId,
      user,
      actionRow: actRow,
      langContext,
      ui,
      backTarget,
      returnToProductTarget,
      options: journeyOptions,
    });
    return;
  }

  // H. PAYMENT_METHOD prototype instructions
  if (actRow.actionType === "PAYMENT_METHOD") {
    const keyboard: TelegramInlineKeyboardButton[][] = [
      [{ text: ui.back, callback_data: backTarget }],
    ];
    if (actRow.parentActionId) {
      keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
    }
    keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

    if (!manualPaymentPrototypeEnabled) {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    const resolved = await resolvePaymentMethodForAction(db, {
      productId: actRow.productId,
      actionId: actRow.id,
      requestedLanguageId: langContext.id,
      defaultLanguageId: settings.defaultLanguageId,
    });

    if (resolved.status !== "ok") {
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: ui.optionUnavailable,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    const method = resolved.method;
    const instructions =
      method.instructions && method.instructions.trim().length > 0
        ? method.instructions.trim()
        : ui.noPaymentInstructions;

    const bodyText = [
      method.product.name,
      `${ui.priceLabel} ${method.product.price} ${settings.currency}`,
      method.title,
      instructions,
      ui.paymentPrototypeNotice,
    ].join("\n\n");

    const paymentKeyboard: TelegramInlineKeyboardButton[][] = [
      [
        {
          text: ui.contactSellerAboutMethod,
          callback_data: tokens.paymentContact(method.actionId),
        },
      ],
      [{ text: ui.back, callback_data: backTarget }],
    ];
    if (actRow.parentActionId) {
      paymentKeyboard.push([
        { text: ui.returnToProduct, callback_data: returnToProductTarget },
      ]);
    }
    paymentKeyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: bodyText,
      replyMarkup: { inline_keyboard: paymentKeyboard },
    });
    return;
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
    text: ui.actionNotSupported,
    replyMarkup: { inline_keyboard: keyboard },
  });
}
