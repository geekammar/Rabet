import type { Metadata } from "next";
import { connection } from "next/server";
import { AlertCircle } from "lucide-react";

import { PaymentMethodsManager } from "@/components/dashboard/payment-methods/payment-methods-manager";
import { CatalogStoreSetupRequired } from "@/components/dashboard/catalog/catalog-store-setup-required";
import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  checkPaymentMethodsCapability,
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
  | { kind: "upgrade_required"; message: string }
  | {
      kind: "ready";
      data: {
        paymentMethods: Awaited<ReturnType<typeof listPaymentMethods>>;
        defaultLanguage: Awaited<ReturnType<typeof resolveDefaultLanguage>>;
        languages: Awaited<ReturnType<typeof listLanguages>>;
      };
    };

function PaymentMethodsUpgradeRequired({ message }: { message: string }) {
  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Payment Methods</h1>
        <p className="text-sm text-muted-foreground">
          Central payment methods, instructions, and customer preview.
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="size-5 text-amber-600 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-amber-900 dark:text-amber-100">
              Database Upgrade Required
            </h2>
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {message}
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-background border p-4 space-y-2 text-xs">
          <p className="font-semibold text-foreground">Operator Action Required:</p>
          <p className="text-muted-foreground">
            Run the approved migration runner workflow to apply pending migrations. Existing catalog features, inquiries, and customer Telegram bot journeys remain fully operational.
          </p>
          <div className="font-mono bg-muted p-2 rounded text-[11px] text-muted-foreground">
            gh workflow run neon-prod-migrate.yml -f mode=migrate -f confirm=MIGRATE_RABET_PROD
          </div>
        </div>
      </div>
    </div>
  );
}

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

    const capability = await checkPaymentMethodsCapability(db);
    if (!capability.supported) {
      return {
        kind: "upgrade_required",
        message:
          capability.reason ??
          "Payment method management is unavailable until the database is upgraded with pending migration 0002_payment_methods.sql.",
      };
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
    case "upgrade_required":
      return <PaymentMethodsUpgradeRequired message={result.message} />;
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
