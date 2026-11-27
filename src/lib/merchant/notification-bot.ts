import "server-only";

import type { Database } from "@/db/client";
import type { TransactionDatabase } from "@/db/transaction-client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import {
  cancelActiveNotificationBotManagedAttempts,
  confirmMerchantNotificationBotPairing,
  disconnectMerchantNotificationBot as deleteMerchantNotificationBot,
  lockNotificationBotOnboarding,
  markMerchantNotificationBotPairingAmbiguous,
  mergeMerchantNotificationBotPairingCandidates,
  readMerchantNotificationBotSecret,
  recordMerchantNotificationBotTestSuccess,
  saveMerchantNotificationBotToken,
  startMerchantNotificationBotPairing as replaceMerchantNotificationBotPairing,
} from "@/lib/data/merchant-notification-bot";
import type { MerchantNotificationPairingCandidate } from "@/db/schema/merchant-notification-bot";
import { RabetDataError } from "@/lib/data/errors";
import type { MerchantNotificationBotSecret } from "@/lib/data/merchant-notification-bot";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "@/lib/telegram/connection-secrets";
import type { TelegramBotApiClient } from "@/lib/telegram/manager-api";
import {
  generateMerchantNotificationPairingCode,
  hashMerchantNotificationPairingCode,
  merchantNotificationPairingDeepLink,
  MERCHANT_NOTIFICATION_PAIRING_TTL_MS,
  normalizeMerchantNotificationBotToken,
  readMerchantNotificationBotIdentity,
  readMerchantNotificationBotPairingPage,
  type MerchantNotificationBotPairingPageResult,
  sendMerchantNotificationBotTest as deliverMerchantNotificationBotTest,
} from "@/lib/telegram/merchant-notification-bot";
import type { TelegramTransport } from "@/lib/telegram/types";

/**
 * Merchant-owned notification bot setup and test delivery.
 *
 * The store id always comes from the verified merchant session. Every write
 * re-runs the same database-backed eligibility rule inside its transaction, so
 * a suspended store, revoked membership or stale session version cannot write
 * through an already-open tab.
 *
 * Telegram calls happen outside database transactions. Only allowlisted error
 * codes are returned; token, ciphertext and Telegram descriptions never reach
 * the browser or the log stream.
 */

export type MerchantNotificationBotErrorCode =
  | "UNAVAILABLE"
  | "DENIED"
  | "TOKEN_REQUIRED"
  | "INVALID_TOKEN"
  | "BOT_ALREADY_CONNECTED"
  | "TELEGRAM_UNAVAILABLE"
  | "PAIRING_PENDING"
  | "PAIRING_EXPIRED"
  | "PAIRING_AMBIGUOUS"
  | "PAIRING_REQUIRED"
  | "PAIRING_UNAVAILABLE"
  | "PAIRING_WEBHOOK_ACTIVE"
  | "NOT_CONNECTED"
  | "TEST_BLOCKED"
  | "TEST_CHAT_NOT_FOUND"
  | "TEST_RATE_LIMITED"
  | "TEST_NETWORK"
  | "TELEGRAM_REJECTED"
  | "CONFIGURATION_CHANGED"
  | "BOT_START_PENDING"
  | "BOT_START_LINK_REQUIRED"
  | "RESUME_UNAVAILABLE"
  | "EXPIRED"
  | "CONFLICT"
  | "SUPERSEDED"
  | "RETRYABLE"
  | "REVIEW"
  | "NOT_FOUND"
  | "OPERATION_FAILED";

export type MerchantNotificationBotResult =
  | {
      ok: true;
      pairing?: { deepLink: string; expiresAt: string };
      managed?: { deepLink?: string; expiresAt?: string };
      messageId?: number;
    }
  | {
      ok: false;
      error: MerchantNotificationBotErrorCode;
      retryAfterSeconds?: number;
    };

export type MerchantNotificationBotDeps = {
  now?: () => Date;
  api?: TelegramBotApiClient;
  transport?: TelegramTransport;
  /** Test seam for bounded backlog progress; production uses 10 pages. */
  pairingMaxPages?: number;
};

function safeCategory(error: unknown): string {
  if (error instanceof RabetDataError) return error.code;

  if (
    error instanceof Error &&
    /^[A-Za-z0-9_]{1,64}$/.test(error.name)
  ) {
    return error.name;
  }

  return "unknown";
}

function logFailure(phase: string, error: unknown): void {
  console.error("[merchant-notification-bot] failed", {
    phase,
    category: safeCategory(error),
  });
}

