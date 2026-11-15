"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  RabetDataError,
  resetStorefrontMenuConfig,
  saveStorefrontMenuConfig,
  toSafeErrorMessage,
} from "@/lib/data";
import {
  storefrontMenuConfigSchema,
  type StorefrontMenuConfig,
} from "@/lib/storefront/menu";

export type StorefrontMenuActionResult = {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
  config?: StorefrontMenuConfig;
};

function revalidateStorefrontSurfaces(): void {
  revalidatePath("/storefront");
  revalidatePath("/overview");
}

/**
 * Saves the merchant's ordered storefront menu choices.
 *
 * The admin session is checked before database access. The complete
 * configuration is validated before the single settings row is updated, so a
 * partial or all-disabled menu can never be persisted.
 */
export async function saveStorefrontMenuAction(
  input: unknown,
): Promise<StorefrontMenuActionResult> {
  await requireAdmin();

  const parsed = storefrontMenuConfigSchema.safeParse(input);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      errors[issue.path.join(".") || "menu"] =
        issue.message || "The menu configuration is not valid.";
    }

    return {
      success: false,
      code: "INVALID_INPUT",
      message: parsed.error.issues[0]?.message ?? "The menu configuration is not valid.",
      errors,
    };
  }

  try {
    const config = await saveStorefrontMenuConfig(getDb(), parsed.data);
    revalidateStorefrontSurfaces();

    return {
      success: true,
      message: "Storefront menu saved.",
      config,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }

    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Restores the Phase 28 default menu. The stored customization is cleared
 * rather than replaced with a copy of the current defaults.
 */
export async function resetStorefrontMenuAction(): Promise<StorefrontMenuActionResult> {
  await requireAdmin();

  try {
    const config = await resetStorefrontMenuConfig(getDb());
    revalidateStorefrontSurfaces();

    return {
      success: true,
      message: "Storefront menu reset to defaults.",
      config,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }

    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: toSafeErrorMessage(error),
    };
  }
}
