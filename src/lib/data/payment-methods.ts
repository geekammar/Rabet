import "server-only";

import { eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  language,
  paymentMethod,
  paymentMethodTranslation,
} from "@/db/schema";
import { executeAtomicBatch } from "./catalog";
import { mapDatabaseError, RabetDataError } from "./errors";
import { resolveDefaultLanguage } from "./languages";

/**
 * ===========================================================================
 * Server-only payment method data access functions.
 * ===========================================================================
 *
 * Provides operations to create, edit, disable, list, and preview central
 * payment methods and their localized customer-facing titles and instructions.
 *
 * Security & Compliance boundary:
 * Does NOT store provider credentials, bank/card secrets, or real payment data.
 * Methods default to disabled (isActive = false).
 */

export interface PaymentMethodTranslationRecord {
  id: string;
  languageId: string;
  languageCode: string;
  title: string;
  instructions: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentMethodRecord {
  id: string;
  adminLabel: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  translations: Record<string, PaymentMethodTranslationRecord>;
}

export interface CreatePaymentMethodData {
  adminLabel: string;
  isActive?: boolean;
  translations: Array<{
    languageId: string;
    languageCode: string;
    title: string;
    instructions?: string | null;
  }>;
}

export interface EditPaymentMethodData {
  id: string;
  adminLabel?: string;
  isActive?: boolean;
  translation?: {
    languageId: string;
    languageCode: string;
    title: string;
    instructions?: string | null;
  };
}

/**
 * Lists all central payment methods ordered by sortOrder ASC, createdAt ASC.
 */
export async function listPaymentMethods(
  db: Database,
): Promise<PaymentMethodRecord[]> {
  try {
    const methodRows = await db
      .select()
      .from(paymentMethod)
      .orderBy(paymentMethod.sortOrder, paymentMethod.createdAt);

    if (methodRows.length === 0) {
      return [];
    }

    const methodIds = methodRows.map((m) => m.id);

    const transRows = await db
      .select({
        id: paymentMethodTranslation.id,
        paymentMethodId: paymentMethodTranslation.paymentMethodId,
        languageId: paymentMethodTranslation.languageId,
        languageCode: language.code,
        title: paymentMethodTranslation.title,
        instructions: paymentMethodTranslation.instructions,
        createdAt: paymentMethodTranslation.createdAt,
        updatedAt: paymentMethodTranslation.updatedAt,
      })
      .from(paymentMethodTranslation)
      .innerJoin(language, eq(paymentMethodTranslation.languageId, language.id))
      .where(
        sql`${paymentMethodTranslation.paymentMethodId} IN (${sql.join(
          methodIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const translationsByMethod = new Map<
      string,
      Record<string, PaymentMethodTranslationRecord>
    >();

    for (const row of transRows) {
      const list = translationsByMethod.get(row.paymentMethodId) ?? {};
      list[row.languageCode] = {
        id: row.id,
        languageId: row.languageId,
        languageCode: row.languageCode,
        title: row.title,
        instructions: row.instructions,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      translationsByMethod.set(row.paymentMethodId, list);
    }

    return methodRows.map((row) => ({
      ...row,
      translations: translationsByMethod.get(row.id) ?? {},
    }));
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    throw mapDatabaseError(error);
  }
}

/**
 * Reads a single payment method by ID with all translations.
 */
export async function readPaymentMethod(
  db: Database,
  id: string,
): Promise<PaymentMethodRecord | null> {
  try {
    const [row] = await db
      .select()
      .from(paymentMethod)
      .where(eq(paymentMethod.id, id))
      .limit(1);

    if (!row) return null;

    const transRows = await db
      .select({
        id: paymentMethodTranslation.id,
        paymentMethodId: paymentMethodTranslation.paymentMethodId,
        languageId: paymentMethodTranslation.languageId,
        languageCode: language.code,
        title: paymentMethodTranslation.title,
        instructions: paymentMethodTranslation.instructions,
        createdAt: paymentMethodTranslation.createdAt,
        updatedAt: paymentMethodTranslation.updatedAt,
      })
      .from(paymentMethodTranslation)
      .innerJoin(language, eq(paymentMethodTranslation.languageId, language.id))
      .where(eq(paymentMethodTranslation.paymentMethodId, id));

    const translations: Record<string, PaymentMethodTranslationRecord> = {};
    for (const t of transRows) {
      translations[t.languageCode] = {
        id: t.id,
        languageId: t.languageId,
        languageCode: t.languageCode,
        title: t.title,
        instructions: t.instructions,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    }

    return {
      ...row,
      translations,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    throw mapDatabaseError(error);
  }
}

/**
 * Creates a central payment method with its required initial translations atomically.
 * Defaults to disabled (`isActive = false`).
 */
export async function createPaymentMethod(
  db: Database,
  input: CreatePaymentMethodData,
): Promise<{ methodId: string; method: PaymentMethodRecord }> {
  try {
    const adminLabel = input.adminLabel.trim();
    if (adminLabel.length === 0) {
      throw new RabetDataError("INVALID_INPUT", "Admin label is required.");
    }

    const defaultLang = await resolveDefaultLanguage(db);
    const defaultCode = defaultLang?.code ?? "en";
    const defaultTrans = input.translations.find(
      (t) => t.languageCode === defaultCode || t.languageId === defaultLang?.id,
    );

    if (!defaultTrans || defaultTrans.title.trim().length === 0) {
      throw new RabetDataError(
        "INVALID_INPUT",
        `A customer-facing title in the store's default language (${defaultCode.toUpperCase()}) is required.`,
      );
    }

    // Default to disabled (ADR compliance)
    const isActive = input.isActive ?? false;

    // Deterministic next sort order
    const [maxOrderRow] = await db
      .select({ maxOrder: sql<number | null>`max(${paymentMethod.sortOrder})` })
      .from(paymentMethod);
    const nextSortOrder = (maxOrderRow?.maxOrder ?? -1) + 1;

    const methodId = globalThis.crypto.randomUUID();

    const methodInsert = db.insert(paymentMethod).values({
      id: methodId,
      adminLabel,
      isActive,
      sortOrder: nextSortOrder,
    });

    const translationInserts = input.translations.map((t) =>
      db.insert(paymentMethodTranslation).values({
        id: globalThis.crypto.randomUUID(),
        paymentMethodId: methodId,
        languageId: t.languageId,
        title: t.title.trim(),
        instructions: t.instructions?.trim() || null,
      }),
    );

    await executeAtomicBatch(db, [methodInsert, ...translationInserts]);

    const created = await readPaymentMethod(db, methodId);
    if (!created) {
      throw new RabetDataError("UNCATEGORIZED", "Failed to read payment method after creation.");
    }

    return { methodId, method: created };
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    throw mapDatabaseError(error);
  }
}

