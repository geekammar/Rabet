"use client";

import { useActionState, useRef } from "react";
import { AlertCircle, CheckCircle2, Loader2, Sparkles } from "lucide-react";

import {
  initializeStoreSettings,
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
import { CurrencyPicker } from "./currency-picker";
import { SupportCategoryManager } from "./support-category-manager";

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState<
    SettingsActionResult,
    FormData
  >(initializeStoreSettings, { success: false });

  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings & Onboarding"
        description="First-time setup for your Rabet store and Telegram bot."
      />

      {/* Welcoming Card */}
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="gap-2">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </div>
          <CardTitle className="text-xl">Welcome to Rabet</CardTitle>
          <CardDescription className="text-sm">
            Set up your store identity, currency and languages. No business data
            is seeded until you explicitly save your configuration below.
          </CardDescription>
        </CardHeader>
      </Card>

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

        {/* Section 1: Required Settings */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Required Store Settings</CardTitle>
              <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                Required
              </span>
            </div>
            <CardDescription>
              Essential configuration needed before your bot can greet customers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* 1. Store Display Name */}
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
                placeholder="e.g. Acme Digital Goods"
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <p className="text-xs text-muted-foreground">
                Displayed in the Telegram bot welcome message and main greeting (up to 60 characters).
              </p>
            </div>

            {/* 2. Display Currency (Preselect USD, allow SAR, AED, EGP) */}
            <CurrencyPicker initialCurrency="USD" isEditMode={false} />

            {/* 3. Default Bot Language */}
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
                defaultValue="en"
                required
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="en">English (en) — Left to Right</option>
                <option value="ar">العربية (ar) — Right to Left</option>
              </select>
              <p className="text-xs text-muted-foreground">
                English is initially selected. Missing requested translations fall back to the configured default language. If neither translation exists, the result is explicitly missing.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Optional Settings */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Customer Experience & Support</CardTitle>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Optional
              </span>
            </div>
            <CardDescription>
              Fine-tune customer interaction and support categories.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* 4. Ask for language */}
            <div className="flex items-start gap-3 rounded-xl border p-4 bg-muted/20">
              <input type="hidden" name="askForLanguage" value="false" />
              <input
                id="ask-for-language"
                name="askForLanguage"
                type="checkbox"
                defaultChecked={true}
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
                  When enabled, new customers are prompted to select English or Arabic
                  before the main menu is presented.
                </p>
              </div>
            </div>

            {/* 5. Support Categories */}
            <SupportCategoryManager initialCategories={[]} />

            {/* 6. Support Reply-Time text */}
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
                placeholder="e.g. Typically replies within 24 hours"
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <p className="text-xs text-muted-foreground">
                Shown to customers when they submit an inquiry or support request.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Submission Button */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button
            type="submit"
            disabled={isPending}
            className="min-h-11 w-full sm:w-auto px-6 font-medium gap-2 text-base"
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>Saving Store Settings...</span>
              </>
            ) : (
              <span>Save & Initialize Store</span>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
