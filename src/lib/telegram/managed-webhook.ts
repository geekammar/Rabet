import "server-only";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import {
  listManagedCategories,
  listManagedProducts,
  listManagedProductsInCategory,
  readManagedCategory,
  readManagedProduct,
} from "@/lib/catalog/managed-storefront";
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

  await editOrThrow(transport, {
    chatId,
    messageId,
    text: lines.join("\n\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: UI.back,
            callback_data: tokens.storefrontCategory(productRow.categoryId),
          },
          { text: UI.home, callback_data: tokens.home() },
        ],
      ],
    },
  });
}

async function dispatchMessage(
  db: Database,
  scope: StoreScope,
  storeName: string,
  transport: TelegramTransport,
  message: TelegramMessage,
): Promise<void> {
  const text = typeof message.text === "string" ? message.text.trim() : "";

  if (text === "/start" || text.startsWith("/start ")) {
    await renderHome(
      db,
      scope,
      storeName,
      transport,
      message.chat.id,
    );
    return;
  }

  // The managed pilot has no inquiry or order path. Any other text returns the
  // scoped storefront rather than leaking a global or legacy journey.
  await renderHome(db, scope, storeName, transport, message.chat.id);
}

async function dispatchCallback(
  db: Database,
  scope: StoreScope,
  storeName: string,
  transport: TelegramTransport,
  callbackQuery: {
    id: string;
    message?: TelegramMessage;
    from: { id: number };
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

  if (parsedToken.type === "home") {
    await renderHome(db, scope, storeName, transport, chatId, messageId);
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
      transport,
      chatId,
      messageId,
      parsedToken.productId,
    );
    return;
  }

  // Every other legacy callback belongs to a different journey. Fail closed to
  // the scoped home instead of running an unscoped path.
  await renderHome(db, scope, storeName, transport, chatId, messageId);
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
        transport,
        validation.data.message,
      );
    } else {
      await dispatchCallback(
        db,
        scope,
        connection.storeName,
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
