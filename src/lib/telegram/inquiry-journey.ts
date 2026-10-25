import "server-only";

import type { Database } from "@/db/client";
import {
  category,
  categoryTranslation,
  customer,
  inquiry,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
} from "@/db/schema";
import { interpolateTemplate } from "@/lib/bot-content/placeholders";
import {
  appendInboundCustomerMessage,
  createOrResumeProductInquiry,
  createOrResumeSupportInquiry,
  getActiveCustomerInquiryByReference,
  listActiveCustomerInquiriesPaged,
  readSettings,
  recordTelegramUpdateReceipt,
  resolveMessageText,
  routeAndAppendCustomerText,
  upsertCustomer,
  type TelegramBusinessReceipt,
} from "@/lib/data";
import { editOrThrow, sendOrThrow, type getLocalizedUiStrings } from "./catalog-journey";
import { tokens } from "./tokens";
import type {
  TelegramInlineKeyboardButton,
  TelegramMessage,
  TelegramTransport,
  TelegramUser,
} from "./types";
import { and, eq, isNull } from "drizzle-orm";

export const MAX_SAFEGUARD_DEPTH = 64;

export interface ResolvedLanguageContext {
  id: string;
  code: string;
  label: string;
  isRtl: boolean;
}

export interface InquiryJourneyOptions {
  updateId: number;
  attemptId: string;
  receipt?: TelegramBusinessReceipt | null;
}

/**
 * Walks action ancestry to root, verifying each ancestor is active and OPEN_SUBMENU.
 * Returns ordered root-to-leaf ancestor actions (excluding the terminal action itself).
 */
export async function getActionAncestorsRootToLeaf(
  db: Database,
  actionId: string,
): Promise<{ valid: boolean; ancestors?: (typeof productAction.$inferSelect)[] }> {
  let currentId: string | null = actionId;
  let depth = 0;
  const ancestors: (typeof productAction.$inferSelect)[] = [];
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

    if (currentId !== actionId) {
      if (row.actionType !== "OPEN_SUBMENU") {
        return { valid: false };
      }
      ancestors.push(row);
    }

    currentId = row.parentActionId;
    depth += 1;
  }

  if (currentId !== null) {
    return { valid: false };
  }

  ancestors.reverse();
  return { valid: true, ancestors };
}

/**
 * Walks category ancestry to root, returning ordered root-to-leaf category rows.
 */
