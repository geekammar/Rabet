import "server-only";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import {
  getTransactionDb,
  type TransactionDatabase,
} from "@/db/transaction-client";
import {
  listManagedCategories,
  listManagedProducts,
  listManagedProductsInCategory,
  readManagedCategory,
  readManagedProduct,
  type ManagedCatalogContentPlan,
  type ManagedProduct,
} from "@/lib/catalog/managed-storefront";
import {
  addToCart,
  backToCart,
  changeCartQuantity,
  confirmCodOrder,
  confirmVodafoneCashOrder,
  readCartForBuyer,
  readLatestBuyerCodOrder,
  bindVodafoneCashTransferPromptMessage,
  listBuyerOutstandingVodafoneTransfers,
  readCheckoutAvailability,
  readInventoryAvailability,
  readVodafoneCashOrderByPromptReply,
  readVodafoneCashOrderState,
  refreshReview,
  removeCartItem,
  requestVodafoneCashTransferReference,
  saveAddressAndPrepareReview,
  savePhone,
  startCheckout,
  submitVodafoneCashTransferClaim,
  type BuyerOrderChat,
  type CartView,
  type CheckoutReview,
  type CommerceSetting,
  type TransferSnapshot,
  type VodafoneCashOrderState,
} from "@/lib/commerce/orders";
import {
  resolveBuyerLanguage,
  readStoreDefaultLanguage,
  readStoreCatalogLanguageCode,
  saveBuyerLanguagePreference,
  type ResolvedBuyerLanguage,
  type StoreLanguageChoice,
} from "@/lib/data/store-language";
import {
  createStoreScopeForExistingStore,
  type StoreScope,
} from "@/lib/data/store-scope";
import { readStoreTelegramSupportUsername } from "@/lib/data/store-telegram-contact";
import {
  decryptConnectionSecret,
  verifyWebhookSecret,
} from "./connection-secrets";
import {
  claimManagedCartMutation,
  claimManagedTelegramUpdate,
  markManagedTelegramUpdateFailed,
  markManagedTelegramUpdateProcessed,
  type ManagedUpdateAttempt,
} from "./managed-updates";
import { readReadyManagedConnection } from "./manager-provisioning";
import {
  managedCommerceCopy,
  type CommerceCopy,
  type ManagedCommerceLocale,
} from "./managed-commerce-copy";
import {
  buyerLocaleFromLanguageCode,
  isBuyerLocale,
} from "@/lib/commerce/buyer-language";
import { tokens, type ParsedToken } from "./tokens";
import { telegramSupportChatUrl } from "./support-contact";
import {
  classifyErrorToSafeDiagnostic,
  createFetchTelegramTransport,
  formatSafeDiagnostic,
  StandardExecutionDeadline,
  TELEGRAM_MAX_CAPTION_CHARS,
} from "./transport";
import type {
  ExecutionDeadline,
  TelegramErrorKind,
  TelegramInlineKeyboardButton,
  TelegramMessage,
  TelegramSendResult,
  TelegramTransport,
} from "./types";
import { validateIncomingUpdate } from "./webhook";

/**
 * Authenticated webhook for one managed Store Bot.
 *
 * Order of operations is intentional:
 *   1. resolve a ready connection by its random public id;
 *   2. require an active store;
 *   3. authenticate Telegram's secret header against the connection digest;
 *   4. claim the update under `(bot_id, update_id)`;
 *   5. only then perform scoped catalog reads and Telegram sends.
 *
 * No store id from the update, a callback or a URL is an authorization input.
 * The `StoreScope` is minted from the verified connection row.
 */

const PAGE_SIZE = 8;

export interface ManagedWebhookOptions {
  db?: Database;
  /**
   * Transaction-capable commerce client. Production uses the shared
   * postgres-js client; tests pass the disposable PostgreSQL client. The
   * browsing reads keep using the HTTP client above.
   */
  commerceDb?: TransactionDatabase;
  transport?: TelegramTransport;
  executionBudgetMs?: number;
  deadline?: ExecutionDeadline;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function homeKeyboard(
  copy: CommerceCopy,
  languageContext?: string,
): TelegramInlineKeyboardButton[][] {
  return [
    [
      { text: copy.home, callback_data: tokens.home() },
      {
        text: copy.languageButton,
        callback_data: tokens.languages(languageContext),
      },
    ],
  ];
}

function languageKeyboard(
  copy: CommerceCopy,
  currentLocale: ManagedCommerceLocale,
  context: string | null,
): { inline_keyboard: TelegramInlineKeyboardButton[][] } {
  const mark = (locale: ManagedCommerceLocale) =>
    currentLocale === locale ? "✓ " : "";

  return {
    inline_keyboard: [
      [
        {
          text: `${mark("ar")}${copy.languageArabic}`,
          callback_data: tokens.lang("ar", context ?? undefined),
        },
      ],
      [
        {
          text: `${mark("en")}${copy.languageEnglish}`,
          callback_data: tokens.lang("en", context ?? undefined),
        },
      ],
      [{ text: copy.home, callback_data: tokens.home() }],
    ],
  };
}

async function renderLanguageMenu(
  transport: TelegramTransport,
  chatId: number,
  messageId: number | undefined,
  copy: CommerceCopy,
  currentLocale: ManagedCommerceLocale,
  context: string | null = null,
  text = copy.languageTitle,
): Promise<void> {
  const params = {
    chatId,
    text,
    replyMarkup: languageKeyboard(copy, currentLocale, context),
  };

  if (messageId) {
    await editOrThrow(transport, { ...params, messageId });
  } else {
    await sendOrThrow(transport, params);
  }
}

type CodContext = {
  enabled: boolean;
  codEnabled: boolean;
  vodafoneCashEnabled: boolean;
  setting: CommerceSetting | null;
};

type HomeRecovery = BuyerOrderChat & {
  commerceDb: TransactionDatabase | null;
  locale: ManagedCommerceLocale;
};

function homeRecoveryFor(
  commerceDb: TransactionDatabase | null,
  connectionId: string,
  buyerId: number | null,
  chatId: number,
  locale: ManagedCommerceLocale,
): HomeRecovery | undefined {
  if (buyerId === null) return undefined;
  return {
    commerceDb,
    connectionId,
    telegramUserId: buyerId,
    telegramChatId: chatId,
    locale,
  };
}

type LanguageContext = {
  language: ResolvedBuyerLanguage;
  copy: CommerceCopy;
  plan: ManagedCatalogContentPlan;
  storeDefault: StoreLanguageChoice | null;
};

function copyForLocale(locale: ManagedCommerceLocale): CommerceCopy {
  return managedCommerceCopy(locale);
}

function catalogContentPlanFor(
  defaultLanguageCode: string | null,
): ManagedCatalogContentPlan {
  return { defaultLanguageCode };
}

async function languageContextFor(
  db: Database,
  scope: StoreScope,
  buyerId: number | null,
  profileLanguageCode: string | undefined,
): Promise<LanguageContext> {
  const [storeDefault, catalogLanguageCode] = await Promise.all([
    readStoreDefaultLanguage(db, scope.storeId),
    readStoreCatalogLanguageCode(db, scope.storeId),
  ]);
  const plan = catalogContentPlanFor(catalogLanguageCode);

  if (buyerId !== null) {
    const language = await resolveBuyerLanguage(db, {
      storeId: scope.storeId,
      telegramUserId: buyerId,
      profileLanguageCode,
    });

    return {
      language,
      copy: copyForLocale(language.locale),
      plan,
      storeDefault,
    };
  }

  const locale =
    storeDefault && isBuyerLocale(storeDefault.code)
      ? storeDefault.code
      : buyerLocaleFromLanguageCode(profileLanguageCode);
  const language: ResolvedBuyerLanguage = {
    locale,
    source: storeDefault ? "store_default" : "profile",
    storeDefaultCode: storeDefault?.code ?? null,
  };

  return {
    language,
    copy: copyForLocale(locale),
    plan,
    storeDefault,
  };
}

function isLanguageCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "/language" ||
    normalized === "/lang" ||
    normalized === "language" ||
    normalized === "اللغة" ||
    normalized === "اللغة / language"
  );
}

function isCartCommand(text: string, copy: CommerceCopy): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "/cart" ||
    normalized === copy.cart.toLowerCase() ||
    normalized === "cart" ||
    normalized === "السلة"
  );
}

