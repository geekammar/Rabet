/**
 * Client-safe settings types and constants.
 *
 * Separated from `src/lib/data` to ensure `server-only` modules never reach
 * client bundles.
 */

export const CURRENCIES = ["SAR", "USD", "AED", "EGP"] as const;

export type Currency = (typeof CURRENCIES)[number];

export type LanguageRow = {
  id: string;
  code: string;
  label: string;
  textDirection: string;
  isEnabled: boolean;
  createdAt: Date;
};

export type ResolvedLanguage = {
  id: string;
  code: string;
  label: string;
  textDirection: "ltr" | "rtl";
};

export type BotSettings = {
  id: number;
  defaultLanguageId: string;
  currency: string;
  displayName: string;
  askForLanguage: boolean;
  supportCategory: string[];
  supportReplyTime: string | null;
  createdAt: Date;
  updatedAt: Date;
};