/**
 * Finds a typed data error even when the database transaction wrapper has
 * placed it on the cause chain. The wrapper's own message is never inspected.
 */
function hasDataErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;

  for (
    let depth = 0;
    depth < 8 && current !== null && typeof current === "object";
    depth++
  ) {
    if (current instanceof RabetDataError && current.code === code) {
      return true;
    }

    current =
      "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return false;
}

/** Detects a unique-key conflict even when the driver error is unwrapped. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (
    let depth = 0;
    depth < 8 && current !== null && typeof current === "object";
    depth++
  ) {
    if (current instanceof RabetDataError && current.code === "CONFLICT") {
      return true;
    }

    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }

    current =
      "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return false;
}

async function recheckMerchantAccess(
  tx: unknown,
  access: MerchantAccess,
  expectedStoreId = access.scope.storeId,
): Promise<boolean> {
  const eligibility = await resolveMerchantEligibility(
    tx as unknown as TransactionDatabase,
    {
      userId: access.userId,
      sessionVersion: access.sessionVersion,
    },
  );

  return Boolean(
    eligibility &&
      !eligibility.readOnly &&
      eligibility.store.id === expectedStoreId,
  );
}

async function readSecret(
  db: TransactionDatabase,
  access: MerchantAccess,
) {
  return readMerchantNotificationBotSecret(
    db as unknown as Database,
    access.scope.storeId,
  );
}

const DEFAULT_PAIRING_MAX_PAGES = 10;
const MAX_PAIRING_MAX_PAGES = 50;

function boundedPageCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PAIRING_MAX_PAGES;
  }

  return Math.min(
    MAX_PAIRING_MAX_PAGES,
    Math.max(1, Math.floor(value)),
  );
}

function pairingPageError(
  error: Extract<
    MerchantNotificationBotPairingPageResult,
    { status: "error" }
  >,
): MerchantNotificationBotResult {
  switch (error.code) {
    case "INVALID_TOKEN":
      return { ok: false, error: "INVALID_TOKEN" };
    case "WEBHOOK_ACTIVE":
      return { ok: false, error: "PAIRING_WEBHOOK_ACTIVE" };
    case "RATE_LIMITED":
      return {
        ok: false,
        error: "TELEGRAM_UNAVAILABLE",
        retryAfterSeconds: error.retryAfterSeconds,
      };
    case "NETWORK":
      return { ok: false, error: "TELEGRAM_UNAVAILABLE" };
    default:
      return { ok: false, error: "PAIRING_UNAVAILABLE" };
  }
}

async function pairingWriteStaleResult(
  db: TransactionDatabase,
  access: MerchantAccess,
): Promise<Extract<MerchantNotificationBotResult, { ok: false }>> {
  const current = await readSecret(db, access);

  if (!current) return { ok: false, error: "NOT_CONNECTED" };

  if (current.pairingFailureCode === "ambiguous") {
    return { ok: false, error: "PAIRING_AMBIGUOUS" };
  }

  if (!current.pairingCodeHash || !current.pairingExpiresAt) {
    return { ok: false, error: "PAIRING_REQUIRED" };
  }

  return { ok: false, error: "PAIRING_EXPIRED" };
}

async function mergePairingPage(
  db: TransactionDatabase,
  access: MerchantAccess,
  pairingCodeHash: string,
  candidates: MerchantNotificationPairingCandidate[],
  nextOffset: number,
): Promise<
  | {
      ok: true;
      candidates: MerchantNotificationPairingCandidate[];
      nextOffset: number;
    }
  | Extract<MerchantNotificationBotResult, { ok: false }>
> {
  try {
    const outcome = await db.transaction(async (tx) => {
      await lockNotificationBotOnboarding(
        tx as unknown as Database,
        access.scope.storeId,
      );

      if (!(await recheckMerchantAccess(tx, access))) {
        return { status: "denied" } as const;
      }

      const merged = await mergeMerchantNotificationBotPairingCandidates(
        tx as unknown as Database,
        {
          storeId: access.scope.storeId,
          pairingCodeHash,
          candidates,
          nextOffset,
        },
      );

      if (!merged) return { status: "stale" } as const;

      await cancelActiveNotificationBotManagedAttempts(
        tx as unknown as Database,
        { storeId: access.scope.storeId },
      );

      return { status: "merged", merged } as const;
    });

    if (outcome.status === "denied") {
      return { ok: false, error: "DENIED" };
    }

    if (outcome.status === "stale") {
      return pairingWriteStaleResult(db, access);
    }

    return {
      ok: true,
      candidates: outcome.merged.candidates,
      nextOffset: outcome.merged.nextOffset,
    };
  } catch (error) {
    logFailure("pairing_page_write", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

async function markPairingAmbiguous(
  db: TransactionDatabase,
  access: MerchantAccess,
  pairingCodeHash: string,
): Promise<MerchantNotificationBotResult> {
  try {
    const outcome = await db.transaction(async (tx) => {
      await lockNotificationBotOnboarding(
        tx as unknown as Database,
        access.scope.storeId,
      );

      if (!(await recheckMerchantAccess(tx, access))) {
        return "denied" as const;
      }

      const marked = await markMerchantNotificationBotPairingAmbiguous(
        tx as unknown as Database,
        {
          storeId: access.scope.storeId,
          pairingCodeHash,
        },
      );

      if (!marked) return "stale" as const;

      await cancelActiveNotificationBotManagedAttempts(
        tx as unknown as Database,
        { storeId: access.scope.storeId },
      );

      return "marked" as const;
    });

    if (outcome === "denied") {
      return { ok: false, error: "DENIED" };
    }

    if (outcome === "marked") {
      return { ok: false, error: "PAIRING_AMBIGUOUS" };
    }

    return pairingWriteStaleResult(db, access);
  } catch (error) {
    logFailure("pairing_ambiguous_write", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

async function confirmPairingCandidate(
  db: TransactionDatabase,
  access: MerchantAccess,
  pairingCodeHash: string,
  candidate: MerchantNotificationPairingCandidate,
): Promise<MerchantNotificationBotResult> {
  try {
    const outcome = await db.transaction(async (tx) => {
      await lockNotificationBotOnboarding(
        tx as unknown as Database,
        access.scope.storeId,
      );

      if (!(await recheckMerchantAccess(tx, access))) {
        return { status: "denied" } as const;
      }

      const confirmed = await confirmMerchantNotificationBotPairing(
        tx as unknown as Database,
        {
          storeId: access.scope.storeId,
          pairingCodeHash,
          chatId: candidate.chatId,
          chatTitle: candidate.title,
          chatUsername: candidate.username,
        },
      );

      if (confirmed) {
        await cancelActiveNotificationBotManagedAttempts(
          tx as unknown as Database,
          { storeId: access.scope.storeId },
        );
        return { status: "confirmed" } as const;
      }

      const current = await readMerchantNotificationBotSecret(
        tx as unknown as Database,
        access.scope.storeId,
      );

      if (!current) return { status: "missing" } as const;

      if (
        current.pairingFailureCode === "ambiguous" ||
        (current.pairingCandidates?.length ?? 0) > 1
      ) {
        const marked = await markMerchantNotificationBotPairingAmbiguous(
          tx as unknown as Database,
          {
            storeId: access.scope.storeId,
            pairingCodeHash,
          },
        );

        if (marked) {
          await cancelActiveNotificationBotManagedAttempts(
            tx as unknown as Database,
            { storeId: access.scope.storeId },
          );
        }

        return { status: "ambiguous" } as const;
      }

      return { status: "stale" } as const;
    });

    if (outcome.status === "denied") {
      return { ok: false, error: "DENIED" };
    }

    if (outcome.status === "confirmed") {
      return { ok: true };
    }

    if (outcome.status === "ambiguous") {
      return { ok: false, error: "PAIRING_AMBIGUOUS" };
    }

    if (outcome.status === "missing") {
      return { ok: false, error: "NOT_CONNECTED" };
    }

    return pairingWriteStaleResult(db, access);
  } catch (error) {
    logFailure("pairing_confirm_write", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

/**
 * Validates a submitted bot token with Telegram, stores it encrypted, and
 * creates a short-lived pairing challenge. The token is never returned.
 */
