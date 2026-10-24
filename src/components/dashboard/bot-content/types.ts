import type { BotSettings, LanguageRow, ResolvedLanguage } from "@/lib/data";
import type { TemplateKey } from "@/lib/bot-content";

export type SavedTranslation = {
  body: string;
  updatedAt: Date;
};

export type TemplateData = {
  key: TemplateKey;
  translations: Record<string, SavedTranslation>; // keyed by languageCode, e.g. "en", "ar"
};

export interface BotContentEditorProps {
  settings: BotSettings;
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  templatesData: TemplateData[];
}
