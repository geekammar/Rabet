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
import { listLanguages, resolveDefaultLanguage } from "./languages";

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

export interface PaymentMethodsCapability {
  supported: boolean;
  reason?: string;
}

/**
 * Server-side detection of payment methods capability in the database.
 * Does NOT swallow database connection errors.
 * Returns supported = true only when:
 * 1. payment_method table exists
 * 2. product_action.payment_method_id column exists
 * 3. action_type enum has 'PAYMENT_METHOD' value
 */
export async function checkPaymentMethodsCapability(
  db: Database,
): Promise<PaymentMethodsCapability> {
  const result = await db.execute<{
    has_table: boolean;
    has_column: boolean;
    has_enum: boolean;
  }>(sql`
    SELECT
      to_regclass('public.payment_method') IS NOT NULL AS has_table,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_action'
          AND column_name = 'payment_method_id'
      ) AS has_column,
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'action_type'
          AND e.enumlabel = 'PAYMENT_METHOD'
      ) AS has_enum
  `);

  const rawRows: unknown = Array.isArray(result)
    ? result
    : (result as { rows?: unknown[] })?.rows;
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const row = rows[0] as
    | { has_table?: boolean; has_column?: boolean; has_enum?: boolean }
    | undefined;
  if (!row) {
    return { supported: false, reason: "Capability check returned no result." };
  }

  const hasTable = Boolean(row.has_table);
  const hasColumn = Boolean(row.has_column);
  const hasEnum = Boolean(row.has_enum);

  if (hasTable && hasColumn && hasEnum) {
    return { supported: true };
  }

  const missing: string[] = [];
  if (!hasTable) missing.push("payment_method table");
  if (!hasColumn) missing.push("product_action.payment_method_id column");
  if (!hasEnum) missing.push("action_type.PAYMENT_METHOD enum value");

  return {
    supported: false,
    reason: `Database is missing required objects: ${missing.join(", ")}. Pending migration 0002_payment_methods must be applied.`,
  };
}

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
    languageId?: string;
    languageCode: string;
    title: string;
    instructions?: string | null;
  }>;
}

export interface EditPaymentMethodTranslationInput {
  languageId?: string;
  languageCode: string;
  title?: string;
  instructions?: string | null;
}

export interface EditPaymentMethodData {
  id: string;
  adminLabel?: string;
  isActive?: boolean;
  translations?: EditPaymentMethodTranslationInput[];
  translation?: EditPaymentMethodTranslationInput;
}

/**
 * Lists all central payment methods ordered by sortOrder ASC, createdAt ASC.
 * If the database schema does not yet support payment methods, safely returns [].
 */