export async function connectMerchantNotificationBot(
  db: TransactionDatabase,
  access: MerchantAccess,
  input: { token?: unknown },
  deps: MerchantNotificationBotDeps = {},
): Promise<MerchantNotificationBotResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  if (typeof input.token !== "string" || input.token.trim().length === 0) {
    return { ok: false, error: "TOKEN_REQUIRED" };
  }

  const token = normalizeMerchantNotificationBotToken(input.token);

  if (!token) {
    return { ok: false, error: "INVALID_TOKEN" };
  }

  const identity = await readMerchantNotificationBotIdentity(token, {
    api: deps.api,
  });

  if (!identity.ok) {
    return identity.code === "INVALID_TOKEN"
      ? { ok: false, error: "INVALID_TOKEN" }
      : {
          ok: false,
          error: "TELEGRAM_UNAVAILABLE",
          retryAfterSeconds: identity.retryAfterSeconds,
        };
  }

  let encrypted: { ciphertext: string; keyId: string };

  try {
    encrypted = encryptConnectionSecret(token);
  } catch (error) {
    logFailure("encrypt", error);
    return { ok: false, error: "UNAVAILABLE" };
  }

  const now = deps.now?.() ?? new Date();
  const code = generateMerchantNotificationPairingCode();
  const pairingCodeHash = hashMerchantNotificationPairingCode(code);
  const pairingExpiresAt = new Date(
    now.getTime() + MERCHANT_NOTIFICATION_PAIRING_TTL_MS,
  );

  try {
    const outcome = await db.transaction(async (tx) => {
      await lockNotificationBotOnboarding(
        tx as unknown as Database,
        access.scope.storeId,
      );

      if (!(await recheckMerchantAccess(tx, access))) {
        return { ok: false, error: "DENIED" } as const;
      }

      try {
        await saveMerchantNotificationBotToken(tx as unknown as Database, {
          storeId: access.scope.storeId,
          botId: identity.bot.id,
          botUsername: identity.bot.username,
          botName: identity.bot.name,
          tokenCiphertext: encrypted.ciphertext,
          tokenKeyId: encrypted.keyId,
          pairingCodeHash,
          pairingExpiresAt,
          now,
        });
      } catch (error) {
        if (
          error instanceof RabetDataError &&
          error.code === "CONFLICT"
        ) {
          return { ok: false, error: "BOT_ALREADY_CONNECTED" } as const;
        }

        throw error;
      }

      await cancelActiveNotificationBotManagedAttempts(
        tx as unknown as Database,
        { storeId: access.scope.storeId, now },
      );

      return { ok: true } as const;
    });

    if (!outcome.ok) return outcome;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, error: "BOT_ALREADY_CONNECTED" };
    }

    logFailure("connect_write", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }

  return {
    ok: true,
    pairing: {
      deepLink: merchantNotificationPairingDeepLink(
        identity.bot.username,
        code,
      ),
      expiresAt: pairingExpiresAt.toISOString(),
    },
  };
}

