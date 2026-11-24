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
} from "@/lib/catalog/managed-storefront";
import {
  addToCart,
  backToCart,
  changeCartQuantity,
  confirmCodOrder,
  isCodAvailable,
  readCartForBuyer,
  readInventoryAvailability,
  removeCartItem,
  saveAddressAndPrepareReview,
  savePhone,
  startCheckout,
  type CartView,
  type CheckoutReview,
  type CommerceSetting,
} from "@/lib/commerce/orders";
import {
  createStoreScopeForExistingStore,
  type StoreScope,
} from "@/lib/data/store-scope";
import {
  decryptConnectionSecret,
  verifyWebhookSecret,
} from "./connection-secrets";
import {
  claimManagedTelegramUpdate,
  markManagedTelegramUpdateFailed,
  markManagedTelegramUpdateProcessed,
} from "./managed-updates";
import { readReadyManagedConnection } from "./manager-provisioning";
import {
  managedCommerceCopy,
  managedCommerceLocaleFromLanguageCode,
  type ManagedCommerceLocale,
} from "./managed-commerce-copy";
import { tokens, type ParsedToken } from "./tokens";
import {
  classifyErrorToSafeDiagnostic,
  createFetchTelegramTransport,
  formatSafeDiagnostic,
  StandardExecutionDeadline,
} from "./transport";
import type {
  ExecutionDeadline,
  TelegramInlineKeyboardButton,
  TelegramMessage,
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
  ui: { home: string },
): TelegramInlineKeyboardButton[][] {
  return [[{ text: ui.home, callback_data: tokens.home() }]];
}

const UI = {
  home: "Home",
  products: "Products",
  browseCategories: "Browse categories",
  back: "Back",
  previous: "Previous",
  next: "Next",
  unavailable: "This item is not available in this store.",
  empty: "No products are available in this store yet.",
  noCategories: "No categories are available in this store yet.",
};

type CodContext = {
  enabled: boolean;
  setting: CommerceSetting | null;
};

type CommerceCopy = ReturnType<typeof managedCommerceCopy>;

function copyForLocale(locale: ManagedCommerceLocale): CommerceCopy {
  return managedCommerceCopy(locale);
}

function money(value: string, currency: string): string {
  return currency ? `${value} ${currency}` : value;
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

function reviewText(review: CheckoutReview, copy: CommerceCopy): string {
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
    `${copy.paymentLabel}: ${copy.cashOnDelivery}`,
    "",
    `${copy.nameLabel}: ${review.customerName}`,
    `${copy.phoneLabel}: ${review.customerPhone}`,
    `${copy.addressLabel}: ${review.deliveryAddress}`,
    "",
    copy.reviewInstruction,
  ];

  return lines.join("\n");
}