/**
 * Updates a central payment method and optionally a submitted translation atomically.
 */
export async function editPaymentMethod(
  db: Database,
  input: EditPaymentMethodData,
): Promise<{ method: PaymentMethodRecord }> {
  try {
    const existing = await readPaymentMethod(db, input.id);
    if (!existing) {
      throw new RabetDataError("NOT_FOUND", "Payment method not found.");
    }

    const queries: unknown[] = [];

    const updateSet: Record<string, unknown> = {
      updatedAt: sql`now()`,
    };

    if (input.adminLabel !== undefined) {
      const trimmed = input.adminLabel.trim();
      if (trimmed.length === 0) {
        throw new RabetDataError("INVALID_INPUT", "Admin label cannot be empty.");
      }
      updateSet.adminLabel = trimmed;
    }

    if (input.isActive !== undefined) {
      // If enabling, ensure default language title exists
      if (input.isActive && !existing.isActive) {
        const defaultLang = await resolveDefaultLanguage(db);
        const defaultCode = defaultLang?.code ?? "en";
        const willHaveDefaultTitle =
          input.translation && input.translation.languageCode === defaultCode
            ? input.translation.title.trim().length > 0
            : Boolean(existing.translations[defaultCode]?.title?.trim());

        if (!willHaveDefaultTitle) {
          throw new RabetDataError(
            "INVALID_INPUT",
            `A customer-facing title in the store's default language (${defaultCode.toUpperCase()}) is required before activating.`,
          );
        }
      }
      updateSet.isActive = input.isActive;
    }

    queries.push(
      db.update(paymentMethod).set(updateSet).where(eq(paymentMethod.id, input.id)),
    );

    if (input.translation) {
      const trimmedTitle = input.translation.title.trim();
      if (trimmedTitle.length === 0) {
        throw new RabetDataError("INVALID_INPUT", "Customer-facing title cannot be empty.");
      }
      const trimmedInstructions = input.translation.instructions?.trim() || null;

      const translationUpsert = db
        .insert(paymentMethodTranslation)
        .values({
          id: globalThis.crypto.randomUUID(),
          paymentMethodId: input.id,
          languageId: input.translation.languageId,
          title: trimmedTitle,
          instructions: trimmedInstructions,
        })
        .onConflictDoUpdate({
          target: [
            paymentMethodTranslation.paymentMethodId,
            paymentMethodTranslation.languageId,
          ],
          set: {
            title: trimmedTitle,
            instructions: trimmedInstructions,
            updatedAt: sql`now()`,
          },
        });

      queries.push(translationUpsert);
    }

    await executeAtomicBatch(db, queries);

    const updated = await readPaymentMethod(db, input.id);
    if (!updated) {
      throw new RabetDataError("UNCATEGORIZED", "Failed to read payment method after update.");
    }

    return { method: updated };
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    throw mapDatabaseError(error);
  }
}

/**
 * Toggles a payment method's active/disabled state.
 */
export async function togglePaymentMethodActive(
  db: Database,
  id: string,
  isActive: boolean,
): Promise<{ method: PaymentMethodRecord }> {
  return editPaymentMethod(db, { id, isActive });
}