function repliedMessageId(message: TelegramMessage): number | null {
  const replied = (message as { reply_to_message?: unknown }).reply_to_message;
  if (typeof replied !== "object" || replied === null) return null;

  const id = (replied as Record<string, unknown>).message_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function money(value: string, currency: string): string {
  return currency ? `${value} ${currency}` : value;
}

/**
 * The shared managed catalog reader owns `imageUrl` and `availability`.
 *
 * This adapter is deliberately tolerant while the reader contract rolls out in
 * parallel: a reader build that already returns the fields is used as-is, and
 * an older build still renders a text-only card from the existing inventory
 * read. No second catalog query is introduced here.
 */
type ManagedProductContractFields = {
  imageUrl?: string | null;
  availability?: { available: number; inStock: boolean };
};

function productContractFields(product: ManagedProduct): ManagedProductContractFields {
  return product as ManagedProduct & ManagedProductContractFields;
}

function isHttpImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function productImageUrl(product: ManagedProduct): string | null {
  const value = productContractFields(product).imageUrl;
  return isHttpImageUrl(value) ? value.trim() : null;
}

function productAvailability(
  product: ManagedProduct,
): { available: number; inStock: boolean } | null {
  const value = productContractFields(product).availability;
  if (typeof value !== "object" || value === null) return null;

  const available = (value as { available?: unknown }).available;
  const inStock = (value as { inStock?: unknown }).inStock;

  if (typeof available !== "number" || !Number.isFinite(available)) return null;
  if (typeof inStock !== "boolean") return null;

  return {
    available: Math.max(0, Math.floor(available)),
    inStock,
  };
}

function isAmbiguousDelivery(kind: TelegramErrorKind | undefined): boolean {
  return kind === "timeout" || kind === "network_error";
}

/**
 * Superseded storefront messages keep functioning safely, but their controls
 * should not compete with the replacement screen. This is best effort: a
 * failure to clear an old keyboard must never fail the new screen.
 */
async function clearMessageKeyboard(
  transport: TelegramTransport,
  chatId: number | string,
  messageId: number,
): Promise<void> {
  try {
    await transport.editMessageReplyMarkup({
      chatId,
      messageId,
      replyMarkup: { inline_keyboard: [] },
    });
  } catch {
    // Best effort only: the replacement screen already succeeded.
  }
}

function messageHasPhoto(message: TelegramMessage): boolean {
  return Array.isArray(message.photo) && message.photo.length > 0;
}

function cartLinesText(cart: CartView): string {
  return cart.lines
    .map(
      (line) =>
        `${line.name} × ${line.quantity} — ${money(line.lineTotal, cart.currency)}`,
    )
    .join("\n");
}

function cartText(cart: CartView, copy: CommerceCopy): string {
  const lines = [copy.cart, "", cartLinesText(cart), ""];

  if (cart.unavailableCount > 0) {
    lines.push(copy.cartUnavailableNote, "");
  }

  lines.push(`${copy.subtotal}: ${money(cart.subtotal, cart.currency)}`);
  lines.push(`${copy.deliveryFee}: ${money(cart.deliveryFee, cart.currency)}`);
  lines.push(`${copy.total}: ${money(cart.total, cart.currency)}`);
  lines.push(copy.cashOnDelivery);

  return lines.join("\n");
}

function reviewText(
  review: CheckoutReview,
  copy: CommerceCopy,
  vodafoneCashEnabled = false,
): string {
  const lines = [
    copy.reviewTitle,
    "",
    ...review.lines.map(
      (line) =>
        `${line.name} × ${line.quantity} — ${line.unitPrice} × ${line.quantity} = ${money(line.lineTotal, review.currency)}`,
    ),
    "",
    `${copy.subtotal}: ${money(review.subtotal, review.currency)}`,
    `${copy.deliveryFee}: ${money(review.deliveryFee, review.currency)}`,
    `${copy.total}: ${money(review.total, review.currency)}`,
    `${copy.paymentLabel}: ${copy.cashOnDelivery}${
      vodafoneCashEnabled ? ` / ${copy.vodafoneCash}` : ""
    }`,
    "",
    `${copy.nameLabel}: ${review.customerName}`,
    `${copy.phoneLabel}: ${review.customerPhone}`,
    `${copy.addressLabel}: ${review.deliveryAddress}`,
    "",
    copy.reviewInstruction,
  ];

  return lines.join("\n");
}

function reviewKeyboard(
  review: CheckoutReview,
  copy: CommerceCopy,
  vodafoneCashEnabled = false,
) {
  const paymentButtons: TelegramInlineKeyboardButton[][] = [
    [
      {
        text: copy.confirmButton,
        callback_data: tokens.confirmCod(review.cartId, review.quoteVersion),
      },
    ],
  ];

  if (vodafoneCashEnabled) {
    paymentButtons.push([
      {
        text: copy.payWithVodafoneCash,
        callback_data: tokens.confirmVodafoneCash(
          review.cartId,
          review.quoteVersion,
        ),
      },
    ]);
  }

  return {
    inline_keyboard: [
      ...paymentButtons,
      [
        {
          text: copy.backToCart,
          callback_data: tokens.backToCart(review.cartId),
        },
        { text: copy.languageButton, callback_data: tokens.languages() },
        { text: copy.home, callback_data: tokens.home() },
      ],
    ],
  };
}

function cartKeyboard(cart: CartView, copy: CommerceCopy) {
  const keyboard: TelegramInlineKeyboardButton[][] = cart.lines.map((line) => [
    { text: "−", callback_data: tokens.cartDecrease(line.productId) },
    { text: "+", callback_data: tokens.cartIncrease(line.productId) },
    { text: copy.remove, callback_data: tokens.cartRemove(line.productId) },
  ]);

  keyboard.push([
    { text: copy.checkout, callback_data: tokens.checkout(cart.id) },
  ]);
  keyboard.push([
    { text: copy.languageButton, callback_data: tokens.languages() },
    { text: copy.home, callback_data: tokens.home() },
  ]);

  return { inline_keyboard: keyboard };
}

async function renderCartView(
  transport: TelegramTransport,
  chatId: number,
  messageId: number | undefined,
  cart: CartView | null,
  copy: CommerceCopy,
): Promise<void> {
  if (!cart || cart.lines.length === 0) {
    const params = {
      chatId,
      text: `${copy.cartEmpty}\n\n${copy.cartHint}`,
      replyMarkup: { inline_keyboard: homeKeyboard(copy) },
    };

    if (messageId) {
      await editOrThrow(transport, { ...params, messageId });
    } else {
      await sendOrThrow(transport, params);
    }
    return;
  }

  const params = {
    chatId,
    text: cartText(cart, copy),
    replyMarkup: cartKeyboard(cart, copy),
  };

  if (messageId) {
    await editOrThrow(transport, { ...params, messageId });
  } else {
    await sendOrThrow(transport, params);
  }
}

async function renderReviewView(
  transport: TelegramTransport,
  chatId: number,
  messageId: number | undefined,
  review: CheckoutReview,
  copy: CommerceCopy,
  vodafoneCashEnabled = false,
): Promise<void> {
  const params = {
    chatId,
    text: reviewText(review, copy, vodafoneCashEnabled),
    replyMarkup: reviewKeyboard(review, copy, vodafoneCashEnabled),
  };

  if (messageId) {
    await editOrThrow(transport, { ...params, messageId });
  } else {
    await sendOrThrow(transport, params);
  }
}

async function sendPhonePrompt(
  transport: TelegramTransport,
  chatId: number,
  cart: CartView,
  copy: CommerceCopy,
): Promise<void> {
  await sendOrThrow(transport, {
    chatId,
    text: [
      copy.checkout,
      "",
      `${copy.subtotal}: ${money(cart.subtotal, cart.currency)}`,
      `${copy.deliveryFee}: ${money(cart.deliveryFee, cart.currency)}`,
      `${copy.total}: ${money(cart.total, cart.currency)}`,
      copy.cashOnDelivery,
      "",
      copy.phonePrompt,
    ].join("\n"),
    replyMarkup: {
      keyboard: [
        [{ text: copy.sharePhone, request_contact: true }],
        [
          { text: copy.cart },
          { text: copy.languageButton },
        ],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function sendAddressPrompt(
  transport: TelegramTransport,
  chatId: number,
  copy: CommerceCopy,
  text = copy.addressPrompt,
): Promise<void> {
  await sendOrThrow(transport, {
    chatId,
    text,
    replyMarkup: {
      keyboard: [
        [
          { text: copy.cart },
          { text: copy.languageButton },
        ],
      ],
      resize_keyboard: true,
    },
  });
}

type PlacedOrderReceipt = {
  reference: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  currency: string;
};

function placedOrderText(result: PlacedOrderReceipt, copy: CommerceCopy): string {
  return [
    copy.orderPlaced(result.reference),
    "",
    `${copy.subtotal}: ${money(result.subtotal, result.currency)}`,
    `${copy.deliveryFee}: ${money(result.deliveryFee, result.currency)}`,
    `${copy.total}: ${money(result.total, result.currency)}`,
    copy.awaitingCollection,
    "",
    copy.reservedNote,
  ].join("\n");
}

function placedOrderKeyboard(copy: CommerceCopy) {
  return {
    inline_keyboard: [
      [{ text: copy.home, callback_data: tokens.homeNew() }],
    ],
  };
}

/**
 * The receipt is its own message so browsing can keep editing the active
 * storefront message without destroying the order reference. The active
 * message is reduced to a short confirmation and a fresh-home action.
 */
async function sendPlacedOrderReceipt(
  transport: TelegramTransport,
  chatId: number,
  result: PlacedOrderReceipt,
  copy: CommerceCopy,
): Promise<TelegramSendResult> {
  return transport.sendMessage({
    chatId,
    text: placedOrderText(result, copy),
    replyMarkup: placedOrderKeyboard(copy),
  });
}

async function renderPlacedOrderBridge(
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  result: PlacedOrderReceipt,
  copy: CommerceCopy,
): Promise<void> {
  await editOrThrow(transport, {
    chatId,
    messageId,
    text: `${copy.orderPlaced(result.reference)}\n\n${copy.reservedNote}`,
    replyMarkup: placedOrderKeyboard(copy),
  });
}

async function renderPlacedOrderOnActiveMessage(
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  result: PlacedOrderReceipt,
  copy: CommerceCopy,
  allowReplacementSend: boolean,
): Promise<void> {
  const params = {
    chatId,
    messageId,
    text: placedOrderText(result, copy),
    replyMarkup: placedOrderKeyboard(copy),
  };

  if (allowReplacementSend) {
    await editOrThrow(transport, params);
  } else {
    await editOnlyOrThrow(transport, params);
  }
}

async function renderLatestCodOrder(
  db: Database,
  scope: StoreScope,
  transport: TelegramTransport,
  messageId: number,
  copy: CommerceCopy,
  buyer: BuyerOrderChat,
): Promise<void> {
  const order = await readLatestBuyerCodOrder(db, scope, buyer);
  let text = copy.latestCodOrderUnavailable;
  if (order) {
    const status = order.fulfillmentStatus === "unfulfilled"
      ? order.status
      : order.fulfillmentStatus;
    const lines = [
      `${copy.codOrderReference}: ${order.reference}`,
      `${copy.codOrderStatusLabel}: ${copy.codOrderStatuses[status]}`,
    ];
    if (status !== "cancelled" || order.paymentStatus !== "awaiting_collection") {
      lines.push(`${copy.paymentLabel}: ${copy.codPaymentStatuses[order.paymentStatus]}`);
    }
    text = lines.join("\n");
  }

  await editOrThrow(transport, {
    chatId: buyer.telegramChatId,
    messageId,
    text,
    replyMarkup: { inline_keyboard: homeKeyboard(copy, "cod") },
  });
}

function transferInstructionsFor(
  snapshot: TransferSnapshot | null,
  locale: ManagedCommerceLocale,
): string | null {
  if (!snapshot) return null;

  const requested =
    locale === "ar" ? snapshot.instructionsAr : snapshot.instructionsEn;
  const fallback =
    locale === "ar" ? snapshot.instructionsEn : snapshot.instructionsAr;

  return requested?.trim() || fallback?.trim() || null;
}

function transferInstructionsText(
  order: {
    reference: string;
    total: string;
    currency: string;
  },
  snapshot: TransferSnapshot | null,
  locale: ManagedCommerceLocale,
  copy: CommerceCopy,
): string {
  const instructions = transferInstructionsFor(snapshot, locale);

  return [
    copy.transferInstructionsTitle,
    "",
    copy.orderPlaced(order.reference),
    `${copy.transferAmountLabel}: ${money(order.total, order.currency)}`,
    "",
    `${copy.transferTo}: ${snapshot?.number ?? ""}`,
    `${copy.transferAccount}: ${snapshot?.accountName ?? ""}`,
    instructions ? `${copy.transferInstructions}:\n${instructions}` : "",
    "",
    copy.transferInstructionsGuidance,
    "",
    copy.reservedNote,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function renderTransferInstructions(
  transport: TelegramTransport,
  chatId: number,
  messageId: number | undefined,
  order: {
    orderId: string;
    reference: string;
    total: string;
    currency: string;
  },
  snapshot: TransferSnapshot | null,
  locale: ManagedCommerceLocale,
  copy: CommerceCopy,
): Promise<void> {
  const params = {
    chatId,
    text: transferInstructionsText(order, snapshot, locale, copy),
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: copy.transferReferenceButton,
            callback_data: tokens.transferReference(order.orderId),
          },
        ],
        [
          { text: copy.cart, callback_data: tokens.cart() },
          {
            text: copy.languageButton,
            callback_data: tokens.languages(`to:${order.orderId}`),
          },
          { text: copy.home, callback_data: tokens.home() },
        ],
      ],
    },
  };

  if (messageId) {
    await editOrThrow(transport, { ...params, messageId });
  } else {
    await sendOrThrow(transport, params);
  }
}

async function sendTransferReferencePrompt(
  transport: TelegramTransport,
  chatId: number,
  order: {
    reference: string;
    total: string;
    currency: string;
  },
  copy: CommerceCopy,
  text = copy.transferReferencePrompt,
): Promise<number | null> {
  const result = await transport.sendMessage({
    chatId,
    text: [
      text,
      "",
      copy.orderPlaced(order.reference),
      `${copy.total}: ${money(order.total, order.currency)}`,
    ].join("\n"),
    replyMarkup: {
      force_reply: true,
      input_field_placeholder: copy.transferReferencePlaceholder,
    },
  });

  if (!result.ok) {
    throw new Error(result.error ?? "Telegram send failed");
  }

  return result.messageId ?? null;
}

function transferStateText(
  state: VodafoneCashOrderState,
  copy: CommerceCopy,
): string {
  const heading = [
    copy.orderPlaced(state.reference),
    `${copy.total}: ${money(state.total, state.currency)}`,
  ];

  if (
    state.paymentStatus === "transfer_rejected" ||
    state.claim?.status === "rejected"
  ) {
    return [
      copy.transferRejectedTitle,
      "",
      ...heading,
      "",
      copy.transferRejectedBody,
    ].join("\n");
  }

  if (state.orderStatus === "cancelled" || state.fulfillmentStatus === "cancelled") {
    return [
      copy.transferCancelledTitle,
      "",
      ...heading,
      "",
      copy.transferCancelledBody,
    ].join("\n");
  }

  if (
    state.paymentStatus === "transfer_verified" ||
    state.claim?.status === "approved"
  ) {
    return [
      copy.transferVerifiedTitle,
      "",
      ...heading,
      "",
      copy.transferVerifiedBody,
    ].join("\n");
  }

  return [
    copy.transferSubmittedTitle,
    "",
    ...heading,
    ...(state.claim
      ? ["", `${copy.transferReferenceLabel}: ${state.claim.reference}`]
      : []),
    "",
    copy.transferAwaitingReview,
    "",
    copy.reservedNote,
  ].join("\n");
}

async function renderVodafoneOrderState(
  transport: TelegramTransport,
  chatId: number,
  messageId: number | undefined,
  state: VodafoneCashOrderState,
  locale: ManagedCommerceLocale,
  copy: CommerceCopy,
): Promise<void> {
  if (
    state.paymentStatus === "awaiting_transfer" &&
    !state.claim &&
    state.orderStatus !== "cancelled" &&
    state.fulfillmentStatus !== "cancelled"
  ) {
    await renderTransferInstructions(
      transport,
      chatId,
      messageId,
      state,
      state.transferSnapshot,
      locale,
      copy,
    );
    return;
  }

  const params = {
    chatId,
    text: transferStateText(state, copy),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: copy.cart, callback_data: tokens.cart() },
          {
            text: copy.languageButton,
            callback_data: tokens.languages(`to:${state.orderId}`),
          },
          { text: copy.home, callback_data: tokens.homeNew() },
        ],
      ],
    },
  };

  if (messageId) {
    await editOrThrow(transport, { ...params, messageId });
  } else {
    await sendOrThrow(transport, params);
  }
}

