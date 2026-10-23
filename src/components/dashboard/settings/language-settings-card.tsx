"use client";

import { useTransition, useState } from "react";
import { Check, Globe, Info, Loader2 } from "lucide-react";

import { toggleLanguageAction } from "@/app/actions/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { LanguageRow, ResolvedLanguage } from "./types";

export function LanguageSettingsCard({
  languages = [],
  defaultLanguage,
}: {
  languages: LanguageRow[];
  defaultLanguage: ResolvedLanguage | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [actionMessage, setActionMessage] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);

  // Check Arabic presence
  const arLang = languages.find((l) => l.code === "ar");

  const isEnDefault = defaultLanguage?.code === "en";
  const isArDefault = defaultLanguage?.code === "ar";

  function handleToggle(code: string, currentEnabled: boolean) {
    setActionMessage(null);
    startTransition(async () => {
      const res = await toggleLanguageAction(code, !currentEnabled);
      if (!res.success) {
        setActionMessage({
          text: res.message || "Failed to update language.",
          isError: true,
        });
      } else {
        setActionMessage({
          text: res.message || "Language updated successfully.",
          isError: false,
        });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe className="size-5 text-primary" />
          <CardTitle>Languages & Localization</CardTitle>
        </div>
        <CardDescription>
          Configure bot languages. English is initially selected. Missing
          requested translations fall back to the configured default language.
          Arabic renders right-to-left (RTL).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {actionMessage && (
          <div
            role="alert"
            className={`rounded-lg p-3 text-xs font-medium ${
              actionMessage.isError
                ? "bg-destructive/10 text-destructive border border-destructive/20"
                : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
            }`}
          >
            {actionMessage.text}
          </div>
        )}

        <div className="space-y-3">
          {/* English row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-4 bg-muted/20">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">English</span>
                <span className="text-xs text-muted-foreground font-mono">
                  (en)
                </span>
                {isEnDefault && (
                  <Badge variant="default" className="gap-1">
                    <Check className="size-3" />
                    Default
                  </Badge>
                )}
                <Badge variant="outline" className="text-xs">
                  LTR
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Initially selected bot language. When set as default, serves as
                the fallback for missing translations.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled
                className="min-h-11 px-4 text-xs opacity-60"
              >
                Enabled (Required)
              </Button>
            </div>
          </div>

          {/* Arabic row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-4 bg-muted/20">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">العربية</span>
                <span className="text-xs text-muted-foreground font-mono">
                  (ar)
                </span>
                {isArDefault && (
                  <Badge variant="default" className="gap-1">
                    <Check className="size-3" />
                    Default
                  </Badge>
                )}
                <Badge variant="outline" className="text-xs">
                  RTL
                </Badge>
                {arLang?.isEnabled ? (
                  <Badge variant="secondary" className="text-xs">
                    Enabled
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    Disabled
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Optional Arabic localization with RTL layout support. Disabling
                preserves existing translations.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={arLang?.isEnabled ? "outline" : "default"}
                size="sm"
                disabled={isPending || isArDefault}
                onClick={() => handleToggle("ar", arLang?.isEnabled ?? false)}
                className="min-h-11 px-4 text-xs"
              >
                {isPending ? (
                  <Loader2 className="size-3 animate-spin mr-1" />
                ) : null}
                {isArDefault
                  ? "Active Default (Cannot Disable)"
                  : arLang?.isEnabled
                    ? "Disable Arabic"
                    : "Enable Arabic"}
              </Button>
            </div>
          </div>
        </div>

        {/* Informational Callout */}
        <div className="flex items-start gap-2.5 rounded-lg border bg-background/50 p-3.5 text-xs text-muted-foreground">
          <Info className="size-4 shrink-0 mt-0.5 text-primary" />
          <div className="space-y-1">
            <span className="font-medium text-foreground">
              Fallback Behavior Note
            </span>
            <p>
              English is initially selected as the default language. When a customer
              interacts in another language and a requested translation has not been
              written yet, Rabet falls back to the configured default language. If neither
              translation exists, the result is explicitly missing — no content is fabricated.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