/**
 * Replaces the pairing challenge with a new short-lived link. Used when the
 * merchant needs a fresh link or wants to change the receiving chat.
 */
export async function startMerchantNotificationBotPairing(
  db: TransactionDatabase,
  access: MerchantAccess,
  deps: MerchantNotificationBotDeps = {},
): Promise<MerchantNotificationBotResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const secret = await readSecret(db, access);

  if (!secret) {
    return { ok: false, error: "NOT_CONNECTED" };
  }

  const now = deps.now?.() ?? new Date();
  const code = generateMerchantNotificationPairingCode();
  const pairingCodeHash = hashMerchantNotificationPairingCode(code);
  const pairingExpiresAt = new Date(
    now.getTime() + MERCHANT_NOTIFICATION_PAIRING_TTL_MS,
  );

  try {
    const outcome = await db.transaction(async (tx) => {
      await lockNotificationBotOnboarding(
        tx as unknown as Database,
        access.scope.storeId,
      );

      if (!(await recheckMerchantAccess(tx, access))) {
        return { ok: false, error: "DENIED" } as const;
      }

      try {
        await replaceMerchantNotificationBotPairing(
          tx as unknown as Database,
          {
            storeId: access.scope.storeId,
            pairingCodeHash,
            pairingExpiresAt,
            now,
          },
        );
      } catch (error) {
        if (
          error instanceof RabetDataError &&
          error.code === "NOT_FOUND"
        ) {
          return { ok: false, error: "NOT_CONNECTED" } as const;
        }

        throw error;
      }

      await cancelActiveNotificationBotManagedAttempts(
        tx as unknown as Database,
        { storeId: access.scope.storeId, now },
      );

      return { ok: true } as const;
    });

    if (!outcome.ok) return outcome;
  } catch (error) {
    if (hasDataErrorCode(error, "NOT_FOUND")) {
      return { ok: false, error: "NOT_CONNECTED" };
    }

    logFailure("pairing_start_write", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }

  return {
    ok: true,
    pairing: {
      deepLink: merchantNotificationPairingDeepLink(
        secret.botUsername,
        code,
      ),
      expiresAt: pairingExpiresAt.toISOString(),
    },
  };
}