function cartAvailabilityMessage(
  cart: CartView | null,
  copy: CommerceCopy,
): string {
  return cart && cart.lines.length > 0 ? copy.stockIssue : copy.cartEmpty;
}

async function sendOrThrow(
  transport: TelegramTransport,
  params: Parameters<TelegramTransport["sendMessage"]>[0],
): Promise<void> {
  const result = await transport.sendMessage(params);
  if (!result.ok) {
    throw new Error(result.error ?? "Telegram send failed");
  }
}

async function editOrThrow(
  transport: TelegramTransport,
  params: Parameters<TelegramTransport["editMessageText"]>[0],
): Promise<void> {
  const result = await transport.editMessageText(params);

  if (result.ok) return;

  // A media message cannot be converted into a text screen. Replace it with a
  // single deliberate text message and retire the superseded controls. A not
  // editable/deleted source is a definite Telegram outcome, so one replacement
  // is safe; timeout and network outcomes are never retried with a new send.
  if (result.errorKind === "not_editable") {
    await sendOrThrow(transport, {
      chatId: params.chatId,
      text: params.text,
      replyMarkup: params.replyMarkup,
    });
    await clearMessageKeyboard(transport, params.chatId, params.messageId);
    return;
  }

  throw new Error(result.error ?? "Telegram edit failed");
}

/**
 * Edits only. Used when a previous send had an ambiguous outcome: replacing
 * the known active message is safe, while another blind send could duplicate
 * the receipt if the original message actually arrived.
 */
async function editOnlyOrThrow(
  transport: TelegramTransport,
  params: Parameters<TelegramTransport["editMessageText"]>[0],
): Promise<void> {
  const result = await transport.editMessageText(params);
  if (!result.ok) {
    throw new Error(result.error ?? "Telegram edit failed");
  }
}

function productButton(
  item: { id: string; name: string },
): TelegramInlineKeyboardButton {
  return { text: item.name, callback_data: tokens.product(item.id) };
}

function categoryButton(
  item: { id: string; name: string },
): TelegramInlineKeyboardButton {
  return { text: item.name, callback_data: tokens.storefrontCategory(item.id) };
}

