import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  language,
  paymentMethod,
  paymentMethodTranslation,
  productAction,
  productActionTranslation,
  productTranslation,
} from "@/db/schema";
import {
  isActionHierarchyActive,
  isProductHierarchyActive,
} from "@/lib/catalog/eligibility";
import { checkPaymentMethodsCapability } from "@/lib/data/payment-methods";
import {
  resolvePaymentMethodContent,
  type ResolvedPaymentMethodContent,
} from "./presentation";

/**
 * Channel-independent shared resolver for the manual-payment prototype.
 *
 * It answers two questions from live database state:
 *   1. Which configured PAYMENT_METHOD actions are eligible for this product?
 *   2. What localized instructions does one selected action/method resolve to?
 *
 * It deliberately has no Telegram (or other channel) imports: callbacks,
 * keyboards and transport limits belong to the channel adapter. It also never
 * trusts a method id supplied by a caller — the action relationship is always
 * re-read from the product-action tree.
 */

export interface PaymentLanguageSelection {
  requestedLanguageId: string;
  defaultLanguageId: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  price: string;
  categoryId: string;
}

export interface EligiblePaymentMethodOption {
  actionId: string;
  methodId: string;
  label: string;
  title: string;
  instructions: string | null;
  languageId: string;
  languageCode: string;
  usedFallback: boolean;
  sortOrder: number;
}

export type PaymentMethodUnavailableReason =
  | "product_unavailable"
  | "action_unavailable"
  | "method_unavailable"
  | "content_unavailable";

export type EligiblePaymentMethodsResult =
  | {
      status: "ok";
      product: ProductSummary;
      methods: EligiblePaymentMethodOption[];
    }
  | {
      status: "unavailable";
      reason: PaymentMethodUnavailableReason;
      product: null;
      methods: [];
    };

export interface ResolvedPaymentMethodJourney {
  actionId: string;
  methodId: string;
  actionLabel: string;
  title: string;
  instructions: string | null;
  languageId: string;
  languageCode: string;
  usedFallback: boolean;
  product: ProductSummary;
  actionParentId: string | null;
  ancestorLabels: string[];
  selectionSuffix: string[];
  selectedOptions: string[];
}

export type ResolvePaymentMethodResult =
  | { status: "ok"; method: ResolvedPaymentMethodJourney }
  | { status: "unavailable"; reason: PaymentMethodUnavailableReason };

type ActionTranslationRow = {
  actionId: string;
  languageId: string;
  languageCode: string;
  label: string;
};

function resolveLabel(
  rows: ActionTranslationRow[],
  languageSelection: PaymentLanguageSelection,
): string | null {
  const requested = rows.find(
    (row) =>
      row.languageId === languageSelection.requestedLanguageId &&
      row.label.trim().length > 0,
  );
  if (requested) return requested.label.trim();

  const fallback = rows.find(
    (row) =>
      row.languageId === languageSelection.defaultLanguageId &&
      row.label.trim().length > 0,
  );
  return fallback?.label.trim() ?? null;
}

async function loadActionLabels(
  db: Database,
  actionIds: string[],
): Promise<Map<string, ActionTranslationRow[]>> {
  const result = new Map<string, ActionTranslationRow[]>();
  if (actionIds.length === 0) return result;

  const rows = await db
    .select({
      actionId: productActionTranslation.actionId,
      languageId: productActionTranslation.languageId,
      languageCode: language.code,
      label: productActionTranslation.label,
    })
    .from(productActionTranslation)
    .innerJoin(language, eq(productActionTranslation.languageId, language.id))
    .where(inArray(productActionTranslation.actionId, actionIds));

  for (const row of rows) {
    const list = result.get(row.actionId) ?? [];
    list.push(row);
    result.set(row.actionId, list);
  }

  return result;
}

async function resolveProductSummary(
  db: Database,
  product: { id: string; slug: string; price: string; categoryId: string },
  languageSelection: PaymentLanguageSelection,
): Promise<ProductSummary> {
  const rows = await db
    .select({
      languageId: productTranslation.languageId,
      name: productTranslation.name,
    })
    .from(productTranslation)
    .where(eq(productTranslation.productId, product.id));

  const requested = rows.find(
    (row) =>
      row.languageId === languageSelection.requestedLanguageId &&
      row.name.trim().length > 0,
  );
  const fallback = rows.find(
    (row) =>
      row.languageId === languageSelection.defaultLanguageId &&
      row.name.trim().length > 0,
  );

  return {
    id: product.id,
    name: requested?.name.trim() ?? fallback?.name.trim() ?? product.slug,
    price: product.price,
    categoryId: product.categoryId,
  };
}