export async function getCategoryAncestorsRootToLeaf(
  db: Database,
  categoryId: string,
): Promise<{ valid: boolean; categories?: (typeof category.$inferSelect)[] }> {
  let currentId: string | null = categoryId;
  let depth = 0;
  const categories: (typeof category.$inferSelect)[] = [];
  const visited = new Set<string>();

  while (currentId !== null && depth < MAX_SAFEGUARD_DEPTH) {
    if (visited.has(currentId)) {
      return { valid: false };
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

    categories.push(row);
    currentId = row.parentId;
    depth += 1;
  }

  if (currentId !== null) {
    return { valid: false };
  }

  categories.reverse();
  return { valid: true, categories };
}

/**
 * Recovers an inquiry callback from a committed receipt before evaluating live catalog action/hierarchy state.
 */
export async function recoverAndRenderCommittedInquiryCallback(
  db: Database,
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    messageId: number;
    user: TelegramUser;
    customerRecord: typeof customer.$inferSelect;
    settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>;
    langContext: ResolvedLanguageContext;
    ui: ReturnType<typeof getLocalizedUiStrings>;
    receipt: Extract<TelegramBusinessReceipt, { kind: "inquiry" }>;
  },
): Promise<void> {
  const { chatId, messageId, customerRecord, settings, langContext, ui, receipt } = params;

  // 1. Recover owned inquiry by receipt.inquiryId
  const [inq] = await db
    .select()
    .from(inquiry)
    .where(
      and(
        eq(inquiry.id, receipt.inquiryId),
        eq(inquiry.customerId, customerRecord.id),
      ),
    )
    .limit(1);

  const keyboard: TelegramInlineKeyboardButton[][] = [
    [{ text: ui.home, callback_data: tokens.home() }],
  ];

  if (!inq) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: ui.optionUnavailable,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  const isClosed = inq.status === "closed" || inq.status === "resolved";

  if (inq.productId) {
    const snapshot = inq.productSnapshot as {
      name?: string;
      price?: string;
      currency?: string;
      categoryPath?: string[];
    };
    const snapName = snapshot?.name ?? "Product";
    const snapPrice = snapshot?.price
      ? `${snapshot.price} ${snapshot.currency ?? settings.currency}`
      : `${settings.currency}`;
    const snapOptions = (inq.selectedOptions as string[] | null) ?? null;
    const optString =
      snapOptions && snapOptions.length > 0
        ? `\n${langContext.isRtl ? "الخيارات:" : "Options:"} ${snapOptions.join(" › ")}`
        : "";

    if (isClosed) {
      const closedNotice = langContext.isRtl
        ? `المرجع: ${inq.reference} (مغلق)\nالمنتج: ${snapName}\nالسعر: ${snapPrice}${optString}\n\nتم إغلاق هذه المحادثة.`
        : `Reference: ${inq.reference} (Closed)\nProduct: ${snapName}\nPrice: ${snapPrice}${optString}\n\nThis inquiry is now closed.`;
      await editOrThrow(transport, {
        chatId,
        messageId,
        text: closedNotice,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    let confirmationBody = "";
    const tmpl = await resolveMessageText(db, {
      templateKey: "inquiry_received",
      languageCode: langContext.code,
    });
    if (tmpl && tmpl.status === "resolved") {
      confirmationBody = interpolateTemplate(tmpl.body, {
        store_name: settings.displayName,
        product_name: snapName,
      });
    } else {
      confirmationBody = langContext.isRtl
        ? `شكرًا لاستفسارك عن ${snapName} في ${settings.displayName}.`
        : `Thank you for your inquiry about ${snapName} at ${settings.displayName}.`;
    }

    const details = langContext.isRtl
      ? `\n\nالمرجع: ${inq.reference}\nالسعر: ${snapPrice}${optString}\n\nيرجى إرسال رسالتك هنا للتواصل معنا.`
      : `\n\nReference: ${inq.reference}\nPrice: ${snapPrice}${optString}\n\nPlease send your message here to communicate with us.`;

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: confirmationBody + details,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  const catNotice = inq.category
    ? `\n${langContext.isRtl ? "القسم:" : "Category:"} ${inq.category}`
    : "";

  if (isClosed) {
    const closedNotice = langContext.isRtl
      ? `المرجع: ${inq.reference} (مغلق)${catNotice}\n\nتم إغلاق طلب الدعم هذا.`
      : `Reference: ${inq.reference} (Closed)${catNotice}\n\nThis support inquiry is now closed.`;
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: closedNotice,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  let confirmationBody = "";
  const tmpl = await resolveMessageText(db, {
    templateKey: "support_received",
    languageCode: langContext.code,
  });
  if (tmpl && tmpl.status === "resolved") {
    confirmationBody = interpolateTemplate(tmpl.body, {
      store_name: settings.displayName,
    });
  } else {
    confirmationBody = langContext.isRtl
      ? `شكرًا لتواصلك مع الدعم في ${settings.displayName}.`
      : `Thank you for contacting ${settings.displayName} support.`;
  }

  const details = langContext.isRtl
    ? `\n\nالمرجع: ${inq.reference}${catNotice}\n\nيرجى إرسال رسالتك هنا للتواصل معنا.`
    : `\n\nReference: ${inq.reference}${catNotice}\n\nPlease send your message here to communicate with us.`;

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: confirmationBody + details,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

/**
 * Handles START_INQUIRY inline action button tap.
 */
export async function handleProductInquiryCallback(
  db: Database,
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    messageId: number;
    user: TelegramUser;
    actionRow: typeof productAction.$inferSelect;
    productRow: typeof product.$inferSelect;
    langContext: ResolvedLanguageContext;
    ui: ReturnType<typeof getLocalizedUiStrings>;
    backTarget: string;
    returnToProductTarget: string;
    options: InquiryJourneyOptions;
  },
): Promise<void> {
  const {
    chatId,
    messageId,
    user,
    actionRow,
    productRow,
    langContext,
    ui,
    backTarget,
    returnToProductTarget,
    options,
  } = params;

  // 1. Ensure customer is upserted
  const customerRecord = await upsertCustomer(db, {
    telegramId: user.id,
    telegramUsername: user.username ?? null,
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    languageCode: user.language_code ?? null,
  });

  if (customerRecord.isBlocked) {
    return;
  }

  const settings = await readSettings(db);
  const defaultCurrency = settings?.currency ?? "SAR";
  const displayName = settings?.displayName ?? "Store";
  const defaultLangId = settings?.defaultLanguageId ?? "";

  // 2. Resolve navigation keyboard
  const keyboard: TelegramInlineKeyboardButton[][] = [
    [{ text: ui.back, callback_data: backTarget }],
  ];
  if (actionRow.parentActionId) {
    keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
  }
  keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

  // 3. Resolve ancestors root-to-leaf for option path
  const ancestorsCheck = await getActionAncestorsRootToLeaf(db, actionRow.id);
  if (!ancestorsCheck.valid || !ancestorsCheck.ancestors) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: ui.optionUnavailable,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  const selectedOptions: string[] = [];
  for (const ancestor of ancestorsCheck.ancestors) {
    const translations = await db
      .select({
        languageId: productActionTranslation.languageId,
        label: productActionTranslation.label,
      })
      .from(productActionTranslation)
      .where(eq(productActionTranslation.actionId, ancestor.id));

    const preferred = translations.find((t) => t.languageId === langContext.id);
    const fallback = translations.find((t) => t.languageId === defaultLangId);
    selectedOptions.push(preferred?.label ?? fallback?.label ?? "Option");
  }

  // 4. Resolve category path root-to-leaf
  const categoryCheck = await getCategoryAncestorsRootToLeaf(db, productRow.categoryId);
  const categoryPath: string[] = [];
  if (categoryCheck.valid && categoryCheck.categories) {
    for (const cat of categoryCheck.categories) {
      const translations = await db
        .select({
          languageId: categoryTranslation.languageId,
          name: categoryTranslation.name,
        })
        .from(categoryTranslation)
        .where(eq(categoryTranslation.categoryId, cat.id));

      const preferred = translations.find((t) => t.languageId === langContext.id);
      const fallback = translations.find((t) => t.languageId === defaultLangId);
      categoryPath.push(preferred?.name ?? fallback?.name ?? cat.slug);
    }
  }

  // 5. Resolve localized product name
  const prodTranslations = await db
    .select({
      languageId: productTranslation.languageId,
      name: productTranslation.name,
    })
    .from(productTranslation)
    .where(eq(productTranslation.productId, productRow.id));

  const preferredProd = prodTranslations.find((t) => t.languageId === langContext.id);
  const fallbackProd = prodTranslations.find((t) => t.languageId === defaultLangId);
  const productName = preferredProd?.name ?? fallbackProd?.name ?? productRow.slug;

  const productSnapshot = {
    productId: productRow.id,
    name: productName,
    price: productRow.price,
    currency: defaultCurrency,
    categoryPath,
  };

  // 6. Atomic create or resume
  const inqResult = await createOrResumeProductInquiry(db, {
    customerId: customerRecord.id,
    productId: productRow.id,
    productSnapshot,
    selectedOptions: selectedOptions.length > 0 ? selectedOptions : null,
    updateId: options.updateId,
    attemptId: options.attemptId,
  });

  const activeInquiry = inqResult.inquiry;
  const activeSnapshot = activeInquiry.productSnapshot as {
    name?: string;
    price?: string;
    currency?: string;
  };
  const activePriceStr = activeSnapshot?.price
    ? `${activeSnapshot.price} ${activeSnapshot.currency ?? defaultCurrency}`
    : `${productRow.price} ${defaultCurrency}`;
  const activeProductName = activeSnapshot?.name ?? productName;

  // 7. Format confirmation
  let confirmationBody = "";
  const tmpl = await resolveMessageText(db, {
    templateKey: "inquiry_received",
    languageCode: langContext.code,
  });
  if (tmpl && tmpl.status === "resolved") {
    confirmationBody = interpolateTemplate(tmpl.body, {
      store_name: displayName,
      product_name: activeProductName,
    });
  } else {
    confirmationBody = langContext.isRtl
      ? `شكرًا لاستفسارك عن ${activeProductName} في ${displayName}.`
      : `Thank you for your inquiry about ${activeProductName} at ${displayName}.`;
  }

  const activeOptions = (activeInquiry.selectedOptions as string[] | null) ?? null;
  const optString =
    activeOptions && activeOptions.length > 0
      ? `\n${langContext.isRtl ? "الخيارات:" : "Options:"} ${activeOptions.join(" › ")}`
      : "";

  const details = langContext.isRtl
    ? `\n\nالمرجع: ${activeInquiry.reference}\nالسعر: ${activePriceStr}${optString}\n\nيرجى إرسال رسالتك هنا للتواصل معنا.`
    : `\n\nReference: ${activeInquiry.reference}\nPrice: ${activePriceStr}${optString}\n\nPlease send your message here to communicate with us.`;

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: confirmationBody + details,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

/**
 * Handles OPEN_SUPPORT inline action button tap.
 */
export async function handleSupportInquiryCallback(
  db: Database,
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    messageId: number;
    user: TelegramUser;
    actionRow: typeof productAction.$inferSelect;
    langContext: ResolvedLanguageContext;
    ui: ReturnType<typeof getLocalizedUiStrings>;
    backTarget: string;
    returnToProductTarget: string;
    options: InquiryJourneyOptions;
  },
): Promise<void> {
  const {
    chatId,
    messageId,
    user,
    actionRow,
    langContext,
    ui,
    backTarget,
    returnToProductTarget,
    options,
  } = params;

  // 1. Ensure customer is upserted
  const customerRecord = await upsertCustomer(db, {
    telegramId: user.id,
    telegramUsername: user.username ?? null,
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    languageCode: user.language_code ?? null,
  });

  if (customerRecord.isBlocked) {
    return;
  }

  const settings = await readSettings(db);
  const displayName = settings?.displayName ?? "Store";

  // 2. Validate configured support_category against current bot_setting.support_category
  const config = (actionRow.actionConfig as { support_category?: string } | null) ?? {};
  const supportCategory = config.support_category?.trim() || null;

  const keyboard: TelegramInlineKeyboardButton[][] = [
    [{ text: ui.back, callback_data: backTarget }],
  ];
  if (actionRow.parentActionId) {
    keyboard.push([{ text: ui.returnToProduct, callback_data: returnToProductTarget }]);
  }
  keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

  if (supportCategory && !(settings?.supportCategory ?? []).includes(supportCategory)) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: langContext.isRtl
        ? "قسم الدعم المطلوب غير متاح حالياً."
        : "This support category is currently unavailable.",
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // 3. Atomic create or resume general support inquiry
  const inqResult = await createOrResumeSupportInquiry(db, {
    customerId: customerRecord.id,
    category: supportCategory,
    updateId: options.updateId,
    attemptId: options.attemptId,
  });

  const activeInquiry = inqResult.inquiry;
  const catNotice = activeInquiry.category
    ? `\n${langContext.isRtl ? "القسم:" : "Category:"} ${activeInquiry.category}`
    : "";

  let confirmationBody = "";
  const tmpl = await resolveMessageText(db, {
    templateKey: "support_received",
    languageCode: langContext.code,
  });
  if (tmpl && tmpl.status === "resolved") {
    confirmationBody = interpolateTemplate(tmpl.body, {
      store_name: displayName,
    });
  } else {
    confirmationBody = langContext.isRtl
      ? `شكرًا لتواصلك مع الدعم في ${displayName}.`
      : `Thank you for contacting ${displayName} support.`;
  }

  const details = langContext.isRtl
    ? `\n\nالمرجع: ${activeInquiry.reference}${catNotice}\n\nيرجى إرسال رسالتك هنا للتواصل معنا.`
    : `\n\nReference: ${activeInquiry.reference}${catNotice}\n\nPlease send your message here to communicate with us.`;

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: confirmationBody + details,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

/**
 * Helper to build the text and inline keyboard for ambiguous multiple active inquiries.
 */
function buildAmbiguousResponse(
  inquiries: (typeof inquiry.$inferSelect)[],
  page: number,
  totalPages: number,
  langContext: ResolvedLanguageContext,
  ui: ReturnType<typeof getLocalizedUiStrings>,
): { text: string; replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] } } {
  const referencesList = inquiries.map((inq) => {
    let contextName = "Support";
    if (inq.productId) {
      const snapshot = inq.productSnapshot as { name?: string } | null;
      contextName = snapshot?.name ?? "Product Inquiry";
    } else if (inq.category) {
      contextName = `Support (${inq.category})`;
    }
    return `• ${inq.reference}: ${contextName}`;
  });

  const exampleRef = inquiries[0]?.reference ?? "INQ-ABC123";
  const prompt = langContext.isRtl
    ? `لم يتم حفظ رسالتك نظراً لوجود عدة محادثات نشطة. يرجى تحديد المحادثة التي تود الرد عليها:\n\n` +
      referencesList.join("\n") +
      `\n\nمثال:\n/reply ${exampleRef} رسالتك\n\nيرجى إعادة إرسال رسالتك باستخدام الصيغة أعلاه.`
    : `Your message was not saved because you have multiple active inquiries. Please specify which conversation to reply to:\n\n` +
      referencesList.join("\n") +
      `\n\nExample:\n/reply ${exampleRef} Your message\n\nPlease resend your message using the command above.`;

  const keyboard: TelegramInlineKeyboardButton[][] = [];
  const navRow: TelegramInlineKeyboardButton[] = [];

  if (page > 1) {
    navRow.push({ text: ui.prevPage, callback_data: tokens.inquiries(page - 1) });
  }
  if (page < totalPages) {
    navRow.push({ text: ui.nextPage, callback_data: tokens.inquiries(page + 1) });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }
  keyboard.push([{ text: ui.home, callback_data: tokens.home() }]);

  return { text: prompt, replyMarkup: { inline_keyboard: keyboard } };
}

/**
 * Renders the paginated active inquiries list when customer taps pagination buttons.
 */
export async function renderCustomerInquiriesList(
  db: Database,
  transport: TelegramTransport,
  chatId: number | string,
  messageId: number,
  customerId: string,
  page: number,
  langContext: ResolvedLanguageContext,
  ui: ReturnType<typeof getLocalizedUiStrings>,
): Promise<void> {
  const paged = await listActiveCustomerInquiriesPaged(db, customerId, {
    page,
    pageSize: 5,
  });

  const resp = buildAmbiguousResponse(
    paged.inquiries,
    paged.page,
    paged.totalPages,
    langContext,
    ui,
  );

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: resp.text,
    replyMarkup: resp.replyMarkup,
  });
}

const START_COMMAND_REGEX = /^\/start(?:@\w+)?(?:\s+.*)?$/i;
const ANY_SLASH_COMMAND_REGEX = /^\/[a-zA-Z0-9_]+(?:@\w+)?(?:\s+[\s\S]*)?$/;

/**
 * Handles incoming private-chat messages: commands, /reply routing, atomic free-text routing, and non-text rejection.
 */
export async function handleIncomingMessage(
  db: Database,
  transport: TelegramTransport,
  msg: TelegramMessage,
  options: InquiryJourneyOptions,
  startCommandHandler: (db: Database, transport: TelegramTransport, msg: TelegramMessage) => Promise<void>,
  resolveLangContext: (db: Database, telegramId: number, fallbackDefaultLangId: string) => Promise<ResolvedLanguageContext>,
  uiStringsGetter: (isRtl: boolean) => ReturnType<typeof getLocalizedUiStrings>,
): Promise<void> {
  const from = msg.from;
  if (!from) {
    return;
  }

  const customerRecord = await upsertCustomer(db, {
    telegramId: from.id,
    telegramUsername: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    languageCode: from.language_code ?? null,
  });

  if (customerRecord.isBlocked) {
    return;
  }

  const settings = await readSettings(db);
  const defaultLangId = settings?.defaultLanguageId ?? "";
  const langContext = await resolveLangContext(db, from.id, defaultLangId);
  const ui = uiStringsGetter(langContext.isRtl);

  // 1. Retry recovery from durable receipt
  if (options.receipt) {
    const receipt = options.receipt;
    if (receipt.kind === "message") {
      const ack = receipt.isNewSupport
        ? langContext.isRtl
          ? `تم فتح طلب الدعم (المرجع: ${receipt.reference}). لقد استلمنا رسالتك.`
          : `Support inquiry opened (Reference: ${receipt.reference}). We received your message.`
        : langContext.isRtl
          ? `تم استلام رسالتك للمحادثة ${receipt.reference}. يمكنك مواصلة إرسال الرسائل هنا.`
          : `Message received for inquiry ${receipt.reference}. You can continue sending messages here.`;
      await sendOrThrow(transport, { chatId: msg.chat.id, text: ack });
      return;
    }

    if (receipt.kind === "ambiguous") {
      const paged = await listActiveCustomerInquiriesPaged(db, customerRecord.id, {
        page: 1,
        pageSize: 5,
      });
      const resp = buildAmbiguousResponse(paged.inquiries, 1, paged.totalPages, langContext, ui);
      await sendOrThrow(transport, {
        chatId: msg.chat.id,
        text: resp.text,
        replyMarkup: resp.replyMarkup,
      });
      return;
    }

    if (receipt.kind === "guidance") {
      await sendOrThrow(transport, { chatId: msg.chat.id, text: receipt.notice });
      return;
    }
  }

  // 2. Reject unsupported non-text content (photos, audio, stickers, etc.)
  if (msg.text === undefined || msg.text === null) {
    const notice = langContext.isRtl
      ? "نستقبل الرسائل النصية فقط في هذا الإصدار."
      : "We only support text messages in this version.";
    const recorded = await recordTelegramUpdateReceipt(db, {
      updateId: options.updateId,
      attemptId: options.attemptId,
      receipt: { kind: "guidance", notice },
    });
    if (recorded) {
      await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
    }
    return;
  }

  const rawText = msg.text;

  // 3. Reject overlong fabricated text (> 4096 chars)
  if (rawText.length > 4096) {
    const notice = langContext.isRtl
      ? "الرسالة طويلة جداً (الحد الأقصى 4096 حرفاً)."
      : "Message is too long (maximum 4096 characters).";
    const recorded = await recordTelegramUpdateReceipt(db, {
      updateId: options.updateId,
      attemptId: options.attemptId,
      receipt: { kind: "guidance", notice },
    });
    if (recorded) {
      await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
    }
    return;
  }

  // 4. Reject blank message (whitespace only)
  if (rawText.trim().length === 0) {
    const notice = langContext.isRtl
      ? "يرجى إرسال رسالة غير فارغة."
      : "Please send a non-empty message.";
    const recorded = await recordTelegramUpdateReceipt(db, {
      updateId: options.updateId,
      attemptId: options.attemptId,
      receipt: { kind: "guidance", notice },
    });
    if (recorded) {
      await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
    }
    return;
  }

  // 5. Slash commands handling
  const trimmed = rawText.trim();
  if (trimmed.startsWith("/")) {
    if (START_COMMAND_REGEX.test(trimmed)) {
      await startCommandHandler(db, transport, msg);
      return;
    }

    if (trimmed.toLowerCase().startsWith("/reply")) {
      const replyMatch = rawText.match(/^\/reply(?:@\w+)?(?:\s+(\S+)(?:[ \t\r\n]([\s\S]*))?)?$/i);
      const refArg = replyMatch?.[1]?.trim();
      const bodyArg = replyMatch?.[2] ?? "";

      if (!refArg || bodyArg.trim().length === 0) {
        const notice = langContext.isRtl
          ? "يرجى استخدام الصيغة:\n/reply <المرجع> <رسالتك>\n\nمثال:\n/reply INQ-ABC123 مرحباً"
          : "Please use the format:\n/reply <REFERENCE> <your message>\n\nExample:\n/reply INQ-ABC123 Hello";
        const recorded = await recordTelegramUpdateReceipt(db, {
          updateId: options.updateId,
          attemptId: options.attemptId,
          receipt: { kind: "guidance", notice },
        });
        if (recorded) {
          await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
        }
        return;
      }

      // Resolve inquiry reference strictly within authenticated customer's inquiries
      const targetInquiry = await getActiveCustomerInquiryByReference(db, {
        customerId: customerRecord.id,
        reference: refArg,
      });

      if (!targetInquiry) {
        const notice = langContext.isRtl
          ? "المحادثة غير موجودة أو تم إغلاقها بالفعل. يرجى التأكد من المرجع والمحاولة مجدداً."
          : "Inquiry not found or already closed. Please check the reference and try again.";
        const recorded = await recordTelegramUpdateReceipt(db, {
          updateId: options.updateId,
          attemptId: options.attemptId,
          receipt: { kind: "guidance", notice },
        });
        if (recorded) {
          await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
        }
        return;
      }

      // Append inbound message atomically with receipt
      await appendInboundCustomerMessage(db, {
        customerId: customerRecord.id,
        inquiryId: targetInquiry.id,
        reference: targetInquiry.reference,
        body: bodyArg,
        telegramMessageId: msg.message_id,
        updateId: options.updateId,
        attemptId: options.attemptId,
      });

      const ack = langContext.isRtl
        ? `تم استلام رسالتك للمحادثة ${targetInquiry.reference}. يمكنك مواصلة إرسال الرسائل هنا.`
        : `Message received for inquiry ${targetInquiry.reference}. You can continue sending messages here.`;
      await sendOrThrow(transport, { chatId: msg.chat.id, text: ack });
      return;
    }

    // Any other unknown slash command (including multiline): provide safe guidance, do NOT store
    if (ANY_SLASH_COMMAND_REGEX.test(rawText)) {
      const notice = langContext.isRtl
        ? "لتصفح المتجر، يرجى إرسال /start"
        : "To browse our catalog, please send /start";
      const recorded = await recordTelegramUpdateReceipt(db, {
        updateId: options.updateId,
        attemptId: options.attemptId,
        receipt: { kind: "guidance", notice },
      });
      if (recorded) {
        await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
      }
      return;
    }
  }

  // 6. Ordinary free text routing: atomic operation in one protected transaction
  // Preserve exact customer body (rawText)
  const routeResult = await routeAndAppendCustomerText(db, {
    customerId: customerRecord.id,
    body: rawText,
    telegramMessageId: msg.message_id,
    updateId: options.updateId,
    attemptId: options.attemptId,
  });

  if (routeResult.status === "saved") {
    const ack = routeResult.isNewSupport
      ? langContext.isRtl
        ? `تم فتح طلب الدعم (المرجع: ${routeResult.inquiry.reference}). لقد استلمنا رسالتك.`
        : `Support inquiry opened (Reference: ${routeResult.inquiry.reference}). We received your message.`
      : langContext.isRtl
        ? `تم استلام رسالتك للمحادثة ${routeResult.inquiry.reference}. يمكنك مواصلة إرسال الرسائل هنا.`
        : `Message received for inquiry ${routeResult.inquiry.reference}. You can continue sending messages here.`;
    await sendOrThrow(transport, { chatId: msg.chat.id, text: ack });
    return;
  }

  // Ambiguous (> 1 active inquiry)
  const paged = await listActiveCustomerInquiriesPaged(db, customerRecord.id, {
    page: 1,
    pageSize: 5,
  });
  const resp = buildAmbiguousResponse(paged.inquiries, 1, paged.totalPages, langContext, ui);
  await sendOrThrow(transport, {
    chatId: msg.chat.id,
    text: resp.text,
    replyMarkup: resp.replyMarkup,
  });
}