async function localizeCartView(
  db: Database,
  scope: StoreScope,
  cart: CartView,
  plan: ManagedCatalogContentPlan,
  copy: CommerceCopy,
): Promise<CartView> {
  const lines = await Promise.all(
    cart.lines.map(async (line) => {
      const product = await readManagedProduct(db, scope, line.productId, plan);

      if (!product) {
        return { ...line, name: copy.unavailableItem };
      }

      return {
        ...line,
        name: product.name,
        description: product.description,
      };
    }),
  );

  return { ...cart, lines };
}

async function localizeReview(
  db: Database,
  scope: StoreScope,
  review: CheckoutReview,
  plan: ManagedCatalogContentPlan,
  copy: CommerceCopy,
): Promise<CheckoutReview> {
  const lines = await Promise.all(
    review.lines.map(async (line) => {
      const product = await readManagedProduct(db, scope, line.productId, plan);

      if (!product) {
        return { ...line, name: copy.unavailableItem };
      }

      return {
        ...line,
        name: product.name,
        description: product.description,
      };
    }),
  );

  return { ...review, lines };
}

async function renderHome(
  db: Database,
  scope: StoreScope,
  storeName: string,
  cod: CodContext,
  copy: CommerceCopy,
  plan: ManagedCatalogContentPlan,
  transport: TelegramTransport,
  chatId: number,
  messageId?: number,
  recovery?: HomeRecovery,
): Promise<void> {
  const page = await listManagedProducts(
    db,
    scope,
    {
      page: 1,
      pageSize: PAGE_SIZE,
    },
    plan,
  );

  const keyboard: TelegramInlineKeyboardButton[][] = page.items.map((item) => [
    productButton(item),
  ]);

  keyboard.push([
    { text: copy.browseCategories, callback_data: tokens.storefrontCategories() },
  ]);

  if (cod.enabled) {
    keyboard.push([{ text: copy.cart, callback_data: tokens.cart() }]);
  }

  if (recovery && (await readLatestBuyerCodOrder(db, scope, recovery))) {
    keyboard.push([
      { text: copy.latestCodOrder, callback_data: tokens.latestCodOrder() },
    ]);
  }

  if (recovery?.commerceDb) {
    const transfers = await listBuyerOutstandingVodafoneTransfers(
      recovery.commerceDb,
      scope,
      recovery,
    );
    if (transfers.length > 0) {
      keyboard.push([
        {
          text: copy.transferRecoveryButton,
          callback_data: tokens.transferList(),
        },
      ]);
    }
  }

  if (page.totalPages > 1) {
    keyboard.push([
      { text: copy.next, callback_data: tokens.products(2) },
    ]);
  }

  keyboard.push([
    { text: copy.languageButton, callback_data: tokens.languages("h") },
  ]);

  const text =
    page.totalCount === 0
      ? `${copy.welcome(storeName)}\n\n${copy.empty}`
      : `${copy.welcome(storeName)}\n\n${copy.products}`;

  const params = {
    chatId,
    text,
    replyMarkup: { inline_keyboard: keyboard },
  };

  if (messageId) {
    await editOrThrow(transport, { ...params, messageId });
  } else {
    await sendOrThrow(transport, params);
  }
}

async function renderProducts(
  db: Database,
  scope: StoreScope,
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  pageNumber: number,
  copy: CommerceCopy,
  plan: ManagedCatalogContentPlan,
): Promise<void> {
  const page = await listManagedProducts(
    db,
    scope,
    {
      page: pageNumber,
      pageSize: PAGE_SIZE,
    },
    plan,
  );

  const keyboard: TelegramInlineKeyboardButton[][] = page.items.map((item) => [
    productButton(item),
  ]);

  if (page.totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (page.page > 1) {
      nav.push({
        text: copy.previous,
        callback_data: tokens.products(page.page - 1),
      });
    }
    if (page.page < page.totalPages) {
      nav.push({
        text: copy.next,
        callback_data: tokens.products(page.page + 1),
      });
    }
    keyboard.push(nav);
  }

  keyboard.push(...homeKeyboard(copy, `p:${page.page}`));

  const text =
    page.totalCount === 0
      ? copy.empty
      : `${copy.products} (${page.page}/${page.totalPages})`;

  await editOrThrow(transport, {
    chatId,
    messageId,
    text,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function renderCategories(
  db: Database,
  scope: StoreScope,
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  pageNumber: number,
  copy: CommerceCopy,
  plan: ManagedCatalogContentPlan,
): Promise<void> {
  const page = await listManagedCategories(
    db,
    scope,
    {
      parentId: null,
      page: pageNumber,
      pageSize: PAGE_SIZE,
    },
    plan,
  );

  const keyboard: TelegramInlineKeyboardButton[][] = page.items.map((item) => [
    categoryButton(item),
  ]);

  if (page.totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (page.page > 1) {
      nav.push({
        text: copy.previous,
        callback_data: tokens.storefrontCategories(page.page - 1),
      });
    }
    if (page.page < page.totalPages) {
      nav.push({
        text: copy.next,
        callback_data: tokens.storefrontCategories(page.page + 1),
      });
    }
    keyboard.push(nav);
  }

  keyboard.push(...homeKeyboard(copy, "cs"));

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: page.totalCount === 0 ? copy.noCategories : copy.browseCategories,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function renderCategory(
  db: Database,
  scope: StoreScope,
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  categoryId: string,
  pageNumber: number,
  copy: CommerceCopy,
  plan: ManagedCatalogContentPlan,
): Promise<void> {
  const categoryRow = await readManagedCategory(
    db,
    scope,
    categoryId,
    plan,
  );

  if (!categoryRow) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: copy.unavailable,
      replyMarkup: { inline_keyboard: homeKeyboard(copy) },
    });
    return;
  }

  const [children, products] = await Promise.all([
    listManagedCategories(
      db,
      scope,
      {
        parentId: categoryId,
        page: 1,
        pageSize: PAGE_SIZE,
      },
      plan,
    ),
    listManagedProductsInCategory(
      db,
      scope,
      {
        categoryId,
        page: pageNumber,
        pageSize: PAGE_SIZE,
      },
      plan,
    ),
  ]);

  const keyboard: TelegramInlineKeyboardButton[][] = [
    ...children.items.map((item) => [categoryButton(item)]),
    ...products.items.map((item) => [productButton(item)]),
  ];

  if (products.totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (products.page > 1) {
      nav.push({
        text: copy.previous,
        callback_data: tokens.storefrontCategory(
          categoryId,
          products.page - 1,
        ),
      });
    }
    if (products.page < products.totalPages) {
      nav.push({
        text: copy.next,
        callback_data: tokens.storefrontCategory(
          categoryId,
          products.page + 1,
        ),
      });
    }
    keyboard.push(nav);
  }

  keyboard.push([
    {
      text: copy.back,
      callback_data: categoryRow.parentId
        ? tokens.storefrontCategory(categoryRow.parentId)
        : tokens.storefrontCategories(),
    },
    { text: copy.home, callback_data: tokens.home() },
    {
      text: copy.languageButton,
      callback_data: tokens.languages(`c:${categoryId}:${pageNumber}`),
    },
  ]);

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: categoryRow.name,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function renderProductCard(
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  activeMessageHasMedia: boolean,
  imageUrl: string | null,
  text: string,
  replyMarkup: { inline_keyboard: TelegramInlineKeyboardButton[][] },
): Promise<void> {
  // Captions are shorter than regular messages. A card that cannot fit keeps
  // the complete, usable text path instead of truncating merchant content.
  if (imageUrl && text.length <= TELEGRAM_MAX_CAPTION_CHARS) {
    if (activeMessageHasMedia) {
      const edited = await transport.editMessageMedia({
        chatId,
        messageId,
        media: { type: "photo", media: imageUrl, caption: text },
        replyMarkup,
      });

      if (edited.ok) return;

      if (isAmbiguousDelivery(edited.errorKind)) {
        // The edit may have reached Telegram. A retried update can safely
        // repeat the edit; a second message would not be safe.
        throw new Error(edited.error ?? "Telegram media edit failed");
      }
      // A definite media failure falls through to the text-only card.
    } else {
      const sent = await transport.sendPhoto({
        chatId,
        photo: imageUrl,
        caption: text,
        replyMarkup,
      });

      if (sent.ok) {
        // Text -> photo needs a replacement message. Retire the old controls
        // so only the replacement acts as the active storefront.
        await clearMessageKeyboard(transport, chatId, messageId);
        return;
      }

      if (isAmbiguousDelivery(sent.errorKind)) {
        // Never blindly re-send after an unknown outcome. The source message
        // is text, so render the usable text card in place.
        await editOnlyOrThrow(transport, {
          chatId,
          messageId,
          text,
          replyMarkup,
        });
        return;
      }
      // A definite photo failure still leaves a complete text-only card.
    }
  }

  await editOrThrow(transport, {
    chatId,
    messageId,
    text,
    replyMarkup,
  });
}

async function renderProduct(
  db: Database,
  scope: StoreScope,
  cod: CodContext,
  copy: CommerceCopy,
  plan: ManagedCatalogContentPlan,
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  activeMessageHasMedia: boolean,
  productId: string,
): Promise<void> {
  const productRow = await readManagedProduct(
    db,
    scope,
    productId,
    plan,
  );

  if (!productRow) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: copy.unavailable,
      replyMarkup: { inline_keyboard: homeKeyboard(copy) },
    });
    return;
  }

  const supportUsername = await readStoreTelegramSupportUsername(
    db,
    scope.storeId,
  );

  const contractAvailability = productAvailability(productRow);
  let stock: number | null = contractAvailability?.available ?? null;

  if (stock === null && cod.enabled) {
    const availability = await readInventoryAvailability(db, scope, [
      productId,
    ]);
    stock = availability.get(productId) ?? 0;
  }

  const inStock = contractAvailability
    ? contractAvailability.inStock && contractAvailability.available > 0
    : stock !== null && stock > 0;

  const lines = [productRow.name];

  if (productRow.description && productRow.description.trim().length > 0) {
    lines.push(productRow.description.trim());
  }

  // Currency is store commerce configuration, never catalog content. When the
  // store has no commerce setting yet, the price remains usable without one.
  lines.push(money(productRow.price, cod.setting?.currency ?? ""));

  if (stock !== null) {
    lines.push(inStock ? copy.inStock : copy.outOfStock);
  }

  const keyboard: TelegramInlineKeyboardButton[][] = [];

  if (cod.enabled && inStock && stock !== null) {
    // Last-unit behavior is deliberate: the buyer can only add what exists.
    const maxQuantity = Math.min(5, stock);

    if (maxQuantity > 0) {
      const quantityButtons: TelegramInlineKeyboardButton[] = [];

      for (let quantity = 1; quantity <= maxQuantity; quantity += 1) {
        quantityButtons.push({
          text: copy.addQuantity(quantity),
          callback_data: tokens.cartAdd(productId, quantity),
        });
      }

      keyboard.push(quantityButtons);
      keyboard.push([{ text: copy.cart, callback_data: tokens.cart() }]);
    }
  }

  if (supportUsername) {
    keyboard.push([
      {
        text: copy.askSellerOnTelegram,
        url: telegramSupportChatUrl(
          supportUsername,
          copy.telegramSupportDraft(productRow.name),
        ),
      },
    ]);
  }

  keyboard.push([
    {
      text: copy.back,
      callback_data: tokens.storefrontCategory(productRow.categoryId),
    },
    { text: copy.home, callback_data: tokens.home() },
  ]);
  keyboard.push([
    {
      text: copy.languageButton,
      callback_data: tokens.languages(`pd:${productId}`),
    },
  ]);

  await renderProductCard(
    transport,
    chatId,
    messageId,
    activeMessageHasMedia,
    productImageUrl(productRow),
    lines.join("\n\n"),
    { inline_keyboard: keyboard },
  );
}