async function loadMethodContent(
  db: Database,
  methodIds: string[],
  languageSelection: PaymentLanguageSelection,
): Promise<
  Map<
    string,
    {
      methodId: string;
      content: ResolvedPaymentMethodContent;
    }
  >
> {
  const result = new Map<
    string,
    { methodId: string; content: ResolvedPaymentMethodContent }
  >();
  if (methodIds.length === 0) return result;

  const activeMethods = await db
    .select({ id: paymentMethod.id })
    .from(paymentMethod)
    .where(
      and(
        inArray(paymentMethod.id, methodIds),
        eq(paymentMethod.isActive, true),
      ),
    );

  if (activeMethods.length === 0) return result;

  const activeIds = activeMethods.map((method) => method.id);

  const translationRows = await db
    .select({
      paymentMethodId: paymentMethodTranslation.paymentMethodId,
      languageId: paymentMethodTranslation.languageId,
      languageCode: language.code,
      title: paymentMethodTranslation.title,
      instructions: paymentMethodTranslation.instructions,
    })
    .from(paymentMethodTranslation)
    .innerJoin(language, eq(paymentMethodTranslation.languageId, language.id))
    .where(inArray(paymentMethodTranslation.paymentMethodId, activeIds));

  const byMethod = new Map<
    string,
    Array<{
      languageId: string;
      languageCode: string;
      title: string;
      instructions: string | null;
    }>
  >();

  for (const row of translationRows) {
    const list = byMethod.get(row.paymentMethodId) ?? [];
    list.push({
      languageId: row.languageId,
      languageCode: row.languageCode,
      title: row.title,
      instructions: row.instructions,
    });
    byMethod.set(row.paymentMethodId, list);
  }

  for (const method of activeMethods) {
    const content = resolvePaymentMethodContent(
      byMethod.get(method.id) ?? [],
      languageSelection.requestedLanguageId,
      languageSelection.defaultLanguageId,
    );
    if (content) {
      result.set(method.id, { methodId: method.id, content });
    }
  }

  return result;
}

function selectedOptionPath(
  ancestorLabels: string[],
  actionLabel: string,
  methodTitle: string,
): string[] {
  const path = [...ancestorLabels];
  if (actionLabel !== methodTitle) path.push(actionLabel);
  if (path[path.length - 1] !== methodTitle) path.push(methodTitle);
  return path;
}

/**
 * Lists eligible configured PAYMENT_METHOD actions directly under a product
 * (root) or under one of its OPEN_SUBMENU actions, in stable configured order.
 *
 * A method is eligible only when the product/category hierarchy, the parent
 * action path, the action itself, the central method, and customer-facing
 * method content all currently resolve.
 */