/**
 * Reads recent bot updates and confirms exactly one private chat that sent the
 * current pairing code. A stale digest, another store's digest, or a digest
 * that expired can never write a destination.
 */
export async function checkMerchantNotificationBotPairing(
  db: TransactionDatabase,
  access: MerchantAccess,
  deps: MerchantNotificationBotDeps = {},
): Promise<MerchantNotificationBotResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const secret = await readSecret(db, access);

  if (!secret) {
    return { ok: false, error: "NOT_CONNECTED" };
  }

  if (secret.pairingFailureCode === "ambiguous") {
    return { ok: false, error: "PAIRING_AMBIGUOUS" };
  }

  if (!secret.pairingCodeHash || !secret.pairingExpiresAt) {
    return { ok: false, error: "PAIRING_REQUIRED" };
  }

  const now = deps.now?.() ?? new Date();

  if (secret.pairingExpiresAt.getTime() <= now.getTime()) {
    return { ok: false, error: "PAIRING_EXPIRED" };
  }

  let token: string;

  try {
    token = decryptConnectionSecret(
      secret.tokenCiphertext,
      secret.tokenKeyId,
    );
  } catch (error) {
    logFailure("decrypt", error);
    return { ok: false, error: "UNAVAILABLE" };
  }

  let candidates = secret.pairingCandidates ?? [];
  let offset = secret.pairingUpdateOffset ?? undefined;
  let scanComplete = false;
  const maxPages = boundedPageCount(deps.pairingMaxPages);

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await readMerchantNotificationBotPairingPage(
      token,
      secret.pairingCodeHash,
      { api: deps.api, offset, limit: 100 },
    );

    if (page.status === "error") {
      return pairingPageError(page);
    }

    if (page.nextOffset === null) {
      if (page.candidates.length === 0) {
        scanComplete = true;
        break;
      }

      // Updates without a usable update id cannot be confirmed safely.
      return { ok: false, error: "PAIRING_UNAVAILABLE" };
    }

    const merged = await mergePairingPage(
      db,
      access,
      secret.pairingCodeHash,
      page.candidates,
      page.nextOffset,
    );

    if (!merged.ok) return merged;

    candidates = merged.candidates;
    offset = merged.nextOffset;

    if (candidates.length > 1) {
      return markPairingAmbiguous(
        db,
        access,
        secret.pairingCodeHash,
      );
    }

    if (!page.isFullPage) {
      scanComplete = true;
      break;
    }
  }

  if (!scanComplete) {
    // The page budget stopped the scan before a short/empty page. The last
    // full page's candidates and cursor are already persisted.
    return { ok: false, error: "PAIRING_PENDING" };
  }

  if (candidates.length === 0) {
    return { ok: false, error: "PAIRING_PENDING" };
  }

  if (candidates.length > 1) {
    return markPairingAmbiguous(db, access, secret.pairingCodeHash);
  }

  return confirmPairingCandidate(
    db,
    access,
    secret.pairingCodeHash,
    candidates[0],
  );
}

/**
 * Sends a synthetic test notification to the paired chat. This path is
 * independent of checkout, orders and payments; it only reads the notification
 * bot row and the Telegram API.
 */
type MerchantNotificationTestSendContext = {
  storeId: string;
  storeName: string;
  secret: MerchantNotificationBotSecret;
};

/**
 * Resolves the current bot and recipient from a live eligibility check in the
 * same transaction. This runs before any Telegram test-send side effect, so a
 * suspended store or revoked session cannot cause a send through a stale page.
 */
async function resolveMerchantNotificationTestSendContext(
  db: TransactionDatabase,
  access: MerchantAccess,
): Promise<
  | { ok: true; context: MerchantNotificationTestSendContext }
  | {
      ok: false;
      error: "DENIED" | "NOT_CONNECTED" | "PAIRING_REQUIRED" | "OPERATION_FAILED";
    }