export async function listPaymentMethods(
  db: Database,
): Promise<PaymentMethodRecord[]> {
  try {
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      return [];
    }

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
 * Returns null if not found or if payment methods are unsupported.
 */
export async function readPaymentMethod(
  db: Database,
  id: string,
): Promise<PaymentMethodRecord | null> {
  try {
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      return null;
    }

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
 * Creates a central payment method with its initial translations atomically.
 * Defaults to disabled (`isActive = false`).
 */
export async function createPaymentMethod(
  db: Database,
  input: CreatePaymentMethodData,
): Promise<{ methodId: string; method: PaymentMethodRecord }> {
  try {
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      throw new RabetDataError(
        "SCHEMA_UPGRADE_REQUIRED",
        capability.reason ?? "Payment methods feature requires pending migration 0002_payment_methods.",
      );
    }

    const adminLabel = input.adminLabel.trim();
    if (adminLabel.length === 0) {
      throw new RabetDataError("INVALID_INPUT", "Admin label is required.");
    }

    const languages = await listLanguages(db);
    const langByCode = new Map(languages.map((l) => [l.code.toLowerCase(), l]));

    const defaultLang = await resolveDefaultLanguage(db);
    const defaultCode = (defaultLang?.code ?? "en").toLowerCase();

    // Filter and validate translations
    const validTranslations: Array<{
      languageId: string;
      languageCode: string;
      title: string;
      instructions: string | null;
    }> = [];

    for (const t of input.translations) {
      const code = t.languageCode.trim().toLowerCase();
      const lang = langByCode.get(code);
      if (!lang) {
        throw new RabetDataError("NOT_FOUND", `Language "${t.languageCode}" is not registered.`);
      }

      const trimmedTitle = t.title.trim();
      const trimmedInstructions = t.instructions !== undefined && t.instructions !== null
        ? t.instructions.trim()
        : null;

      const hasContent = trimmedTitle.length > 0 || (trimmedInstructions !== null && trimmedInstructions.length > 0);
      if (!hasContent) {
        // Skip empty optional translation
        continue;
      }

      if (trimmedTitle.length === 0) {
        throw new RabetDataError(
          "INVALID_INPUT",
          `Customer-facing title is required for language ${code.toUpperCase()}.`,
        );
      }

      validTranslations.push({
        languageId: t.languageId ?? lang.id,
        languageCode: code,
        title: trimmedTitle,
        instructions: trimmedInstructions && trimmedInstructions.length > 0 ? trimmedInstructions : null,
      });
    }

    const defaultTrans = validTranslations.find((t) => t.languageCode === defaultCode);
    if (!defaultTrans || defaultTrans.title.length === 0) {
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

    const translationInserts = validTranslations.map((t) =>
      db.insert(paymentMethodTranslation).values({
        id: globalThis.crypto.randomUUID(),
        paymentMethodId: methodId,
        languageId: t.languageId,
        title: t.title,
        instructions: t.instructions,
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
 * Updates a central payment method and submitted translations atomically.
 * Partial update semantics:
 * - Omitted fields preserve existing values.
 * - Explicit empty instructions ("") or null clears instructions.
 * - Empty string title fails validation with zero writes.
 * - Instructions-only updates work and preserve existing title.
 * - Title-only updates work and preserve existing instructions.
 * - Rejects incomplete new translations clearly.
 * - All translations are validated before any write. A failure in any language aborts the entire save.
 */
export async function editPaymentMethod(
  db: Database,
  input: EditPaymentMethodData,
): Promise<{ method: PaymentMethodRecord }> {
  try {
    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      throw new RabetDataError(
        "SCHEMA_UPGRADE_REQUIRED",
        capability.reason ?? "Payment methods feature requires pending migration 0002_payment_methods.",
      );
    }

    const existing = await readPaymentMethod(db, input.id);
    if (!existing) {
      throw new RabetDataError("NOT_FOUND", "Payment method not found.");
    }

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

    // Normalize submitted translations (supporting both array and single translation object)
    const submittedList: EditPaymentMethodTranslationInput[] = [];
    if (Array.isArray(input.translations)) {
      submittedList.push(...input.translations);
    }
    if (input.translation) {
      submittedList.push(input.translation);
    }

    const languages = await listLanguages(db);
    const langByCode = new Map(languages.map((l) => [l.code.toLowerCase(), l]));

    // Resolved translations to upsert
    const translationsToUpsert: Array<{
      languageId: string;
      languageCode: string;
      title: string;
      instructions: string | null;
    }> = [];

    // Track merged titles by language for activation validation
    const resultingTitles: Record<string, string> = {};
    for (const [code, rec] of Object.entries(existing.translations)) {
      resultingTitles[code.toLowerCase()] = rec.title;
    }

    for (const t of submittedList) {
      const code = t.languageCode.trim().toLowerCase();
      const lang = langByCode.get(code);
      if (!lang) {
        throw new RabetDataError("NOT_FOUND", `Language "${t.languageCode}" is not registered.`);
      }

      const existingTrans = existing.translations[code];

      if (existingTrans) {
        // Updating an existing translation
        let titleToSave = existingTrans.title;
        let instructionsToSave = existingTrans.instructions;

        if (t.title !== undefined) {
          const trimmedTitle = t.title.trim();
          if (trimmedTitle.length === 0) {
            throw new RabetDataError(
              "INVALID_INPUT",
              `Customer-facing title cannot be empty for language ${code.toUpperCase()}.`,
            );
          }
          titleToSave = trimmedTitle;
        }

        if (t.instructions !== undefined) {
          if (t.instructions === null || t.instructions.trim().length === 0) {
            instructionsToSave = null;
          } else {
            instructionsToSave = t.instructions.trim();
          }
        }

        resultingTitles[code] = titleToSave;

        translationsToUpsert.push({
          languageId: t.languageId ?? existingTrans.languageId ?? lang.id,
          languageCode: code,
          title: titleToSave,
          instructions: instructionsToSave,
        });
      } else {
        // New translation for this language
        const isTitleDefined = t.title !== undefined;
        const trimmedTitle = t.title ? t.title.trim() : "";
        const isInstructionsDefined = t.instructions !== undefined && t.instructions !== null;
        const trimmedInstructions = isInstructionsDefined ? t.instructions!.trim() : "";

        const hasAnyContent = trimmedTitle.length > 0 || trimmedInstructions.length > 0;
        if (!hasAnyContent) {
          // Unchanged empty optional tab; skip without error
          continue;
        }

        if (!isTitleDefined || trimmedTitle.length === 0) {
          throw new RabetDataError(
            "INVALID_INPUT",
            `Customer-facing title is required for a new translation in language ${code.toUpperCase()}.`,
          );
        }

        const instructionsToSave = trimmedInstructions.length > 0 ? trimmedInstructions : null;
        resultingTitles[code] = trimmedTitle;

        translationsToUpsert.push({
          languageId: t.languageId ?? lang.id,
          languageCode: code,
          title: trimmedTitle,
          instructions: instructionsToSave,
        });
      }
    }

    if (input.isActive !== undefined) {
      // If active or enabling, ensure default language title exists
      const targetActive = input.isActive;
      if (targetActive) {
        const defaultLang = await resolveDefaultLanguage(db);
        const defaultCode = (defaultLang?.code ?? "en").toLowerCase();
        const hasDefaultTitle = Boolean(resultingTitles[defaultCode]?.trim());

        if (!hasDefaultTitle) {
          throw new RabetDataError(
            "INVALID_INPUT",
            `A customer-facing title in the store's default language (${defaultCode.toUpperCase()}) is required before activating.`,
          );
        }
      }
      updateSet.isActive = input.isActive;
    }

    const queries: unknown[] = [
      db.update(paymentMethod).set(updateSet).where(eq(paymentMethod.id, input.id)),
    ];

    for (const trans of translationsToUpsert) {
      queries.push(
        db
          .insert(paymentMethodTranslation)
          .values({
            id: globalThis.crypto.randomUUID(),
            paymentMethodId: input.id,
            languageId: trans.languageId,
            title: trans.title,
            instructions: trans.instructions,
          })
          .onConflictDoUpdate({
            target: [
              paymentMethodTranslation.paymentMethodId,
              paymentMethodTranslation.languageId,
            ],
            set: {
              title: trans.title,
              instructions: trans.instructions,
              updatedAt: sql`now()`,
            },
          }),
      );
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
