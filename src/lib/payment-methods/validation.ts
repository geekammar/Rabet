import { countCharacters } from "@/lib/product-actions/validation";
import {
  MAX_ADMIN_LABEL_LENGTH,
  MAX_PAYMENT_INSTRUCTIONS_LENGTH,
  MAX_PAYMENT_TITLE_LENGTH,
} from "./constants";

export function validateAdminLabel(raw: unknown): { success: true; data: string } | { success: false; error: string } {
  if (typeof raw !== "string") {
    return { success: false, error: "Admin label must be a string." };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { success: false, error: "Admin label cannot be empty." };
  }
  const count = countCharacters(trimmed);
  if (count > MAX_ADMIN_LABEL_LENGTH) {
    return {
      success: false,
      error: `Admin label cannot exceed ${MAX_ADMIN_LABEL_LENGTH} characters (currently ${count}).`,
    };
  }
  return { success: true, data: trimmed };
}

export function validatePaymentTitle(
  raw: unknown,
  languageLabel = "the required language",
): { success: true; data: string } | { success: false; error: string } {
  if (typeof raw !== "string") {
    return { success: false, error: `Customer title in ${languageLabel} must be a string.` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { success: false, error: `Customer title in ${languageLabel} cannot be empty.` };
  }
  const count = countCharacters(trimmed);
  if (count > MAX_PAYMENT_TITLE_LENGTH) {
    return {
      success: false,
      error: `Customer title in ${languageLabel} cannot exceed ${MAX_PAYMENT_TITLE_LENGTH} characters (currently ${count}).`,
    };
  }
  return { success: true, data: trimmed };
}

export function validatePaymentInstructions(
  raw: unknown,
  languageLabel = "the selected language",
): { success: true; data: string | null } | { success: false; error: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim().length === 0)) {
    return { success: true, data: null };
  }
  if (typeof raw !== "string") {
    return { success: false, error: `Customer instructions in ${languageLabel} must be a string.` };
  }
  const trimmed = raw.trim();
  const count = countCharacters(trimmed);
  if (count > MAX_PAYMENT_INSTRUCTIONS_LENGTH) {
    return {
      success: false,
      error: `Customer instructions in ${languageLabel} cannot exceed ${MAX_PAYMENT_INSTRUCTIONS_LENGTH} characters (currently ${count}).`,
    };
  }
  return { success: true, data: trimmed };
}