function reviewKeyboard(review: CheckoutReview, copy: CommerceCopy) {
  return {
    inline_keyboard: [
      [
        {
          text: copy.confirmButton,
          callback_data: tokens.confirmCod(review.cartId, review.quoteVersion),
        },
      ],
      [
        {
          text: copy.backToCart,
          callback_data: tokens.backToCart(review.cartId),
        },
        { text: UI.home, callback_data: tokens.home() },
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
  keyboard.push([{ text: UI.home, callback_data: tokens.home() }]);

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
      replyMarkup: { inline_keyboard: homeKeyboard(UI) },
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
): Promise<void> {
  const params = {
    chatId,
    text: reviewText(review, copy),
    replyMarkup: reviewKeyboard(review, copy),
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
      keyboard: [[{ text: copy.sharePhone, request_contact: true }]],
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
    replyMarkup: { remove_keyboard: true },
  });
}

async function renderPlacedOrder(
  transport: TelegramTransport,
  chatId: number,
  messageId: number | undefined,
  result: {
    reference: string;
    subtotal: string;
    deliveryFee: string;
    total: string;
    currency: string;
  },
  copy: CommerceCopy,
): Promise<void> {
  const text = [
    copy.orderPlaced(result.reference),
    "",
    `${copy.subtotal}: ${money(result.subtotal, result.currency)}`,
    `${copy.deliveryFee}: ${money(result.deliveryFee, result.currency)}`,
    `${copy.total}: ${money(result.total, result.currency)}`,
    copy.awaitingCollection,
    "",
    copy.reservedNote,
  ].join("\n");

  const params = {
    chatId,
    text,
    replyMarkup: { inline_keyboard: homeKeyboard(UI) },
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

async function renderHome(
  db: Database,
  scope: StoreScope,
  storeName: string,
  cod: CodContext,
  copy: CommerceCopy,
  transport: TelegramTransport,
  chatId: number,
  messageId?: number,
): Promise<void> {
  const page = await listManagedProducts(db, scope, {
    page: 1,
    pageSize: PAGE_SIZE,
  });

  const keyboard: TelegramInlineKeyboardButton[][] = page.items.map((item) => [
    productButton(item),
  ]);

  keyboard.push([
    { text: UI.browseCategories, callback_data: tokens.storefrontCategories() },
  ]);

  if (cod.enabled) {
    keyboard.push([{ text: copy.cart, callback_data: tokens.cart() }]);
  }

  if (page.totalPages > 1) {
    keyboard.push([
      { text: UI.next, callback_data: tokens.products(2) },
    ]);
  }

  const text =
    page.totalCount === 0
      ? `Welcome to ${storeName}.\n\n${UI.empty}`
      : `Welcome to ${storeName}.\n\n${UI.products}`;

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
): Promise<void> {
  const page = await listManagedProducts(db, scope, {
    page: pageNumber,
    pageSize: PAGE_SIZE,
  });

  const keyboard: TelegramInlineKeyboardButton[][] = page.items.map((item) => [
    productButton(item),
  ]);

  if (page.totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (page.page > 1) {
      nav.push({
        text: UI.previous,
        callback_data: tokens.products(page.page - 1),
      });
    }
    if (page.page < page.totalPages) {
      nav.push({
        text: UI.next,
        callback_data: tokens.products(page.page + 1),
      });
    }
    keyboard.push(nav);
  }

  keyboard.push(...homeKeyboard(UI));

  const text =
    page.totalCount === 0
      ? UI.empty
      : `${UI.products} (${page.page}/${page.totalPages})`;

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
): Promise<void> {
  const page = await listManagedCategories(db, scope, {
    parentId: null,
    page: pageNumber,
    pageSize: PAGE_SIZE,
  });

  const keyboard: TelegramInlineKeyboardButton[][] = page.items.map((item) => [
    categoryButton(item),
  ]);

  if (page.totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (page.page > 1) {
      nav.push({
        text: UI.previous,
        callback_data: tokens.storefrontCategories(page.page - 1),
      });
    }
    if (page.page < page.totalPages) {
      nav.push({
        text: UI.next,
        callback_data: tokens.storefrontCategories(page.page + 1),
      });
    }
    keyboard.push(nav);
  }

  keyboard.push(...homeKeyboard(UI));

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: page.totalCount === 0 ? UI.noCategories : UI.browseCategories,
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
): Promise<void> {
  const categoryRow = await readManagedCategory(db, scope, categoryId);

  if (!categoryRow) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: UI.unavailable,
      replyMarkup: { inline_keyboard: homeKeyboard(UI) },
    });
    return;
  }

  const [children, products] = await Promise.all([
    listManagedCategories(db, scope, {
      parentId: categoryId,
      page: 1,
      pageSize: PAGE_SIZE,
    }),
    listManagedProductsInCategory(db, scope, {
      categoryId,
      page: pageNumber,
      pageSize: PAGE_SIZE,
    }),
  ]);

  const keyboard: TelegramInlineKeyboardButton[][] = [
    ...children.items.map((item) => [categoryButton(item)]),
    ...products.items.map((item) => [productButton(item)]),
  ];

  if (products.totalPages > 1) {
    const nav: TelegramInlineKeyboardButton[] = [];
    if (products.page > 1) {
      nav.push({
        text: UI.previous,
        callback_data: tokens.storefrontCategory(
          categoryId,
          products.page - 1,
        ),
      });
    }
    if (products.page < products.totalPages) {
      nav.push({
        text: UI.next,
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
      text: UI.back,
      callback_data: categoryRow.parentId
        ? tokens.storefrontCategory(categoryRow.parentId)
        : tokens.storefrontCategories(),
    },
    { text: UI.home, callback_data: tokens.home() },
  ]);

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: categoryRow.name,
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function renderProduct(
  db: Database,
  scope: StoreScope,
  cod: CodContext,
  copy: CommerceCopy,
  transport: TelegramTransport,
  chatId: number,
  messageId: number,
  productId: string,
): Promise<void> {
  const productRow = await readManagedProduct(db, scope, productId);

  if (!productRow) {
    await editOrThrow(transport, {
      chatId,
      messageId,
      text: UI.unavailable,
      replyMarkup: { inline_keyboard: homeKeyboard(UI) },
    });
    return;
  }

  const lines = [productRow.name];

  if (productRow.description && productRow.description.trim().length > 0) {
    lines.push(productRow.description.trim());
  }

  lines.push(productRow.price);

  const keyboard: TelegramInlineKeyboardButton[][] = [];
  let stock = 0;

  if (cod.enabled) {
    const availability = await readInventoryAvailability(db, scope, [
      productId,
    ]);
    stock = availability.get(productId) ?? 0;

    if (stock <= 0) {
      lines.push(copy.outOfStock);
    } else {
      const maxQuantity = Math.min(5, stock);
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

  keyboard.push([
    {
      text: UI.back,
      callback_data: tokens.storefrontCategory(productRow.categoryId),
    },
    { text: UI.home, callback_data: tokens.home() },
  ]);

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: lines.join("\n\n"),
    replyMarkup: { inline_keyboard: keyboard },
  });
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
  const buyerId = message.from?.id;
  const locale = managedCommerceLocaleFromLanguageCode(
    message.from?.language_code,
  );
  const copy = copyForLocale(locale);

  if (text === "/start" || text.startsWith("/start ")) {
    await renderHome(
      db,
      scope,
      storeName,
      cod,
      copy,
      transport,
      message.chat.id,
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
      transport,
      message.chat.id,
    );
    return;
  }

  if (cod.enabled && commerceDb) {
    const activeCart = await readCartForBuyer(db, scope, {
      connectionId,
      telegramUserId: buyerId,
    });

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
            replyMarkup: {
              keyboard: [[{ text: copy.sharePhone, request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
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
            replyMarkup: {
              keyboard: [[{ text: copy.sharePhone, request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
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
        });

        if (result.status === "review") {
          await renderReviewView(
            transport,
            message.chat.id,
            undefined,
            result.review,
            copy,
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
              ...homeKeyboard(UI),
            ],
          },
        });
        return;
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
    transport,
    message.chat.id,
  );
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
  const buyerId = callbackQuery.from.id;
  const locale = managedCommerceLocaleFromLanguageCode(
    callbackQuery.from.language_code,
  );
  const copy = copyForLocale(locale);

  if (cod.enabled && commerceDb) {
    if (parsedToken.type === "cart") {
      await renderCartView(
        transport,
        chatId,
        messageId,
        await readCartForBuyer(db, scope, {
          connectionId,
          telegramUserId: buyerId,
        }),
        copy,
      );
      return;
    }

    if (parsedToken.type === "cartAdd") {
      const result = await addToCart(commerceDb, scope, {
        connectionId,
        telegramUserId: buyerId,
        telegramChatId: chatId,
        productId: parsedToken.productId,
        quantity: parsedToken.quantity,
      });

      if (result.status === "added") {
        await renderCartView(transport, chatId, messageId, result.cart, copy);
        return;
      }

      await editOrThrow(transport, {
        chatId,
        messageId,
        text:
          result.status === "out_of_stock"
            ? copy.outOfStock
            : result.status === "cod_unavailable"
              ? copy.notOrderable
              : copy.unavailable,
        replyMarkup: { inline_keyboard: homeKeyboard(UI) },
      });
      return;
    }

    if (parsedToken.type === "cartIncrease") {
      const result = await changeCartQuantity(commerceDb, scope, {
        connectionId,
        telegramUserId: buyerId,
        productId: parsedToken.productId,
        delta: 1,
      });

      if (result.status === "updated") {
        await renderCartView(transport, chatId, messageId, result.cart, copy);
        return;
      }

      await editOrThrow(transport, {
        chatId,
        messageId,
        text:
          result.status === "empty"
            ? copy.cartEmpty
            : result.status === "invalid_quantity"
              ? copy.maxQuantity
              : copy.genericUnavailable,
        replyMarkup: { inline_keyboard: homeKeyboard(UI) },
      });
      return;
    }

    if (parsedToken.type === "cartDecrease") {
      const result = await changeCartQuantity(commerceDb, scope, {
        connectionId,
        telegramUserId: buyerId,
        productId: parsedToken.productId,
        delta: -1,
      });

      if (result.status === "updated") {
        await renderCartView(transport, chatId, messageId, result.cart, copy);
        return;
      }

      await renderCartView(transport, chatId, messageId, null, copy);
      return;
    }

    if (parsedToken.type === "cartRemove") {
      const result = await removeCartItem(commerceDb, scope, {
        connectionId,
        telegramUserId: buyerId,
        productId: parsedToken.productId,
      });

      if (result.status === "updated") {
        await renderCartView(transport, chatId, messageId, result.cart, copy);
        return;
      }

      await renderCartView(transport, chatId, messageId, null, copy);
      return;
    }

    if (parsedToken.type === "checkout") {
      const result = await startCheckout(commerceDb, scope, {
        cartId: parsedToken.cartId,
        connectionId,
        telegramUserId: buyerId,
        profileName: callbackQuery.from.first_name,
      });

      if (result.status === "ready") {
        await renderCartView(transport, chatId, messageId, result.cart, copy);
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
            ...homeKeyboard(UI),
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
      });

      if (result.status === "placed" || result.status === "already_placed") {
        await renderPlacedOrder(transport, chatId, messageId, result, copy);
        return;
      }

      if (result.status === "stale_quote") {
        await renderReviewView(
          transport,
          chatId,
          messageId,
          result.review,
          copy,
        );
        return;
      }

      if (result.status === "missing_details") {
        await editOrThrow(transport, {
          chatId,
          messageId,
          text: copy.checkoutNeedsDetails,
          replyMarkup: { inline_keyboard: homeKeyboard(UI) },
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
              ...homeKeyboard(UI),
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
        replyMarkup: { inline_keyboard: homeKeyboard(UI) },
      });
      return;
    }

    if (parsedToken.type === "backToCart") {
      const cart = await backToCart(commerceDb, scope, {
        cartId: parsedToken.cartId,
        connectionId,
        telegramUserId: buyerId,
      });

      await renderCartView(transport, chatId, messageId, cart, copy);
      return;
    }
  }

  if (parsedToken.type === "home") {
    await renderHome(
      db,
      scope,
      storeName,
      cod,
      copy,
      transport,
      chatId,
      messageId,
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
    );
    return;
  }

  if (parsedToken.type === "product") {
    await renderProduct(
      db,
      scope,
      cod,
      copy,
      transport,
      chatId,
      messageId,
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
    transport,
    chatId,
    messageId,
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

    let cod = await isCodAvailable(db, scope);
    let commerceDb: TransactionDatabase | null = null;

    if (cod.enabled) {
      try {
        commerceDb = options?.commerceDb ?? getTransactionDb();
      } catch {
        // A deployment without the transaction client keeps browsing intact
        // and simply does not offer cart/checkout.
        cod = { enabled: false, setting: cod.setting };
      }
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
