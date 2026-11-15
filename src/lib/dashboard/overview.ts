import "server-only";

import { getDb } from "@/db/client";
import {
  checkPaymentMethodsCapability,
  isConfigured,
  listCatalogCategories,
  listCatalogProducts,
  listPaymentMethods,
  readSettings,
  toSafeErrorMessage,
} from "@/lib/data";
import { listSellerInquiries } from "@/lib/data/seller-inbox";

export type OverviewCounts = {
  products: number;
  categories: number;
  activeInquiries: number;
  paymentMethods: number;
  paymentMethodsAvailable: boolean;
};

export type OverviewData =
  | { kind: "database_setup_required" }
  | { kind: "database_unavailable"; message: string }
  | { kind: "store_setup_required" }
  | { kind: "ready"; storeName: string; counts: OverviewCounts };

export async function loadOverviewData(): Promise<OverviewData> {
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

    const [categories, products, paymentMethods, paymentCapability, inquiries] =
      await Promise.all([
        listCatalogCategories(db),
        listCatalogProducts(db),
        listPaymentMethods(db),
        checkPaymentMethodsCapability(db),
        listSellerInquiries(db, {
          status: "active",
          type: "all",
          page: 1,
          pageSize: 1,
        }),
      ]);

    return {
      kind: "ready",
      storeName: settings.displayName,
      counts: {
        products: products.length,
        categories: categories.length,
        activeInquiries: inquiries.totalCount,
        paymentMethods: paymentMethods.length,
        paymentMethodsAvailable: paymentCapability.supported,
      },
    };
  } catch (error) {
    return {
      kind: "database_unavailable",
      message: toSafeErrorMessage(error),
    };
  }
}
