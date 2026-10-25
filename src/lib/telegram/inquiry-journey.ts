import "server-only";

import type { Database } from "@/db/client";
import {
  category,
  categoryTranslation,
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
  listActiveCustomerInquiries,
  readSettings,
  recordTelegramUpdateReceipt,
  resolveMessageText,
  upsertCustomer,
  type TelegramBusinessReceipt,
} from "@/lib/data";
import { splitMessageText } from "./catalog-journey";
import { tokens } from "./tokens";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "./transport";
import type {
  TelegramInlineKeyboardButton,
  TelegramMessage,
  TelegramTransport,
  TelegramUser,
} from "./types";
import { TelegramTransportError } from "./types";
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

async function sendOrThrow(
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    text: string;
  },
): Promise<void> {
  const chunks = splitMessageText(params.text, TELEGRAM_MAX_MESSAGE_CHARS);
  for (const chunk of chunks) {
    const res = await transport.sendMessage({
      chatId: params.chatId,
      text: chunk,
    });
    if (!res.ok) {
      throw new TelegramTransportError(
        res.error ?? "Failed to send Telegram message",
        {
          errorKind: res.errorKind ?? "api_error",
          retryAfterSeconds: res.retryAfterSeconds,
        },
      );
    }
  }
}

async function editOrThrow(
  transport: TelegramTransport,
  params: {
    chatId: number | string;
    messageId: number;
    text: string;
    replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
  },
): Promise<void> {
  const chunks = splitMessageText(params.text, TELEGRAM_MAX_MESSAGE_CHARS);
  const firstChunk = chunks[0] ?? "";

  const res = await transport.editMessageText({
    chatId: params.chatId,
    messageId: params.messageId,
    text: firstChunk,
    replyMarkup: params.replyMarkup,
  });

  if (!res.ok) {
    throw new TelegramTransportError(
      res.error ?? "Failed to edit Telegram message",
      {
        errorKind: res.errorKind ?? "api_error",
        retryAfterSeconds: res.retryAfterSeconds,
      },
    );
  }

  // If text exceeded single message length, send remaining chunks sequentially
  for (let i = 1; i < chunks.length; i++) {
    await sendOrThrow(transport, {
      chatId: params.chatId,
      text: chunks[i],
    });
  }
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
    ui: { back: string; home: string; returnToProduct: string; optionUnavailable: string };
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

  // 3. Check for committed receipt (retry recovery)
  if (options.receipt && options.receipt.kind === "inquiry") {
    const receipt = options.receipt;
    const snapshot = receipt.productSnapshot as { name?: string; price?: string; currency?: string } | undefined;
    const snapshotName = snapshot?.name ?? "Product";
    const snapshotPrice = snapshot?.price
      ? `${snapshot.price} ${snapshot?.currency ?? defaultCurrency}`
      : `${productRow.price} ${defaultCurrency}`;

    let confirmationBody = "";
    const tmpl = await resolveMessageText(db, {
      templateKey: "inquiry_received",
      languageCode: langContext.code,
    });
    if (tmpl && tmpl.status === "resolved") {
      confirmationBody = interpolateTemplate(tmpl.body, {
        store_name: displayName,
        product_name: snapshotName,
      });
    } else {
      confirmationBody = langContext.isRtl
        ? `شكرًا لاستفسارك عن ${snapshotName} في ${displayName}.`
        : `Thank you for your inquiry about ${snapshotName} at ${displayName}.`;
    }

    const details = langContext.isRtl
      ? `\n\nالمرجع: ${receipt.reference}\nالسعر: ${snapshotPrice}\n\nيرجى إرسال رسالتك هنا للتواصل معنا.`
      : `\n\nReference: ${receipt.reference}\nPrice: ${snapshotPrice}\n\nPlease send your message here to communicate with us.`;

    await editOrThrow(transport, {
      chatId,
      messageId,
      text: confirmationBody + details,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // 4. Resolve ancestors root-to-leaf for option path
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

  // 5. Resolve category path root-to-leaf
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

  // 6. Resolve localized product name
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

  // 7. Atomic create or resume
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

  // 8. Format confirmation
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
    ui: { back: string; home: string; returnToProduct: string; optionUnavailable: string };
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
    // Configured category removed: fail closed with safe feedback
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

  // 3. Check for committed receipt (retry recovery)
  if (options.receipt && options.receipt.kind === "inquiry") {
    const receipt = options.receipt;
    const catNotice = supportCategory
      ? `\n${langContext.isRtl ? "القسم:" : "Category:"} ${supportCategory}`
      : "";

    const text = langContext.isRtl
      ? `شكرًا لتواصلك مع الدعم في ${displayName}.\n\nالمرجع: ${receipt.reference}${catNotice}\n\nيرجى إرسال رسالتك هنا للتواصل معنا.`
      : `Thank you for contacting ${displayName} support.\n\nReference: ${receipt.reference}${catNotice}\n\nPlease send your message here to communicate with us.`;

    await editOrThrow(transport, {
      chatId,
      messageId,
      text,
      replyMarkup: { inline_keyboard: keyboard },
    });
    return;
  }

  // 4. Atomic create or resume general support inquiry
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

  const text = langContext.isRtl
    ? `شكرًا لتواصلك مع الدعم في ${displayName}.\n\nالمرجع: ${activeInquiry.reference}${catNotice}\n\nيرجى إرسال رسالتك هنا للتواصل معنا.`
    : `Thank you for contacting ${displayName} support.\n\nReference: ${activeInquiry.reference}${catNotice}\n\nPlease send your message here to communicate with us.`;

  await editOrThrow(transport, {
    chatId,
    messageId,
    text,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

const START_COMMAND_REGEX = /^\/start(?:@\w+)?(?:\s+.*)?$/i;
const REPLY_COMMAND_REGEX = /^\/reply(?:@\w+)?(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/i;
const ANY_SLASH_COMMAND_REGEX = /^\/[a-zA-Z0-9_]+(?:@\w+)?(?:\s+.*)?$/;

/**
 * Handles incoming private-chat messages: commands, /reply routing, free-text routing, and non-text rejection.
 */
export async function handleIncomingMessage(
  db: Database,
  transport: TelegramTransport,
  msg: TelegramMessage,
  options: InquiryJourneyOptions,
  startCommandHandler: (db: Database, transport: TelegramTransport, msg: TelegramMessage) => Promise<void>,
  resolveLangContext: (db: Database, telegramId: number, fallbackDefaultLangId: string) => Promise<ResolvedLanguageContext>,
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

  // 1. Retry recovery from durable receipt
  if (options.receipt) {
    const receipt = options.receipt;
    if (receipt.kind === "message") {
      const ack = langContext.isRtl
        ? `تم استلام رسالتك للمحادثة ${receipt.reference}. يمكنك مواصلة إرسال الرسائل هنا.`
        : `Message received for inquiry ${receipt.reference}. You can continue sending messages here.`;
      await sendOrThrow(transport, { chatId: msg.chat.id, text: ack });
      return;
    }

    if (receipt.kind === "ambiguous") {
      const exampleRef = receipt.activeReferences[0] ?? "INQ-XXXX";
      const prompt = langContext.isRtl
        ? `لم يتم حفظ رسالتك نظراً لوجود عدة محادثات نشطة. يرجى تحديد المحادثة المطلوبة:\n\n` +
          receipt.activeReferences.map((r) => `• ${r}`).join("\n") +
          `\n\nمثال:\n/reply ${exampleRef} رسالتك\n\nيرجى إعادة إرسال رسالتك باستخدام الصيغة أعلاه.`
        : `Your message was not saved because you have multiple active inquiries. Please specify which conversation to reply to:\n\n` +
          receipt.activeReferences.map((r) => `• ${r}`).join("\n") +
          `\n\nExample:\n/reply ${exampleRef} Your message\n\nPlease resend your message using the command above.`;
      await sendOrThrow(transport, { chatId: msg.chat.id, text: prompt });
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
    await recordTelegramUpdateReceipt(db, {
      updateId: options.updateId,
      attemptId: options.attemptId,
      receipt: { kind: "guidance", notice },
    });
    await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
    return;
  }

  const rawText = msg.text;

  // 3. Reject overlong fabricated text (> 4096 chars)
  if (rawText.length > 4096) {
    const notice = langContext.isRtl
      ? "الرسالة طويلة جداً (الحد الأقصى 4096 حرفاً)."
      : "Message is too long (maximum 4096 characters).";
    await recordTelegramUpdateReceipt(db, {
      updateId: options.updateId,
      attemptId: options.attemptId,
      receipt: { kind: "guidance", notice },
    });
    await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
    return;
  }

  // 4. Reject blank message (whitespace only)
  const trimmedText = rawText.trim();
  if (trimmedText.length === 0) {
    const notice = langContext.isRtl
      ? "يرجى إرسال رسالة غير فارغة."
      : "Please send a non-empty message.";
    await recordTelegramUpdateReceipt(db, {
      updateId: options.updateId,
      attemptId: options.attemptId,
      receipt: { kind: "guidance", notice },
    });
    await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
    return;
  }

  // 5. Slash commands handling
  if (trimmedText.startsWith("/")) {
    if (START_COMMAND_REGEX.test(trimmedText)) {
      await startCommandHandler(db, transport, msg);
      return;
    }

    if (trimmedText.toLowerCase().startsWith("/reply")) {
      const match = trimmedText.match(REPLY_COMMAND_REGEX);
      const refArg = match?.[1]?.trim();
      const bodyArg = match?.[2]?.trim();

      if (!refArg || !bodyArg) {
        const notice = langContext.isRtl
          ? "يرجى استخدام الصيغة:\n/reply <المرجع> <رسالتك>\n\nمثال:\n/reply INQ-ABC123 مرحباً"
          : "Please use the format:\n/reply <REFERENCE> <your message>\n\nExample:\n/reply INQ-ABC123 Hello";
        await recordTelegramUpdateReceipt(db, {
          updateId: options.updateId,
          attemptId: options.attemptId,
          receipt: { kind: "guidance", notice },
        });
        await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
        return;
      }

      // Resolve inquiry reference strictly within authenticated customer's inquiries
      const targetInquiry = await getActiveCustomerInquiryByReference(db, {
        customerId: customerRecord.id,
        reference: refArg,
      });

      if (!targetInquiry) {
        // Unknown, another customer's, resolved, or closed reference: safe feedback
        const notice = langContext.isRtl
          ? "المحادثة غير موجودة أو تم إغلاقها بالفعل. يرجى التأكد من المرجع والمحاولة مجدداً."
          : "Inquiry not found or already closed. Please check the reference and try again.";
        await recordTelegramUpdateReceipt(db, {
          updateId: options.updateId,
          attemptId: options.attemptId,
          receipt: { kind: "guidance", notice },
        });
        await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
        return;
      }

      // Append inbound message atomically with receipt
      await appendInboundCustomerMessage(db, {
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

    // Any other unknown slash command: provide safe guidance, do NOT store
    if (ANY_SLASH_COMMAND_REGEX.test(trimmedText)) {
      const notice = langContext.isRtl
        ? "لتصفح المتجر، يرجى إرسال /start"
        : "To browse our catalog, please send /start";
      await recordTelegramUpdateReceipt(db, {
        updateId: options.updateId,
        attemptId: options.attemptId,
        receipt: { kind: "guidance", notice },
      });
      await sendOrThrow(transport, { chatId: msg.chat.id, text: notice });
      return;
    }
  }

  // 6. Ordinary free text routing
  const activeInquiries = await listActiveCustomerInquiries(db, customerRecord.id, 10);

  // Case 6A: Exactly ONE active inquiry -> Append directly
  if (activeInquiries.length === 1) {
    const target = activeInquiries[0];
    await appendInboundCustomerMessage(db, {
      inquiryId: target.id,
      reference: target.reference,
      body: trimmedText,
      telegramMessageId: msg.message_id,
      updateId: options.updateId,
      attemptId: options.attemptId,
    });

    const ack = langContext.isRtl
      ? `تم استلام رسالتك للمحادثة ${target.reference}. يمكنك مواصلة إرسال الرسائل هنا.`
      : `Message received for inquiry ${target.reference}. You can continue sending messages here.`;
    await sendOrThrow(transport, { chatId: msg.chat.id, text: ack });
    return;
  }

  // Case 6B: ZERO active inquiries -> Create/resume general support (category NULL) and save text
  if (activeInquiries.length === 0) {
    const supportInq = await createOrResumeSupportInquiry(db, {
      customerId: customerRecord.id,
      category: null,
      updateId: options.updateId,
      attemptId: options.attemptId,
    });

    await appendInboundCustomerMessage(db, {
      inquiryId: supportInq.inquiry.id,
      reference: supportInq.inquiry.reference,
      body: trimmedText,
      telegramMessageId: msg.message_id,
      updateId: options.updateId,
      attemptId: options.attemptId,
    });

    const ack = langContext.isRtl
      ? `تم فتح طلب الدعم (المرجع: ${supportInq.inquiry.reference}). لقد استلمنا رسالتك.`
      : `Support inquiry opened (Reference: ${supportInq.inquiry.reference}). We received your message.`;
    await sendOrThrow(transport, { chatId: msg.chat.id, text: ack });
    return;
  }

  // Case 6C: MORE THAN ONE active inquiry -> Do NOT guess, do NOT save text. Require /reply <REF>
  const referencesList = activeInquiries.map((inq) => {
    let contextName = "Support";
    if (inq.productId) {
      const snapshot = inq.productSnapshot as { name?: string } | null;
      contextName = snapshot?.name ?? "Product Inquiry";
    } else if (inq.category) {
      contextName = `Support (${inq.category})`;
    }
    return `• ${inq.reference}: ${contextName}`;
  });

  const exampleRef = activeInquiries[0].reference;
  const prompt = langContext.isRtl
    ? `لم يتم حفظ رسالتك نظراً لوجود عدة محادثات نشطة. يرجى تحديد المحادثة التي تود الرد عليها:\n\n` +
      referencesList.join("\n") +
      `\n\nمثال:\n/reply ${exampleRef} رسالتك\n\nيرجى إعادة إرسال رسالتك باستخدام الصيغة أعلاه.`
    : `Your message was not saved because you have multiple active inquiries. Please specify which conversation to reply to:\n\n` +
      referencesList.join("\n") +
      `\n\nExample:\n/reply ${exampleRef} Your message\n\nPlease resend your message using the command above.`;

  await recordTelegramUpdateReceipt(db, {
    updateId: options.updateId,
    attemptId: options.attemptId,
    receipt: {
      kind: "ambiguous",
      activeReferences: activeInquiries.map((i) => i.reference),
    },
  });

  await sendOrThrow(transport, { chatId: msg.chat.id, text: prompt });
}
