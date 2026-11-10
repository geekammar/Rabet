import type { Metadata } from "next";
import { connection } from "next/server";

import { PaymentMethodsManager } from "@/components/dashboard/payment-methods/payment-methods-manager";
import { CatalogStoreSetupRequired } from "@/components/dashboard/catalog/catalog-store-setup-required";
import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  isConfigured,
  listLanguages,
  listPaymentMethods,
  readSettings,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";

export const metadata: Metadata = {
  title: "Payment Methods",
  description: "Central payment methods, instructions, and customer preview.",
};

export const instant = false;

type PaymentMethodsViewResult =
  | { kind: "database_setup_required" }
  | { kind: "database_unavailable"; message: string }
  | { kind: "store_setup_required" }
  | {
      kind: "ready";
      data: {
        paymentMethods: Awaited<ReturnType<typeof listPaymentMethods>>;
        defaultLanguage: Awaited<ReturnType<typeof resolveDefaultLanguage>>;
        languages: Awaited<ReturnType<typeof listLanguages>>;
      };
    };

async function loadPaymentMethodsViewData(): Promise<PaymentMethodsViewResult> {
  const rawDbUrl = process.env.DATABASE_URL;
  if (!rawDbUrl || rawDbUrl.trim().length === 0) {
    return { kind: "database_setup_required" };
  }

  try {
    const db = getDb();
    const configured = await isConfigured(db);

    if (!configured) {
      return { kind: "store_setup_required" };
    }

    const settings = await readSettings(db);
    if (!settings) {
      return { kind: "store_setup_required" };
    }

    const [paymentMethods, languages, defaultLanguage] = await Promise.all([
      listPaymentMethods(db),
      listLanguages(db),
      resolveDefaultLanguage(db),
    ]);

    return {
      kind: "ready",
      data: {
        paymentMethods,
        languages,
        defaultLanguage,
      },
    };
  } catch (error) {
    return {
      kind: "database_unavailable",
      message: toSafeErrorMessage(error),
    };
  }
}

export default async function PaymentMethodsPage() {
  await connection();

  // Authoritative boundary check (ADR-010)
  await requireAdmin();

  const result = await loadPaymentMethodsViewData();

  switch (result.kind) {
    case "database_setup_required":
      return (
        <DatabaseSetupRequired
          title="Payment Methods"
          description="Central payment methods, instructions, and customer preview."
        />
      );
    case "database_unavailable":
      return (
        <DatabaseUnavailable
          title="Payment Methods"
          description="Central payment methods, instructions, and customer preview."
          message={result.message}
        />
      );
    case "store_setup_required":
      return <CatalogStoreSetupRequired />;
    case "ready":
      return (
        <PaymentMethodsManager
          initialMethods={result.data.paymentMethods}
          defaultLanguage={result.data.defaultLanguage}
          languages={result.data.languages}
        />
      );
  }
}
