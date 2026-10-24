"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Compass,
  ExternalLink,
  HelpCircle,
  Info,
  Languages,
  Package,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import {
  TEMPLATE_GROUPS,
  TEMPLATE_REGISTRY,
  type TemplateDefinition,
  type TemplateGroup,
} from "@/lib/bot-content";
import type { BotSettings, LanguageRow, ResolvedLanguage } from "@/lib/data";
import { TemplateCard } from "./template-card";
import type { TemplateData } from "./types";

interface BotContentEditorProps {
  settings: BotSettings;
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  templatesData: TemplateData[];
}

const GROUP_METADATA: Record<
  TemplateGroup,
  {
    title: string;
    description: string;
    icon: typeof Sparkles;
  }
> = {
  Welcome: {
    title: "Welcome Messages",
    description: "Initial greetings sent when customers first interact with your bot.",
    icon: Sparkles,
  },
  Support: {
    title: "Support & Conversation",
    description: "Automated replies for customer support inquiries and resolution.",
    icon: HelpCircle,
  },
  Inquiries: {
    title: "Product Inquiries",
    description: "Inquiry acknowledgment messages referencing customer product selections.",
    icon: Package,
  },
  Navigation: {
    title: "Navigation & System Notices",
    description: "System notices shown when options are unavailable or menus are empty.",
    icon: Compass,
  },
};

export function BotContentEditor({
  settings,
  defaultLanguage,
  languages,
  templatesData,
}: BotContentEditorProps) {
  // Global language switch: "en" | "ar" (defaults to en)
  const [activeLanguage, setActiveLanguage] = useState<string>("en");

  const arabicRegistered = languages.some((l) => l.code === "ar");
  const arabicLanguageRow = languages.find((l) => l.code === "ar");
  const arabicDisabled = arabicLanguageRow ? !arabicLanguageRow.isEnabled : false;

  const defaultLangLabel = defaultLanguage?.label || "English";

  // Map of initial translations keyed by templateKey
  const translationsMap = useMemo(() => {
    const map = new Map<string, TemplateData["translations"]>();
    for (const td of templatesData) {
      map.set(td.key, td.translations);
    }
    return map;
  }, [templatesData]);

  // Group templates by their designated group
  const groupedTemplates = useMemo(() => {
    const groups: Record<TemplateGroup, TemplateDefinition[]> = {
      Welcome: [],
      Support: [],
      Inquiries: [],
      Navigation: [],
    };

    for (const def of TEMPLATE_REGISTRY) {
      groups[def.group].push(def);
    }

    return groups;
  }, []);

  return (
    <div className="space-y-8 max-w-4xl">
      <PageHeader
        title="Bot Content"
        description="Edit, preview, and save the global messages your Telegram bot sends to customers."
      />

      {/* Global Language Selector & Store Context Banner */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Languages className="size-4 text-primary" />
              <span className="text-sm font-semibold">Editing Language</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Select which language to edit across all message templates. Default store language is{" "}
              <strong>{defaultLangLabel}</strong>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveLanguage("en")}
              className={`min-h-11 px-4 py-2 text-xs font-medium rounded-lg transition-colors ${
                activeLanguage === "en"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              English (en)
            </button>

            {arabicRegistered ? (
              <button
                type="button"
                onClick={() => setActiveLanguage("ar")}
                className={`min-h-11 px-4 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeLanguage === "ar"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                العربية (ar)
                {arabicDisabled && (
                  <span className="ml-1 text-[10px] opacity-75">(disabled)</span>
                )}
              </button>
            ) : null}
          </div>
        </div>

        {/* Informative banners about Arabic state */}
        {!arabicRegistered && (
          <div className="flex items-start gap-2.5 rounded-lg border border-muted bg-muted/40 p-3 text-xs text-muted-foreground">
            <Info className="size-4 shrink-0 text-muted-foreground mt-0.5" />
            <div className="space-y-1">
              <p>
                <strong>Arabic is not registered in this store.</strong> You can
                register and enable Arabic in your store settings.
              </p>
              <Link
                href="/settings"
                className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:opacity-80"
              >
                <span>Go to Store Settings to register Arabic</span>
                <ExternalLink className="size-3" />
              </Link>
            </div>
          </div>
        )}

        {arabicRegistered && arabicDisabled && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">
            <Info className="size-4 shrink-0 mt-0.5" />
            <p>
              <strong>Arabic is registered but currently disabled.</strong> You can
              prepare and save Arabic translations here now; saving will not enable
              Arabic in the store. Enable it in{" "}
              <Link
                href="/settings"
                className="underline underline-offset-2 font-medium hover:opacity-80"
              >
                Settings
              </Link>{" "}
              whenever you are ready to offer it to customers.
            </p>
          </div>
        )}
      </div>

      {/* Render 4 Groups */}
      {TEMPLATE_GROUPS.map((group) => {
        const meta = GROUP_METADATA[group];
        const templates = groupedTemplates[group];
        const Icon = meta.icon;

        return (
          <div key={group} className="space-y-4">
            <div className="flex items-center gap-2.5 border-b pb-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold tracking-tight">
                  {meta.title}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {meta.description}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              {templates.map((definition) => {
                const initialTranslations =
                  translationsMap.get(definition.key) ?? {};

                return (
                  <TemplateCard
                    key={definition.key}
                    definition={definition}
                    initialTranslations={initialTranslations}
                    settings={settings}
                    defaultLanguage={defaultLanguage}
                    languages={languages}
                    activeLanguageTab={activeLanguage}
                    onLanguageTabChange={setActiveLanguage}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
