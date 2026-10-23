"use client";

import { useActionState, useRef } from "react";
import { AlertCircle, CheckCircle2, Loader2, Save } from "lucide-react";

import {
  updateStoreSettings,
  type SettingsActionResult,
} from "@/app/actions/settings";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BotSettings, Currency, LanguageRow, ResolvedLanguage } from "./types";
import { CurrencyPicker } from "./currency-picker";
import { LanguageSettingsCard } from "./language-settings-card";
import { SupportCategoryManager } from "./support-category-manager";

export function SettingsEditForm({
  settings,
  languages,
  defaultLanguage,
  hasCatalogPrices,
}: {
  settings: BotSettings;
  languages: LanguageRow[];
  defaultLanguage: ResolvedLanguage | null;
  hasCatalogPrices: boolean;
}) {
  const [state, formAction, isPending] = useActionState<
    SettingsActionResult,
    FormData
  >(updateStoreSettings, { success: false });

  const formRef = useRef<HTMLFormElement>(null);

  // Enabled languages for the default language dropdown
  const enabledLanguages = languages.filter((l) => l.isEnabled);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Store identity, currency, customer languages and support configuration."
      />

      {/* Main Settings Form */}
      <form ref={formRef} action={formAction} className="space-y-6" noValidate>
        {state.message && (
          <div
            role="alert"
            className={`flex items-start gap-3 rounded-xl border p-4 text-sm font-medium ${
              state.success
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-destructive/20 bg-destructive/10 text-destructive"
            }`}
          >
            {state.success ? (
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
            ) : (
              <AlertCircle className="size-5 shrink-0 text-destructive" />
            )}
            <div>
              <p>{state.message}</p>
            </div>
          </div>
        )}

        {/* Store Profile Card */}
        <Card>
          <CardHeader>
            <CardTitle>Store Identity & Currency</CardTitle>
            <CardDescription>
              Basic merchant profile and default transaction currency.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Display Name */}
            <div className="space-y-2">
              <label
                htmlFor="store-display-name"
                className="text-sm font-medium text-foreground"
              >
                Store Display Name <span className="text-destructive">*</span>
              </label>
              <input
                id="store-display-name"
                name="displayName"
                type="text"
                required
                maxLength={60}
                defaultValue={settings.displayName}
                placeholder="e.g. Acme Digital Goods"
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <p className="text-xs text-muted-foreground">
                Displayed in the Telegram bot welcome message and main greeting (up to 60 characters).
              </p>
            </div>

            {/* Currency Picker with Safeguards */}
            <CurrencyPicker
              initialCurrency={settings.currency as Currency}
              hasCatalogPrices={hasCatalogPrices}
              isEditMode={true}
            />

            {/* Default Language Selector */}
            <div className="space-y-2">
              <label
                htmlFor="default-language-select"
                className="text-sm font-medium text-foreground"
              >
                Default Bot Language <span className="text-destructive">*</span>
              </label>
              <select
                id="default-language-select"
                name="defaultLanguageCode"
                defaultValue={defaultLanguage?.code ?? "en"}
                required
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {enabledLanguages.map((lang) => (
                  <option key={lang.id} value={lang.code}>
                    {lang.label} ({lang.code}) — {lang.textDirection.toUpperCase()}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Must be an enabled language. Serves as the fallback for all bot copy.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Support & Customer Preferences Card */}
        <Card>
          <CardHeader>
            <CardTitle>Customer Experience & Support</CardTitle>
            <CardDescription>
              Configure language prompt on launch and support inquiry categories.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Ask for Language */}
            <div className="flex items-start gap-3 rounded-xl border p-4 bg-muted/20">
              <input
                id="ask-for-language"
                name="askForLanguage"
                type="checkbox"
                defaultChecked={settings.askForLanguage}
                value="true"
                className="size-5 mt-0.5 rounded border-input accent-primary"
              />
              <div className="space-y-1">
                <label
                  htmlFor="ask-for-language"
                  className="text-sm font-medium text-foreground cursor-pointer"
                >
                  Ask customer to choose language on bot launch
                </label>
                <p className="text-xs text-muted-foreground">
                  When enabled, customers will be asked to choose their language
                  upon starting the bot.
                </p>
              </div>
            </div>

            {/* Support Categories */}
            <SupportCategoryManager
              initialCategories={settings.supportCategory ?? []}
            />

            {/* Support Reply Time */}
            <div className="space-y-2">
              <label
                htmlFor="support-reply-time"
                className="text-sm font-medium text-foreground"
              >
                Support Reply Time Description (Optional)
              </label>
              <input
                id="support-reply-time"
                name="supportReplyTime"
                type="text"
                maxLength={120}
                defaultValue={settings.supportReplyTime ?? ""}
                placeholder="e.g. Typically replies within 24 hours"
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <p className="text-xs text-muted-foreground">
                Shown to customers when they submit a support inquiry.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Submit Button */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button
            type="submit"
            disabled={isPending}
            className="min-h-11 w-full sm:w-auto px-6 font-medium gap-2 text-base"
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>Saving Changes...</span>
              </>
            ) : (
              <>
                <Save className="size-4" />
                <span>Save Settings</span>
              </>
            )}
          </Button>
        </div>
      </form>

      {/* Language Management Card (Toggles Arabic, shows fallback info) */}
      <LanguageSettingsCard
        languages={languages}
        defaultLanguage={defaultLanguage}
      />
    </div>
  );
}