export async function listEligiblePaymentMethodsForProduct(
  db: Database,
  input: PaymentLanguageSelection & {
    productId: string;
    parentActionId?: string | null;
  },
): Promise<EligiblePaymentMethodsResult> {
  const capability = await checkPaymentMethodsCapability(db);
  if (!capability.supported) {
    return {
      status: "unavailable",
      reason: "method_unavailable",
      product: null,
      methods: [],
    };
  }

  const productCheck = await isProductHierarchyActive(db, input.productId);
  if (!productCheck.valid || !productCheck.productRow) {
    return {
      status: "unavailable",
      reason: "product_unavailable",
      product: null,
      methods: [],
    };
  }

  const parentActionId = input.parentActionId ?? null;

  if (parentActionId) {
    const parentCheck = await isActionHierarchyActive(db, parentActionId);
    if (
      !parentCheck.valid ||
      !parentCheck.actionRow ||
      parentCheck.actionRow.productId !== input.productId ||
      parentCheck.actionRow.actionType !== "OPEN_SUBMENU"
    ) {
      return {
        status: "unavailable",
        reason: "action_unavailable",
        product: null,
        methods: [],
      };
    }
  }

  const actions = await db
    .select({
      id: productAction.id,
      paymentMethodId: productAction.paymentMethodId,
      sortOrder: productAction.sortOrder,
    })
    .from(productAction)
    .where(
      and(
        eq(productAction.productId, input.productId),
        eq(productAction.actionType, "PAYMENT_METHOD"),
        eq(productAction.isActive, true),
        parentActionId
          ? eq(productAction.parentActionId, parentActionId)
          : isNull(productAction.parentActionId),
      ),
    )
    .orderBy(asc(productAction.sortOrder), asc(productAction.id));

  const product = await resolveProductSummary(
    db,
    productCheck.productRow,
    input,
  );

  if (actions.length === 0) {
    return { status: "ok", product, methods: [] };
  }

  const methodIds = Array.from(
    new Set(
      actions
        .map((action) => action.paymentMethodId)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const [methodContent, actionLabels] = await Promise.all([
    loadMethodContent(db, methodIds, input),
    loadActionLabels(
      db,
      actions.map((action) => action.id),
    ),
  ]);

  const methods: EligiblePaymentMethodOption[] = [];

  for (const action of actions) {
    if (!action.paymentMethodId) continue;

    const method = methodContent.get(action.paymentMethodId);
    if (!method) continue;

    const label =
      resolveLabel(actionLabels.get(action.id) ?? [], input) ??
      method.content.title;

    methods.push({
      actionId: action.id,
      methodId: method.methodId,
      label,
      title: method.content.title,
      instructions: method.content.instructions,
      languageId: method.content.languageId,
      languageCode: method.content.languageCode,
      usedFallback: method.content.usedFallback,
      sortOrder: action.sortOrder,
    });
  }

  return { status: "ok", product, methods };
}

/**
 * Resolves one selected PAYMENT_METHOD action for a product and returns fresh,
 * localized instructions plus the frozen path context used by an explicit
 * seller-contact action.
 *
 * The product id is required and checked against the action's own product id,
 * so a callback reference borrowed from a different product is rejected.
 */
export async function resolvePaymentMethodForAction(
  db: Database,
  input: PaymentLanguageSelection & {
    productId: string;
    actionId: string;
  },
): Promise<ResolvePaymentMethodResult> {
  const capability = await checkPaymentMethodsCapability(db);
  if (!capability.supported) {
    return { status: "unavailable", reason: "method_unavailable" };
  }

  const actionCheck = await isActionHierarchyActive(db, input.actionId);

  if (
    !actionCheck.valid ||
    !actionCheck.actionRow ||
    !actionCheck.productRow ||
    actionCheck.actionRow.productId !== input.productId
  ) {
    return { status: "unavailable", reason: "action_unavailable" };
  }

  const action = actionCheck.actionRow;
  if (action.actionType !== "PAYMENT_METHOD") {
    return { status: "unavailable", reason: "action_unavailable" };
  }

  const [actionReference] = await db
    .select({ paymentMethodId: productAction.paymentMethodId })
    .from(productAction)
    .where(eq(productAction.id, action.id))
    .limit(1);

  if (!actionReference?.paymentMethodId) {
    return { status: "unavailable", reason: "action_unavailable" };
  }

  const [method] = await db
    .select({ id: paymentMethod.id, isActive: paymentMethod.isActive })
    .from(paymentMethod)
    .where(eq(paymentMethod.id, actionReference.paymentMethodId))
    .limit(1);

  if (!method || !method.isActive) {
    return { status: "unavailable", reason: "method_unavailable" };
  }

  const contentMap = await loadMethodContent(db, [method.id], input);
  const resolved = contentMap.get(method.id);
  if (!resolved) {
    return { status: "unavailable", reason: "content_unavailable" };
  }

  const ancestors = actionCheck.ancestors ?? [];
  const actionLabels = await loadActionLabels(db, [
    ...ancestors.map((ancestor) => ancestor.id),
    action.id,
  ]);

  const ancestorLabels = ancestors.map(
    (ancestor) =>
      resolveLabel(actionLabels.get(ancestor.id) ?? [], input) ?? "Option",
  );

  const actionLabel =
    resolveLabel(actionLabels.get(action.id) ?? [], input) ??
    resolved.content.title;

  const product = await resolveProductSummary(
    db,
    actionCheck.productRow,
    input,
  );

  return {
    status: "ok",
    method: {
      actionId: action.id,
      methodId: method.id,
      actionLabel,
      title: resolved.content.title,
      instructions: resolved.content.instructions,
      languageId: resolved.content.languageId,
      languageCode: resolved.content.languageCode,
      usedFallback: resolved.content.usedFallback,
      product,
      actionParentId: action.parentActionId,
      ancestorLabels,
      selectionSuffix: selectedOptionPath([], actionLabel, resolved.content.title),
      selectedOptions: selectedOptionPath(
        ancestorLabels,
        actionLabel,
        resolved.content.title,
      ),
    },
  };
}