function phoneReplyMarkup(copy: CommerceCopy) {
  return {
    keyboard: [
      [{ text: copy.sharePhone, request_contact: true }],
      [{ text: copy.cart }, { text: copy.languageButton }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

async function dispatchMessage(
  db: Database,
  scope: StoreScope,
  storeName: string,
  connectionId: string,
  cod: CodContext,
  commerceDb: TransactionDatabase | null,
  transport: TelegramTransport,
  message: TelegramMessage,
): Promise<void> {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const buyerId = message.from?.id ?? null;
  const context = await languageContextFor(
    db,
    scope,
    buyerId,
    message.from?.language_code,
  );
  const { copy, plan } = context;

  if (text === "/start" || text.startsWith("/start ")) {
    await renderHome(
      db,
      scope,
      storeName,
      cod,
      copy,
      plan,
      transport,
      message.chat.id,
      undefined,
      homeRecoveryFor(
        commerceDb,
        connectionId,
        buyerId,
        message.chat.id,
        context.language.locale,
      ),
    );
    return;
  }

  if (!buyerId) {
    await renderHome(
      db,
      scope,
      storeName,
      cod,
      copy,
      plan,
      transport,
      message.chat.id,
    );
    return;
  }

  // The language menu and cart shortcut are text buttons on the phone and
  // address reply keyboards, so they must be handled before those messages are
  // parsed as contact data.
  if (isLanguageCommand(text)) {
    await renderLanguageMenu(
      transport,
      message.chat.id,
      undefined,
      copy,
      context.language.locale,
    );
    return;
  }

  let activeCart: CartView | null = null;

  if (cod.enabled && commerceDb) {
    activeCart = await readCartForBuyer(db, scope, {
      connectionId,
      telegramUserId: buyerId,
    });

    if (activeCart && isCartCommand(text, copy)) {
      const cart =
        activeCart.status === "checkout"
          ? await backToCart(commerceDb, scope, {
              cartId: activeCart.id,
              connectionId,
              telegramUserId: buyerId,
            })
          : activeCart;

      await renderCartView(
        transport,
        message.chat.id,
        undefined,
        cart
          ? await localizeCartView(db, scope, cart, plan, copy)
          : null,
        copy,
      );
      return;
    }

    if (activeCart?.status === "checkout") {
      if (activeCart.checkoutState === "awaiting_phone") {
        const contact = message.contact;

        if (
          contact &&
          contact.user_id !== undefined &&
          contact.user_id !== buyerId
        ) {
          await sendOrThrow(transport, {
            chatId: message.chat.id,
            text: copy.phoneOwn,
            replyMarkup: phoneReplyMarkup(copy),
          });
          return;
        }

        const result = await savePhone(commerceDb, scope, {
          cartId: activeCart.id,
          connectionId,
          telegramUserId: buyerId,
          phone: contact ? contact.phone_number : text,
        });

        if (result.status === "saved") {
          await sendAddressPrompt(transport, message.chat.id, copy);
          return;
        }

        if (result.status === "invalid") {
          await sendOrThrow(transport, {
            chatId: message.chat.id,
            text: copy.invalidPhone,
            replyMarkup: phoneReplyMarkup(copy),
          });
          return;
        }
      }

      if (activeCart.checkoutState === "awaiting_address") {
        const result = await saveAddressAndPrepareReview(commerceDb, scope, {
          cartId: activeCart.id,
          connectionId,
          telegramUserId: buyerId,
          address: text,
        }, plan);

        if (result.status === "review") {
          await renderReviewView(
            transport,
            message.chat.id,
            undefined,
            await localizeReview(db, scope, result.review, plan, copy),
            copy,
            cod.vodafoneCashEnabled,
          );
          return;
        }

        if (result.status === "invalid") {
          await sendAddressPrompt(
            transport,
            message.chat.id,
            copy,
            copy.invalidAddress,
          );
          return;
        }

        if (result.status === "empty") {
          await renderCartView(
            transport,
            message.chat.id,
            undefined,
            null,
            copy,
          );
          return;
        }

        await sendOrThrow(transport, {
          chatId: message.chat.id,
          text: copy.stockIssue,
          replyMarkup: {
            inline_keyboard: [
              [{ text: copy.cart, callback_data: tokens.cart() }],
              ...homeKeyboard(copy),
            ],
          },
        });
        return;
      }
    }
  }

  if (commerceDb && buyerId) {
    const promptMessageId = repliedMessageId(message);

    if (promptMessageId !== null) {
      const state = await readVodafoneCashOrderByPromptReply(
        commerceDb,
        scope,
        {
          connectionId,
          telegramUserId: buyerId,
          telegramChatId: message.chat.id,
          promptMessageId,
        },
      );

      if (state) {
        if (
          state.paymentStatus === "awaiting_transfer" &&
          !state.claim &&
          state.orderStatus !== "cancelled" &&
          state.fulfillmentStatus !== "cancelled"
        ) {
          const claim = await submitVodafoneCashTransferClaim(
            commerceDb,
            scope,
            {
              connectionId,
              telegramUserId: buyerId,
              telegramChatId: message.chat.id,
              orderId: state.orderId,
              promptMessageId,
              reference: text,
            },
          );

          if (
            claim.status === "invalid_reference" ||
            claim.status === "reference_conflict"
          ) {
            const replacement = await requestVodafoneCashTransferReference(
              commerceDb,
              scope,
              {
                connectionId,
                telegramUserId: buyerId,
                orderId: state.orderId,
              },
            );

            if (replacement.status === "prompted") {
              const newPromptMessageId = await sendTransferReferencePrompt(
                transport,
                message.chat.id,
                replacement,
                copy,
                copy.transferReferenceInvalid,
              );

              if (newPromptMessageId !== null) {
                await bindVodafoneCashTransferPromptMessage(
                  commerceDb,
                  scope,
                  {
                    connectionId,
                    telegramUserId: buyerId,
                    orderId: state.orderId,
                    messageId: newPromptMessageId,
                    promptToken: replacement.promptToken,
                  },
                );
              }
              return;
            }
          }

          const latest = await readVodafoneCashOrderState(
            commerceDb,
            scope,
            {
              connectionId,
              telegramUserId: buyerId,
              orderId: state.orderId,
            },
          );

          if (latest) {
            await renderVodafoneOrderState(
              transport,
              message.chat.id,
              undefined,
              latest,
              context.language.locale,
              copy,
            );
            return;
          }
        } else {
          await renderVodafoneOrderState(
            transport,
            message.chat.id,
            undefined,
            state,
            context.language.locale,
            copy,
          );
          return;
        }
      }
    }
  }

  // Any other text returns the scoped storefront rather than leaking a global
  // or legacy journey. Address and phone text are handled only in their
  // checkout states above.
  await renderHome(
    db,
    scope,
    storeName,
    cod,
    copy,
    plan,
    transport,
    message.chat.id,
    undefined,
    homeRecoveryFor(
      commerceDb,
      connectionId,
      buyerId,
      message.chat.id,
      context.language.locale,
    ),
  );
}

async function renderAfterLanguageChange(
  db: Database,
  scope: StoreScope,
  storeName: string,
  connectionId: string,
  cod: CodContext,
  commerceDb: TransactionDatabase | null,
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  buyerId: number,
  context: LanguageContext,
): Promise<void> {
  const { copy, plan } = context;

  if (cod.enabled && commerceDb) {
    const cart = await readCartForBuyer(db, scope, {
      connectionId,
      telegramUserId: buyerId,
    });

    if (cart) {
      if (cart.status === "checkout") {
        if (cart.checkoutState === "awaiting_phone") {
          await editOrThrow(transport, {
            chatId,
            messageId,
            text: copy.languageSaved,
            replyMarkup: { inline_keyboard: homeKeyboard(copy) },
          });
          await sendPhonePrompt(transport, chatId, cart, copy);
          return;
        }

        if (cart.checkoutState === "awaiting_address") {
          await editOrThrow(transport, {
            chatId,
            messageId,
            text: copy.languageSaved,
            replyMarkup: { inline_keyboard: homeKeyboard(copy) },
          });
          await sendAddressPrompt(transport, chatId, copy);
          return;
        }

        if (cart.checkoutState === "review") {
          const refreshed = await refreshReview(commerceDb, scope, {
            cartId: cart.id,
            connectionId,
            telegramUserId: buyerId,
          }, plan);

          if (refreshed.status === "review") {
            await renderReviewView(
              transport,
              chatId,
              messageId,
              await localizeReview(db, scope, refreshed.review, plan, copy),
              copy,
              cod.vodafoneCashEnabled,
            );
            return;
          }
        }
      }

      await renderCartView(
        transport,
        chatId,
        messageId,
        await localizeCartView(db, scope, cart, plan, copy),
        copy,
      );
      return;
    }
  }

  await renderHome(
    db,
    scope,
    storeName,
    cod,
    copy,
    plan,
    transport,
    chatId,
    messageId,
    homeRecoveryFor(
      commerceDb,
      connectionId,
      buyerId,
      chatId,
      context.language.locale,
    ),
  );
}

async function renderLanguageContextScreen(
  db: Database,
  scope: StoreScope,
  storeName: string,
  cod: CodContext,
  copy: CommerceCopy,
  plan: ManagedCatalogContentPlan,
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  context: string | null,
  recovery?: HomeRecovery,
  activeMessageHasMedia = false,
): Promise<boolean> {
  if (!context || context === "h") {
    if (!context) return false;
    await renderHome(
      db,
      scope,
      storeName,
      cod,
      copy,
      plan,
      transport,
      chatId,
      messageId,
      recovery,
    );
    return true;
  }

  if (context.startsWith("to:")) {
    if (!recovery?.commerceDb) return false;

    const state = await readVodafoneCashOrderState(
      recovery.commerceDb,
      scope,
      {
        connectionId: recovery.connectionId,
        telegramUserId: recovery.telegramUserId,
        telegramChatId: recovery.telegramChatId,
        orderId: context.slice(3),
      },
    );

    if (!state) return false;

    await renderVodafoneOrderState(
      transport,
      chatId,
      messageId,
      state,
      recovery.locale,
      copy,
    );
    return true;
  }

  if (context === "cod" && recovery) {
    await renderLatestCodOrder(db, scope, transport, messageId, copy, recovery);
    return true;
  }

  if (context === "cs") {
    await renderCategories(
      db,
      scope,
      transport,
      chatId,
      messageId,
      1,
      copy,
      plan,
    );
    return true;
  }

  if (context.startsWith("p:")) {
    const page = Number(context.slice(2));
    if (Number.isInteger(page) && page > 0) {
      await renderProducts(
        db,
        scope,
        transport,
        chatId,
        messageId,
        page,
        copy,
        plan,
      );
      return true;
    }
    return false;
  }

  if (context.startsWith("pd:")) {
    await renderProduct(
      db,
      scope,
      cod,
      copy,
      plan,
      transport,
      chatId,
      messageId,
      activeMessageHasMedia,
      context.slice(3),
    );
    return true;
  }

  if (context.startsWith("c:")) {
    const [categoryId, pageText] = context.slice(2).split(":");
    const page = pageText ? Number(pageText) : 1;
    if (Number.isInteger(page) && page > 0) {
      await renderCategory(
        db,
        scope,
        transport,
        chatId,
        messageId,
        categoryId,
        page,
        copy,
        plan,
      );
      return true;
    }
  }

  return false;
}

async function dispatchCallback(
  db: Database,
  scope: StoreScope,
  storeName: string,
  connectionId: string,
  cod: CodContext,
  commerceDb: TransactionDatabase | null,
  transport: TelegramTransport,
  callbackQuery: {
    id: string;
    message?: TelegramMessage;
    from: { id: number; first_name?: string; language_code?: string };
  },
  parsedToken: ParsedToken,
  updateAttempt: ManagedUpdateAttempt,
): Promise<void> {
  const ack = await transport.answerCallbackQuery({
    callbackQueryId: callbackQuery.id,
  });

  if (!ack.ok && ack.errorKind !== "callback_expired") {
    throw new Error(ack.error ?? "Failed to answer callback query");
  }

  const message = callbackQuery.message;
  if (!message) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const activeMessageHasMedia = messageHasPhoto(message);
  const buyerId = callbackQuery.from.id;
  let context = await languageContextFor(
    db,
    scope,
    buyerId,
    callbackQuery.from.language_code,
  );
  let { copy, plan } = context;

  if (parsedToken.type === "latestCodOrder") {
    await renderLatestCodOrder(db, scope, transport, messageId, copy, {
      connectionId,
      telegramUserId: buyerId,
      telegramChatId: chatId,
    });
    return;
  }

  if (parsedToken.type === "languages") {
    await renderLanguageMenu(
      transport,
      chatId,
      messageId,
      copy,
      context.language.locale,
      parsedToken.context,
    );
    return;
  }

  if (parsedToken.type === "lang") {
    if (!isBuyerLocale(parsedToken.code)) {
      await renderLanguageMenu(
        transport,
        chatId,
        messageId,
        copy,
        context.language.locale,
        parsedToken.context,
        copy.invalidLanguage,
      );
      return;
    }

    const saved = await saveBuyerLanguagePreference(db, scope, {
      telegramUserId: buyerId,
      code: parsedToken.code,
    });

    if (!saved.ok) {
      await renderLanguageMenu(
        transport,
        chatId,
        messageId,
        copy,
        context.language.locale,
        parsedToken.context,
        copy.invalidLanguage,
      );
      return;
    }

    context = await languageContextFor(
      db,
      scope,
      buyerId,
      callbackQuery.from.language_code,
    );
    copy = context.copy;
    plan = context.plan;

    if (
      await renderLanguageContextScreen(
        db,
        scope,
        storeName,
        cod,
        copy,
        plan,
        transport,
        chatId,
        messageId,
        parsedToken.context,
        homeRecoveryFor(
          commerceDb,
          connectionId,
          buyerId,
          chatId,
          context.language.locale,
        ),
        activeMessageHasMedia,
      )
    ) {
      return;
    }

    await renderAfterLanguageChange(
      db,
      scope,
      storeName,
      connectionId,
      cod,
      commerceDb,
      transport,
      chatId,
      messageId,
      buyerId,
      context,
    );
    return;
  }

  if (cod.enabled && commerceDb) {
    if (parsedToken.type === "cart") {
      const cart = await readCartForBuyer(db, scope, {
        connectionId,
        telegramUserId: buyerId,
      });

      await renderCartView(
        transport,
        chatId,
        messageId,
        cart ? await localizeCartView(db, scope, cart, plan, copy) : null,
        copy,
      );
      return;
    }

    if (
      parsedToken.type === "cartAdd" ||
      parsedToken.type === "cartIncrease" ||
      parsedToken.type === "cartDecrease" ||
      parsedToken.type === "cartRemove"
    ) {
      const input = {
        connectionId,
        telegramUserId: buyerId,
        productId: parsedToken.productId,
      };
      const result = await commerceDb.transaction(async (tx) => {
        const shouldApply = await claimManagedCartMutation(tx, {
          ...updateAttempt,
          connectionId,
        });
        if (!shouldApply) {
          return {
            status: "replayed" as const,
            cart: await readCartForBuyer(tx, scope, input),
          };
        }

        switch (parsedToken.type) {
          case "cartAdd":
            return addToCart(tx, scope, {
              ...input,
              telegramChatId: chatId,
              quantity: parsedToken.quantity,
            });
          case "cartIncrease":
            return changeCartQuantity(tx, scope, { ...input, delta: 1 });
          case "cartDecrease":
            return changeCartQuantity(tx, scope, { ...input, delta: -1 });
          case "cartRemove":
            return removeCartItem(tx, scope, input);
        }
      });

      if (
        result.status === "added" ||
        result.status === "updated" ||
        result.status === "replayed"
      ) {
        await renderCartView(
          transport,
          chatId,
          messageId,
          result.cart
            ? await localizeCartView(db, scope, result.cart, plan, copy)
            : null,
          copy,
        );
        return;
      }

      if (parsedToken.type === "cartDecrease" || parsedToken.type === "cartRemove") {
        await renderCartView(transport, chatId, messageId, null, copy);
        return;
      }

      const text = parsedToken.type === "cartAdd"
        ? result.status === "out_of_stock"
          ? copy.outOfStock
          : result.status === "cod_unavailable"
            ? copy.notOrderable
            : copy.unavailable
        : result.status === "empty"
          ? copy.cartEmpty
          : result.status === "invalid_quantity"
            ? copy.maxQuantity
            : copy.genericUnavailable;

      await editOrThrow(transport, {
        chatId,
        messageId,
        text,
        replyMarkup: { inline_keyboard: homeKeyboard(copy) },
      });
      return;
    }

    if (parsedToken.type === "checkout") {
      const result = await startCheckout(commerceDb, scope, {
        cartId: parsedToken.cartId,
        connectionId,
        telegramUserId: buyerId,
        profileName: callbackQuery.from.first_name,
      }, plan);

      if (result.status === "ready") {
        // The previous cart message stays as the buyer left it. One clear
        // phone prompt is the next action, instead of re-rendering the cart
        // first and then sending a second summary.
        await sendPhonePrompt(transport, chatId, result.cart, copy);
        return;
      }

      if (result.status === "empty") {
        await renderCartView(transport, chatId, messageId, null, copy);
        return;
      }

      await editOrThrow(transport, {
        chatId,
        messageId,
        text:
          result.status === "not_found"
            ? copy.genericUnavailable
            : result.status === "cod_unavailable"
              ? copy.notOrderable
              : copy.stockIssue,
        replyMarkup: {
          inline_keyboard: [
            [{ text: copy.cart, callback_data: tokens.cart() }],
            ...homeKeyboard(copy),
          ],
        },
      });
      return;
    }

    if (parsedToken.type === "confirmCod") {
      const result = await confirmCodOrder(commerceDb, scope, {
        cartId: parsedToken.cartId,
        connectionId,
        telegramUserId: buyerId,
        telegramChatId: chatId,
        expectedQuoteVersion: parsedToken.quoteVersion,
      }, plan);

      if (result.status === "placed") {
        // The receipt is a separate message so all later browsing edits keep
        // the order reference intact. The active message becomes a compact
        // confirmation with a fresh-home action, retiring stale confirm
        // controls.
        const receipt = await sendPlacedOrderReceipt(
          transport,
          chatId,
          result,
          copy,
        );

        if (receipt.ok) {
          await renderPlacedOrderBridge(
            transport,
            chatId,
            messageId,
            result,
            copy,
          );
          return;
        }

        // Delivery is not guaranteed exactly once. Never blindly re-send a
        // receipt after an unknown outcome; falling back to the known active
        // message keeps the reference available and cannot duplicate an order.
        await renderPlacedOrderOnActiveMessage(
          transport,
          chatId,
          messageId,
          result,
          copy,
          false,
        );
        return;
      }

      if (result.status === "already_placed") {
        // Replayed confirmations edit the active message only. The order and
        // its reservation were already committed under the checkout key.
        await renderPlacedOrderOnActiveMessage(
          transport,
          chatId,
          messageId,
          result,
          copy,
          true,
        );
        return;
      }

      if (result.status === "stale_quote") {
        await renderReviewView(
          transport,
          chatId,
          messageId,
          await localizeReview(db, scope, result.review, plan, copy),
          copy,
          cod.vodafoneCashEnabled,
        );
        return;
      }

      if (result.status === "missing_details") {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.checkoutNeedsDetails,
          replyMarkup: { inline_keyboard: homeKeyboard(copy) },
        });

        const cart = await readCartForBuyer(db, scope, {
          connectionId,
          telegramUserId: buyerId,
          cartId: parsedToken.cartId,
        });

        if (cart && result.missing === "phone") {
          await sendPhonePrompt(transport, chatId, cart, copy);
        } else if (cart) {
          await sendAddressPrompt(transport, chatId, copy);
        }
        return;
      }

      if (
        result.status === "insufficient_stock" ||
        result.status === "item_unavailable"
      ) {
        const cart = await readCartForBuyer(db, scope, {
          connectionId,
          telegramUserId: buyerId,
          cartId: parsedToken.cartId,
        });

        await editOrThrow(transport, {
          chatId,
          messageId,
          text: cartAvailabilityMessage(cart, copy),
          replyMarkup: {
            inline_keyboard: [
              [{ text: copy.cart, callback_data: tokens.cart() }],
              ...homeKeyboard(copy),
            ],
          },
        });
        return;
      }

      await editOrThrow(transport, {
        chatId,
        messageId,
        text:
          result.status === "cod_unavailable"
            ? copy.notOrderable
            : copy.genericUnavailable,
        replyMarkup: { inline_keyboard: homeKeyboard(copy) },
      });
      return;
    }

    if (parsedToken.type === "confirmVodafoneCash") {
      const result = await confirmVodafoneCashOrder(commerceDb, scope, {
        cartId: parsedToken.cartId,
        connectionId,
        telegramUserId: buyerId,
        telegramChatId: chatId,
        expectedQuoteVersion: parsedToken.quoteVersion,
      }, plan);

      if (result.status === "placed") {
        await renderTransferInstructions(
          transport,
          chatId,
          messageId,
          result,
          result.transferSnapshot,
          context.language.locale,
          copy,
        );
        return;
      }

      if (result.status === "already_placed") {
        const state = await readVodafoneCashOrderState(commerceDb, scope, {
          connectionId,
          telegramUserId: buyerId,
          orderId: result.orderId,
        });

        if (state) {
          await renderVodafoneOrderState(
            transport,
            chatId,
            messageId,
            state,
            context.language.locale,
            copy,
          );
          return;
        }
      }

      if (result.status === "stale_quote") {
        await renderReviewView(
          transport,
          chatId,
          messageId,
          await localizeReview(db, scope, result.review, plan, copy),
          copy,
          cod.vodafoneCashEnabled,
        );
        return;
      }

      if (result.status === "missing_details") {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.checkoutNeedsDetails,
          replyMarkup: { inline_keyboard: homeKeyboard(copy) },
        });
        return;
      }

      if (
        result.status === "insufficient_stock" ||
        result.status === "item_unavailable"
      ) {
        const cart = await readCartForBuyer(db, scope, {
          connectionId,
          telegramUserId: buyerId,
          cartId: parsedToken.cartId,
        });

        await editOrThrow(transport, {
          chatId,
          messageId,
          text: cartAvailabilityMessage(cart, copy),
          replyMarkup: {
            inline_keyboard: [
              [{ text: copy.cart, callback_data: tokens.cart() }],
              ...homeKeyboard(copy),
            ],
          },
        });
        return;
      }

      await editOrThrow(transport, {
        chatId,
        messageId,
        text:
          result.status === "transfer_unavailable"
            ? copy.notOrderable
            : copy.genericUnavailable,
        replyMarkup: { inline_keyboard: homeKeyboard(copy) },
      });
      return;
    }

    if (parsedToken.type === "transferList") {
      if (!commerceDb) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.genericUnavailable,
          replyMarkup: { inline_keyboard: homeKeyboard(copy) },
        });
        return;
      }

      const transfers = await listBuyerOutstandingVodafoneTransfers(
        commerceDb,
        scope,
        {
          connectionId,
          telegramUserId: buyerId,
          telegramChatId: chatId,
        },
      );

      if (transfers.length === 0) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.transferRecoveryEmpty,
          replyMarkup: { inline_keyboard: homeKeyboard(copy) },
        });
        return;
      }

      const keyboard: TelegramInlineKeyboardButton[][] = transfers.map(
        (transfer) => [
          {
            text: `${transfer.reference} — ${money(transfer.total, transfer.currency)}`,
            callback_data: tokens.transferOrder(transfer.orderId),
          },
        ],
      );
      keyboard.push([
        { text: copy.cart, callback_data: tokens.cart() },
        { text: copy.home, callback_data: tokens.homeNew() },
      ]);

      await editOrThrow(transport, {
        chatId,
        messageId,
        text: `${copy.transferRecoveryTitle}\n\n${copy.transferRecoveryHint}`,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    if (parsedToken.type === "transferOrder") {
      if (!commerceDb) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.genericUnavailable,
          replyMarkup: { inline_keyboard: homeKeyboard(copy) },
        });
        return;
      }

      const state = await readVodafoneCashOrderState(commerceDb, scope, {
        connectionId,
        telegramUserId: buyerId,
        telegramChatId: chatId,
        orderId: parsedToken.orderId,
      });

      if (!state) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.genericUnavailable,
          replyMarkup: { inline_keyboard: homeKeyboard(copy) },
        });
        return;
      }

      await renderVodafoneOrderState(
        transport,
        chatId,
        messageId,
        state,
        context.language.locale,
        copy,
      );
      return;
    }

    if (parsedToken.type === "transferReference") {
      const state = await readVodafoneCashOrderState(commerceDb, scope, {
        connectionId,
        telegramUserId: buyerId,
        orderId: parsedToken.orderId,
      });

      if (!state) {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.genericUnavailable,
          replyMarkup: { inline_keyboard: homeKeyboard(copy) },
        });
        return;
      }

      if (
        state.paymentStatus !== "awaiting_transfer" ||
        state.claim ||
        state.orderStatus === "cancelled" ||
        state.fulfillmentStatus === "cancelled"
      ) {
        await renderVodafoneOrderState(
          transport,
          chatId,
          messageId,
          state,
          context.language.locale,
          copy,
        );
        return;
      }

      const result = await requestVodafoneCashTransferReference(
        commerceDb,
        scope,
        {
          connectionId,
          telegramUserId: buyerId,
          orderId: parsedToken.orderId,
        },
      );

      if (result.status === "prompted") {
        const promptMessageId = await sendTransferReferencePrompt(
          transport,
          chatId,
          result,
          copy,
        );

        if (promptMessageId !== null) {
          await bindVodafoneCashTransferPromptMessage(commerceDb, scope, {
            connectionId,
            telegramUserId: buyerId,
            orderId: result.orderId,
            messageId: promptMessageId,
            promptToken: result.promptToken,
          });
        }
        return;
      }

      const latest = await readVodafoneCashOrderState(commerceDb, scope, {
        connectionId,
        telegramUserId: buyerId,
        orderId: parsedToken.orderId,
      });

      if (latest) {
        await renderVodafoneOrderState(
          transport,
          chatId,
          messageId,
          latest,
          context.language.locale,
          copy,
        );
        return;
      }

      await editOrThrow(transport, {
        chatId,
        messageId,
        text: copy.genericUnavailable,
        replyMarkup: { inline_keyboard: homeKeyboard(copy) },
      });
      return;
    }

    if (parsedToken.type === "backToCart") {
      const cart = await backToCart(commerceDb, scope, {
        cartId: parsedToken.cartId,
        connectionId,
        telegramUserId: buyerId,
      });

      await renderCartView(
        transport,
        chatId,
        messageId,
        cart ? await localizeCartView(db, scope, cart, plan, copy) : null,
        copy,
      );
      return;
    }
  }

  if (parsedToken.type === "homeNew") {
    await renderHome(
      db,
      scope,
      storeName,
      cod,
      copy,
      plan,
      transport,
      chatId,
      undefined,
      homeRecoveryFor(
        commerceDb,
        connectionId,
        buyerId,
        chatId,
        context.language.locale,
      ),
    );
    return;
  }

  if (parsedToken.type === "home") {
    await renderHome(
      db,
      scope,
      storeName,
      cod,
      copy,
      plan,
      transport,
      chatId,
      messageId,
      homeRecoveryFor(
        commerceDb,
        connectionId,
        buyerId,
        chatId,
        context.language.locale,
      ),
    );
    return;
  }

  if (parsedToken.type === "products") {
    await renderProducts(
      db,
      scope,
      transport,
      chatId,
      messageId,
      parsedToken.page,
      copy,
      plan,
    );
    return;
  }

  if (parsedToken.type === "storefrontCategories") {
    await renderCategories(
      db,
      scope,
      transport,
      chatId,
      messageId,
      parsedToken.page,
      copy,
      plan,
    );
    return;
  }

  if (parsedToken.type === "storefrontCategory") {
    await renderCategory(
      db,
      scope,
      transport,
      chatId,
      messageId,
      parsedToken.categoryId,
      parsedToken.page,
      copy,
      plan,
    );
    return;
  }

  if (parsedToken.type === "product") {
    await renderProduct(
      db,
      scope,
      cod,
      copy,
      plan,
      transport,
      chatId,
      messageId,
      activeMessageHasMedia,
      parsedToken.productId,
    );
    return;
  }

  // Every other legacy callback belongs to a different journey. Fail closed to
  // the scoped home instead of running an unscoped path.
  await renderHome(
    db,
    scope,
    storeName,
    cod,
    copy,
    plan,
    transport,
    chatId,
    messageId,
    homeRecoveryFor(commerceDb, connectionId, buyerId, chatId, context.language.locale),
  );
}

