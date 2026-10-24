"use client";

import { useId, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";

import {
  saveBotContentTranslation,
  type BotContentActionResult,
} from "@/app/actions/bot-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  interpolateTemplate,
  validateTemplateBody,
  type PlaceholderKey,
  type TemplateDefinition,
} from "@/lib/bot-content";
import type { BotSettings, LanguageRow, ResolvedLanguage } from "@/lib/data";
import type { SavedTranslation } from "./types";

interface TemplateCardProps {
  definition: TemplateDefinition;
  initialTranslations: Record<string, SavedTranslation>;
  settings: BotSettings;
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  activeLanguageTab?: string;
  onLanguageTabChange?: (code: string) => void;
}

export function TemplateCard({
  definition,
  initialTranslations,
  settings,
  defaultLanguage,
  languages,
  activeLanguageTab,
  onLanguageTabChange,
}: TemplateCardProps) {
  const textareaId = useId();

  // Languages registered in the database
  const arabicRegistered = languages.some((l) => l.code === "ar");
  const arabicLanguageRow = languages.find((l) => l.code === "ar");
  const arabicDisabled = arabicLanguageRow ? !arabicLanguageRow.isEnabled : false;

  // Track active language for this card (defaults to en)
  const [internalLang, setInternalLang] = useState<string>("en");
  const currentLang = activeLanguageTab ?? internalLang;

  const setLang = (code: string) => {
    if (onLanguageTabChange) {
      onLanguageTabChange(code);
    } else {
      setInternalLang(code);
    }
  };

  // Saved translations mapping: langCode -> body
  const [savedTranslations, setSavedTranslations] = useState<
    Record<string, string>
  >(() => {
    const initial: Record<string, string> = {};
    for (const [code, trans] of Object.entries(initialTranslations)) {
      initial[code] = trans.body;
    }
    return initial;
  });

  // Local drafts mapping: langCode -> body
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    initial.en = initialTranslations.en?.body ?? "";
    initial.ar = initialTranslations.ar?.body ?? "";
    return initial;
  });

  // Action status feedback
  const [actionResult, setActionResult] = useState<BotContentActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const currentDraft = drafts[currentLang] ?? "";
  const currentSaved = savedTranslations[currentLang] ?? "";
  const isSavedInDb = Boolean(savedTranslations[currentLang]);
  const hasUnsavedChanges = currentDraft !== currentSaved;

  // Sample context for live preview
  const previewContext = useMemo(
    () => ({
      store_name: settings.displayName || "Acme Digital",
      product_name: "Premium Leather Bag",
    }),
    [settings.displayName]
  );

  // Live preview text
  const previewText = useMemo(
    () => interpolateTemplate(currentDraft, previewContext),
    [currentDraft, previewContext]
  );

  const isRtl = currentLang === "ar";
  const defaultLangLabel = defaultLanguage?.label || "English";

  // Use suggested text handler
  const handleUseSuggestion = () => {
    const suggestion =
      currentLang === "ar"
        ? definition.suggestedText.ar
        : definition.suggestedText.en;

    setDrafts((prev) => ({
      ...prev,
      [currentLang]: suggestion,
    }));
    setActionResult(null);
  };

  // Reset to saved text handler
  const handleReset = () => {
    setDrafts((prev) => ({
      ...prev,
      [currentLang]: currentSaved,
    }));
    setActionResult(null);
  };

  // Insert placeholder at end of textarea
  const handleInsertPlaceholder = (placeholder: PlaceholderKey) => {
    const tag = `{{${placeholder}}}`;
    setDrafts((prev) => ({
      ...prev,
      [currentLang]: prev[currentLang] ? `${prev[currentLang]} ${tag}` : tag,
    }));
    setActionResult(null);
  };

  // Explicit save action
  const handleSave = () => {
    setActionResult(null);

    // Client-side validation check first
    const validation = validateTemplateBody(
      currentDraft,
      definition.key,
      previewContext
    );

    if (!validation.valid) {
      setActionResult({
        success: false,
        code: "INVALID_INPUT",
        message: validation.error,
      });
      return;
    }

    startTransition(async () => {
      const result = await saveBotContentTranslation({
        templateKey: definition.key,
        languageCode: currentLang,
        body: currentDraft,
      });

      setActionResult(result);

      if (result.success) {
        setSavedTranslations((prev) => ({
          ...prev,
          [currentLang]: currentDraft.trim(),
        }));
      }
    });
  };

  return (
    <Card className="overflow-hidden border border-border shadow-xs">
      <CardHeader className="space-y-2 border-b bg-muted/15 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base font-semibold">
              {definition.title}
            </CardTitle>
            <Badge variant="outline" className="font-mono text-[11px]">
              {definition.key}
            </Badge>
          </div>

          {/* Status Badges */}
          <div className="flex flex-wrap items-center gap-1.5">
            {hasUnsavedChanges && (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium"
              >
                Unsaved changes
              </Badge>
            )}

            {isSavedInDb ? (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2 className="size-3" />
                Saved ({currentLang.toUpperCase()})
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-muted-foreground/30 text-muted-foreground"
                title={`Not saved yet. Bot falls back to ${defaultLangLabel}.`}
              >
                Missing — falls back to {defaultLangLabel}
              </Badge>
            )}
          </div>
        </div>

        <CardDescription className="text-xs text-muted-foreground">
          {definition.purpose}
        </CardDescription>

        {/* Language Tabs within Card */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => {
              setLang("en");
              setActionResult(null);
            }}
            className={`min-h-11 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
              currentLang === "en"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "bg-muted/60 text-muted-foreground hover:bg-muted"
            }`}
          >
            English {savedTranslations.en ? "✓" : ""}
          </button>

          {arabicRegistered ? (
            <button
              type="button"
              onClick={() => {
                setLang("ar");
                setActionResult(null);
              }}
              className={`min-h-11 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                currentLang === "ar"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              }`}
            >
              العربية (Arabic) {savedTranslations.ar ? "✓" : ""}
              {arabicDisabled && (
                <span className="ml-1 text-[10px] opacity-75">(disabled)</span>
              )}
            </button>
          ) : (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground pl-1">
              <span>Arabic not registered.</span>
              <Link
                href="/settings"
                className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2 hover:opacity-80"
              >
                Settings
                <ExternalLink className="size-2.5" />
              </Link>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        {/* Notice if editing disabled Arabic */}
        {currentLang === "ar" && arabicDisabled && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">
            <Info className="size-4 shrink-0 mt-0.5" />
            <p>
              Arabic is registered in your store but currently disabled. You can
              prepare and save Arabic translations here; saving will not enable
              Arabic in the store.
            </p>
          </div>
        )}

        {/* Textarea & Toolbar */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={textareaId}
              className="text-xs font-medium text-foreground"
            >
              Message Body ({currentLang === "ar" ? "Arabic" : "English"})
            </label>

            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleUseSuggestion}
                className="min-h-11 text-xs gap-1.5"
                title="Loads suggested text into local draft. Does not save until you click Save."
              >
                <Sparkles className="size-3.5 text-primary" />
                <span>Use suggested text</span>
              </Button>

              {hasUnsavedChanges && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleReset}
                  className="min-h-11 text-xs gap-1"
                  title="Revert draft back to saved content"
                >
                  <RotateCcw className="size-3" />
                  <span>Reset</span>
                </Button>
              )}
            </div>
          </div>

          <textarea
            id={textareaId}
            value={currentDraft}
            onChange={(e) => {
              const val = e.target.value;
              setDrafts((prev) => ({ ...prev, [currentLang]: val }));
              if (actionResult) setActionResult(null);
            }}
            rows={4}
            dir={isRtl ? "rtl" : "ltr"}
            placeholder={
              currentLang === "ar"
                ? "أدخل نص الرسالة هنا..."
                : "Enter message text here..."
            }
            className={`flex w-full rounded-lg border border-input bg-background p-3 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${
              isRtl ? "font-sans leading-relaxed text-right" : "text-left"
            }`}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            {/* Allowed placeholders helper chips */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground mr-1">Placeholders:</span>
              {definition.allowedPlaceholders.map((placeholder) => (
                <button
                  key={placeholder}
                  type="button"
                  onClick={() => handleInsertPlaceholder(placeholder)}
                  className="inline-flex min-h-11 items-center gap-1 rounded-md border border-input bg-muted/40 px-2 py-1 text-xs font-mono text-foreground hover:bg-muted transition-colors"
                  title={`Insert {{${placeholder}}} into body`}
                >
                  + &#123;&#123;{placeholder}&#125;&#125;
                </button>
              ))}
            </div>

            {/* Character count */}
            <span
              className={`font-mono ${
                currentDraft.length > 4096
                  ? "font-semibold text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {currentDraft.length} / 4096
            </span>
          </div>
        </div>

        {/* Live Preview Box */}
        <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Live Preview (Sample Context)
            </span>
            <span className="text-[11px] text-muted-foreground italic">
              Plain text & line breaks preserved
            </span>
          </div>

          <div
            dir={isRtl ? "rtl" : "ltr"}
            className={`min-h-12 rounded-md border bg-background/80 p-3 text-sm text-foreground whitespace-pre-wrap break-words ${
              isRtl ? "text-right leading-relaxed" : "text-left"
            }`}
          >
            {previewText.trim().length > 0 ? (
              previewText
            ) : (
              <span className="text-xs text-muted-foreground italic">
                (Empty draft — enter text or click &quot;Use suggested text&quot; to preview)
              </span>
            )}
          </div>
        </div>

        {/* Action result messages */}
        {actionResult && !actionResult.success && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-semibold">Validation error</p>
              <p>{actionResult.message}</p>
            </div>
          </div>
        )}

        {actionResult && actionResult.success && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
            <p className="font-medium">{actionResult.message}</p>
          </div>
        )}

        {/* Footer with Explicit Save Button */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t">
          <div className="text-[11px] text-muted-foreground">
            {isSavedInDb ? (
              <span>Template is stored in database.</span>
            ) : (
              <span>Not yet stored in database.</span>
            )}
          </div>

          <Button
            type="button"
            onClick={handleSave}
            disabled={isPending || currentDraft.trim().length === 0}
            className="min-h-11 w-full sm:w-auto px-5 text-sm font-medium gap-2"
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>Saving {currentLang.toUpperCase()}...</span>
              </>
            ) : (
              <>
                <Save className="size-4" />
                <span>
                  Save {currentLang === "ar" ? "Arabic" : "English"} Message
                </span>
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