> {
  try {
    return await db.transaction(async (tx) => {
      const eligibility = await resolveMerchantEligibility(
        tx as unknown as TransactionDatabase,
        {
          userId: access.userId,
          sessionVersion: access.sessionVersion,
        },
      );

      if (
        !eligibility ||
        eligibility.readOnly ||
        eligibility.store.id !== access.scope.storeId
      ) {
        return { ok: false, error: "DENIED" } as const;
      }

      const secret = await readMerchantNotificationBotSecret(
        tx as unknown as Database,
        eligibility.store.id,
      );

      if (!secret) {
        return { ok: false, error: "NOT_CONNECTED" } as const;
      }

      if (!secret.destinationChatId) {
        return { ok: false, error: "PAIRING_REQUIRED" } as const;
      }

      return {
        ok: true,
        context: {
          storeId: eligibility.store.id,
          storeName: eligibility.store.name,
          secret,
        },
      } as const;
    });
  } catch (error) {
    logFailure("test_preflight", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

/**
 * Sends a synthetic test notification to the paired chat. This path is
 * independent of checkout, orders and payments; it only reads the notification
 * bot row and the Telegram API.
 *
 * Eligibility, store scope, bot identity, recipient and configuration epoch
 * are resolved immediately before the send. Verification is committed only
 * while that exact epoch is still current, so a reconnect or re-pair to the
 * same bot and chat cannot inherit a test sent against the old configuration.
 */
export async function sendMerchantNotificationBotTest(
  db: TransactionDatabase,
  access: MerchantAccess,
  input: { locale?: unknown },
  deps: MerchantNotificationBotDeps = {},
): Promise<MerchantNotificationBotResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const resolved = await resolveMerchantNotificationTestSendContext(db, access);

  if (!resolved.ok) {
    return resolved;
  }

  const { context } = resolved;
  const { secret } = context;
  const chatId = secret.destinationChatId;

  if (!chatId) {
    return { ok: false, error: "PAIRING_REQUIRED" };
  }

  let token: string;

  try {
    token = decryptConnectionSecret(
      secret.tokenCiphertext,
      secret.tokenKeyId,
    );
  } catch (error) {
    logFailure("decrypt", error);
    return { ok: false, error: "UNAVAILABLE" };
  }

  const locale = input.locale === "en" ? "en" : "ar";
  const delivery = await deliverMerchantNotificationBotTest({
    token,
    chatId,
    locale,
    storeName: context.storeName,
    transport: deps.transport,
  });

  if (!delivery.ok) {
    switch (delivery.code) {
      case "BLOCKED":
        return { ok: false, error: "TEST_BLOCKED" };
      case "CHAT_NOT_FOUND":
        return { ok: false, error: "TEST_CHAT_NOT_FOUND" };
      case "RATE_LIMITED":
        return {
          ok: false,
          error: "TEST_RATE_LIMITED",
          retryAfterSeconds: delivery.retryAfterSeconds,
        };
      case "NETWORK":
        return { ok: false, error: "TEST_NETWORK" };
      case "INVALID_TOKEN":
        return { ok: false, error: "INVALID_TOKEN" };
      default:
        return { ok: false, error: "TELEGRAM_REJECTED" };
    }
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      if (!(await recheckMerchantAccess(tx, access, context.storeId))) {
        return { ok: false, error: "DENIED" } as const;
      }

      try {
        await recordMerchantNotificationBotTestSuccess(
          tx as unknown as Database,
          {
            storeId: context.storeId,
            expectedChatId: chatId,
            expectedBotId: secret.botId,
            expectedConfigEpoch: secret.configEpoch,
          },
        );
      } catch (error) {
        if (
          error instanceof RabetDataError &&
          error.code === "CONFIGURATION_CHANGED"
        ) {
          return { ok: false, error: "CONFIGURATION_CHANGED" } as const;
        }

        throw error;
      }

      return { ok: true } as const;
    });

    if (!outcome.ok) return outcome;
  } catch (error) {
    if (hasDataErrorCode(error, "CONFIGURATION_CHANGED")) {
      return { ok: false, error: "CONFIGURATION_CHANGED" };
    }

    logFailure("test_verify_write", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }

  return { ok: true, messageId: delivery.messageId };
}

/**
 * Disconnects the store's notification bot and deletes its encrypted token.
 * The buyer-facing store bot and operator notification settings are separate
 * and are not touched.
 */
export async function disconnectMerchantNotificationBot(
  db: TransactionDatabase,
  access: MerchantAccess,
): Promise<MerchantNotificationBotResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      await lockNotificationBotOnboarding(
        tx as unknown as Database,
        access.scope.storeId,
      );

      if (!(await recheckMerchantAccess(tx, access))) {
        return { ok: false, error: "DENIED" } as const;
      }

      await deleteMerchantNotificationBot(
        tx as unknown as Database,
        access.scope.storeId,
      );

      await cancelActiveNotificationBotManagedAttempts(
        tx as unknown as Database,
        { storeId: access.scope.storeId },
      );

      return { ok: true } as const;
    });

    return outcome;
  } catch (error) {
    logFailure("disconnect_write", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}