export async function handleManagedTelegramWebhookRequest(
  req: Request,
  connectionPublicId: string,
  options?: ManagedWebhookOptions,
): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let db: Database;

  try {
    db = options?.db ?? getDb();
  } catch {
    return json({ error: "Service unavailable" }, 503);
  }

  let connection;

  try {
    connection = await readReadyManagedConnection(db, connectionPublicId);
  } catch {
    return json({ error: "Service unavailable" }, 503);
  }

  if (!connection) {
    return json({ error: "Not found" }, 404);
  }

  const incomingSecret = req.headers.get(
    "x-telegram-bot-api-secret-token",
  );

  if (
    !verifyWebhookSecret(incomingSecret, connection.webhookSecretHash)
  ) {
    return json({ error: "Unauthorized" }, 401);
  }

  let rawBody: unknown;

  try {
    rawBody = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const validation = validateIncomingUpdate(rawBody);

  if (!validation.valid) {
    return json({ error: "Bad request" }, 400);
  }

  if (validation.ignored) {
    return json({ ok: true, ignored: true });
  }

  const update = validation.data.update;
  const updateType = validation.data.updateType;

  const budgetMs = options?.executionBudgetMs ?? 25_000;
  const deadline =
    options?.deadline ?? new StandardExecutionDeadline(budgetMs, options?.now);

  let attemptToken: string | undefined;

  try {
    const claim = await claimManagedTelegramUpdate(db, {
      botId: connection.botId,
      updateId: update.update_id,
      updateType,
      connectionId: connection.id,
    });

    if (claim.status === "already_processed") {
      return json({ ok: true, status: "already_processed" });
    }

    if (claim.status === "in_flight") {
      return new Response(
        JSON.stringify({ error: "Update is currently in flight" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "5",
          },
        },
      );
    }

    attemptToken = claim.attemptToken;
    deadline.checkOrThrow();

    const scope = await createStoreScopeForExistingStore(
      db,
      connection.storeId,
    );

    const availability = await readCheckoutAvailability(db, scope);
    let cod: CodContext = {
      enabled: availability.enabled,
      codEnabled: availability.codEnabled,
      vodafoneCashEnabled: availability.vodafoneCashEnabled,
      setting: availability.setting,
    };
    let commerceDb: TransactionDatabase | null = null;

    // Existing Vodafone Cash orders must remain serviceable after the method is
    // disabled for new checkouts, so the transaction client is opened whenever
    // it is available, independently of current checkout availability.
    try {
      commerceDb = options?.commerceDb ?? getTransactionDb();
    } catch {
      // A deployment without the transaction client keeps browsing intact
      // and simply does not offer cart/checkout or claim servicing.
      cod = { ...cod, enabled: false };
    }

    const transport =
      options?.transport ??
      createFetchTelegramTransport(
        decryptConnectionSecret(
          connection.tokenCiphertext,
          connection.tokenKeyId,
        ),
        { deadline },
      );

    if (options?.transport && "deadline" in options.transport) {
      (options.transport as { deadline?: ExecutionDeadline }).deadline = deadline;
    }

    if (validation.data.updateType === "message") {
      await dispatchMessage(
        db,
        scope,
        connection.storeName,
        connection.id,
        cod,
        commerceDb,
        transport,
        validation.data.message,
      );
    } else {
      await dispatchCallback(
        db,
        scope,
        connection.storeName,
        connection.id,
        cod,
        commerceDb,
        transport,
        validation.data.callbackQuery,
        validation.data.parsedToken,
        { botId: connection.botId, updateId: update.update_id, attemptToken },
      );
    }

    deadline.checkOrThrow();

    const marked = await markManagedTelegramUpdateProcessed(db, {
      botId: connection.botId,
      updateId: update.update_id,
      attemptToken,
    });

    if (!marked) {
      throw new Error("Managed update completion was not accepted");
    }

    return json({ ok: true });
  } catch (error) {
    const diagnostic = classifyErrorToSafeDiagnostic(error);

    if (attemptToken) {
      try {
        await markManagedTelegramUpdateFailed(db, {
          botId: connection.botId,
          updateId: update.update_id,
          attemptToken,
          errorMessage: formatSafeDiagnostic(diagnostic),
        });
      } catch {
        // Failure bookkeeping must never mask the original error.
      }
    }

    if (
      diagnostic.category === "rate_limited" &&
      diagnostic.retryAfterSeconds !== undefined
    ) {
      return new Response(
        JSON.stringify({ error: "Too Many Requests" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(diagnostic.retryAfterSeconds),
          },
        },
      );
    }

    if (diagnostic.category === "budget_exceeded") {
      return new Response(
        JSON.stringify({ error: "Service Unavailable" }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "5",
          },
        },
      );
    }

    return json({ error: "Internal server error" }, 500);
  }
}
