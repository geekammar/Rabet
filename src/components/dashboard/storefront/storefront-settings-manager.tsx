"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  Loader2,
  RotateCcw,
  Save,
} from "lucide-react";

import {
  resetStorefrontMenuAction,
  saveStorefrontMenuAction,
  type StorefrontMenuActionResult,
} from "@/app/actions/storefront";
import { PageHeader } from "@/components/page-header";
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
  availabilityReasonLabel,
  getStorefrontMenuButtonLabels,
  getStorefrontMenuItemAvailability,
  getVisibleStorefrontMenuItems,
  type StorefrontMenuConfig,
  type StorefrontMenuConfigSource,
  type StorefrontMenuVisibility,
} from "@/lib/storefront/menu";

export interface StorefrontPreviewLanguage {
  code: string;
  label: string;
  isRtl: boolean;
}

interface StorefrontSettingsManagerProps {
  savedConfig: StorefrontMenuConfig;
  configSource: StorefrontMenuConfigSource;
  displayName: string;
  defaultLanguageCode: string;
  enabledLanguages: StorefrontPreviewLanguage[];
  visibility: StorefrontMenuVisibility;
  welcomeMessages: Record<string, string>;
}

function snapshot(config: StorefrontMenuConfig): string {
  return JSON.stringify(config);
}

function statusForItem(
  item: StorefrontMenuConfig["items"][number],
  visibility: StorefrontMenuVisibility,
) {
  if (!item.enabled) {
    return {
      label: "Hidden in configuration",
      tone: "muted" as const,
    };
  }

  const availability = getStorefrontMenuItemAvailability(item.key, visibility);

  if (!availability.available) {
    return {
      label: "Temporarily unavailable",
      tone: "warning" as const,
      reason: availabilityReasonLabel(availability.reason),
    };
  }

  return {
    label: "Visible to customers",
    tone: "visible" as const,
  };
}

function StatusBadge({
  status,
}: {
  status: ReturnType<typeof statusForItem>;
}) {
  if (status.tone === "visible") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
      >
        {status.label}
      </Badge>
    );
  }

  if (status.tone === "warning") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/30 bg-amber-500/10 text-amber-700"
      >
        {status.label}
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-muted-foreground">
      {status.label}
    </Badge>
  );
}

function MenuPreview({
  title,
  description,
  config,
  visibility,
  isDraft,
  previewLanguage,
  welcomeText,
}: {
  title: string;
  description: string;
  config: StorefrontMenuConfig;
  visibility: StorefrontMenuVisibility;
  isDraft: boolean;
  previewLanguage: StorefrontPreviewLanguage;
  welcomeText: string;
}) {
  const labels = getStorefrontMenuButtonLabels(previewLanguage.isRtl);
  const visibleItems = getVisibleStorefrontMenuItems(config, visibility);
  const fallbackUsed = visibleItems.length === 0;

  return (
    <Card
      className={
        isDraft ? "border-amber-500/40 bg-amber-500/5" : undefined
      }
      data-testid={isDraft ? "storefront-preview-draft" : "storefront-preview-saved"}
    >
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          {isDraft ? (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-700"
            >
              Unsaved draft
            </Badge>
          ) : null}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          dir={previewLanguage.isRtl ? "rtl" : "ltr"}
          className="rounded-xl border bg-background p-4"
        >
          <p className="whitespace-pre-wrap break-words text-sm font-medium">
            {welcomeText}
          </p>

          <div className="mt-4 space-y-2" aria-label="Customer menu preview">
            {fallbackUsed ? (
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                No configured entry is currently visible, so Contact Support is
                shown as the minimal safe navigation fallback.
              </div>
            ) : null}

            {config.items.map((item, index) => {
              const status = statusForItem(item, visibility);
              const isVisible = item.enabled && status.tone === "visible";

              return (
                <div
                  key={item.key}
                  className={`flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between ${
                    isVisible ? "bg-background" : "bg-muted/30"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-5 shrink-0 text-xs text-muted-foreground">
                      {index + 1}.
                    </span>
                    {isVisible ? (
                      <Eye className="size-4 shrink-0 text-emerald-600" aria-hidden="true" />
                    ) : (
                      <EyeOff
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className={`min-w-0 break-words text-sm ${
                        isVisible ? "font-medium" : "text-muted-foreground"
                      }`}
                    >
                      {labels[item.key]}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 sm:items-end">
                    <StatusBadge status={status} />
                    {status.reason ? (
                      <span className="break-words text-xs text-muted-foreground">
                        {status.reason}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            Preview only. No Telegram message is sent, no customer preference is
            changed and no inquiry is created.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function StorefrontSettingsManager({
  savedConfig: initialSavedConfig,
  configSource,
  displayName,
  defaultLanguageCode,
  enabledLanguages,
  visibility,
  welcomeMessages,
}: StorefrontSettingsManagerProps) {
  const [savedConfig, setSavedConfig] = useState(initialSavedConfig);
  const [source, setSource] = useState(configSource);
  const [draft, setDraft] = useState(initialSavedConfig);
  const [baseline, setBaseline] = useState(snapshot(initialSavedConfig));
  const [feedback, setFeedback] = useState<StorefrontMenuActionResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [previewLanguageCode, setPreviewLanguageCode] = useState(defaultLanguageCode);

  const isDirty = snapshot(draft) !== baseline;

  const previewLanguages = useMemo(() => {
    if (enabledLanguages.length === 0) {
      return [
        {
          code: defaultLanguageCode,
          label: defaultLanguageCode.toUpperCase(),
          isRtl: defaultLanguageCode === "ar",
        },
      ];
    }

    return [...enabledLanguages].sort((a, b) => {
      if (a.code === defaultLanguageCode) return -1;
      if (b.code === defaultLanguageCode) return 1;
      return a.code.localeCompare(b.code);
    });
  }, [defaultLanguageCode, enabledLanguages]);

  const previewLanguage =
    previewLanguages.find((language) => language.code === previewLanguageCode) ??
    previewLanguages[0];

  const enabledCount = draft.items.filter((item) => item.enabled).length;

  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const toggleItem = (key: string) => {
    setDraft((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.key === key ? { ...item, enabled: !item.enabled } : item,
      ),
    }));
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;

    setDraft((previous) => {
      if (target < 0 || target >= previous.items.length) return previous;

      const items = [...previous.items];
      const [moved] = items.splice(index, 1);
      items.splice(target, 0, moved);

      return { ...previous, items };
    });
  };

  const applyResult = (
    result: StorefrontMenuActionResult,
    nextSource: StorefrontMenuConfigSource,
  ) => {
    setFeedback(result);

    if (result.success && result.config) {
      setSavedConfig(result.config);
      setDraft(result.config);
      setSource(nextSource);
      setBaseline(snapshot(result.config));
    }
  };

  const handleSave = () => {
    if (isPending) return;

    startTransition(async () => {
      try {
        applyResult(await saveStorefrontMenuAction(draft), "saved");
      } catch {
        setFeedback({
          success: false,
          message:
            "A communication or server error occurred. Your changes have been preserved. Please try again.",
        });
      }
    });
  };

  const handleReset = () => {
    if (isPending) return;

    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Reset the storefront menu to the five default entries? This discards the saved customization.",
      )
    ) {
      return;
    }

    startTransition(async () => {
      try {
        applyResult(await resetStorefrontMenuAction(), "default");
      } catch {
        setFeedback({
          success: false,
          message:
            "Could not reset the storefront menu. Your current settings were not changed.",
        });
      }
    });
  };

  const feedbackBanner = feedback ? (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border p-4 text-sm font-medium ${
        feedback.success
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
          : "border-destructive/20 bg-destructive/10 text-destructive"
      }`}
    >
      {feedback.success ? (
        <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
      ) : (
        <AlertCircle className="size-5 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 space-y-1">
        <p>{feedback.message}</p>
        {feedback.errors ? (
          <ul className="list-inside list-disc space-y-0.5 text-xs">
            {Object.entries(feedback.errors).map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div
      className="min-w-0 space-y-6 overflow-x-clip"
      data-testid="storefront-settings"
    >
      <PageHeader
        title="Storefront"
        description="Choose which customer menu entries appear in Telegram, and in what order."
      />

      {feedbackBanner}

      {source === "invalid" ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p>
            The saved menu configuration could not be read. Customers are safely
            seeing the five default entries. Save this form to replace the
            invalid value.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-base">Menu entries</CardTitle>
          <CardDescription>
            {source === "default"
              ? "This store is using the default menu: all five entries are enabled in the original order."
              : "Use the up and down buttons to change the order customers see."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-3">
            {draft.items.map((item, index) => {
              const status = statusForItem(item, visibility);
              const labels = getStorefrontMenuButtonLabels(false);

              return (
                <li
                  key={item.key}
                  data-testid={`storefront-menu-item-${item.key}`}
                  className="flex min-w-0 flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <input
                      id={`storefront-menu-enabled-${item.key}`}
                      data-testid={`storefront-menu-toggle-${item.key}`}
                      type="checkbox"
                      checked={item.enabled}
                      disabled={isPending}
                      onChange={() => toggleItem(item.key)}
                      className="mt-1 size-5 shrink-0 rounded border-gray-300 text-primary"
                    />
                    <div className="min-w-0 space-y-1">
                      <label
                        htmlFor={`storefront-menu-enabled-${item.key}`}
                        className="flex min-h-11 cursor-pointer select-none flex-wrap items-center gap-2 text-sm font-medium"
                      >
                        <span className="break-words">{labels[item.key]}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {item.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={status} />
                        {status.reason ? (
                          <span className="break-words text-xs text-muted-foreground">
                            {status.reason}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 min-w-11"
                      aria-label={`Move ${labels[item.key]} up`}
                      data-testid={`storefront-menu-up-${item.key}`}
                      disabled={isPending || index === 0}
                      onClick={() => moveItem(index, -1)}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 min-w-11"
                      aria-label={`Move ${labels[item.key]} down`}
                      data-testid={`storefront-menu-down-${item.key}`}
                      disabled={isPending || index === draft.items.length - 1}
                      onClick={() => moveItem(index, 1)}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="rounded-xl border bg-muted/20 p-4 text-sm">
            <p className="font-medium">
              {enabledCount} of {draft.items.length} entries enabled
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              At least one entry must stay enabled. If every enabled entry is
              temporarily unavailable because of catalog or language rules,
              Contact Support is shown as a safe fallback so customers are never
              left without navigation.
            </p>
          </div>

          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {isDirty ? "You have unsaved menu changes." : "No unsaved changes."}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                onClick={handleReset}
                disabled={isPending}
                className="min-h-11 gap-2"
                data-testid="storefront-reset-btn"
              >
                <RotateCcw className="size-4" />
                <span>Reset to defaults</span>
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={isPending}
                className="min-h-11 gap-2"
                data-testid="storefront-save-btn"
              >
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                <span>{isPending ? "Saving..." : "Save menu"}</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">Customer preview</h2>
            <p className="text-sm text-muted-foreground">
              A read-only representation of the Telegram home screen.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="storefront-preview-language" className="text-xs font-medium">
              Preview language
            </label>
            <select
              id="storefront-preview-language"
              data-testid="storefront-preview-language"
              value={previewLanguage.code}
              onChange={(event) => setPreviewLanguageCode(event.target.value)}
              className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm sm:w-auto"
            >
              {previewLanguages.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label} ({language.code.toUpperCase()})
                </option>
              ))}
            </select>
          </div>
        </div>

        <MenuPreview
          title="Saved configuration"
          description={`What customers currently see in Telegram for ${displayName}.`}
          config={savedConfig}
          visibility={visibility}
          isDraft={false}
          previewLanguage={previewLanguage}
          welcomeText={
            welcomeMessages[previewLanguage.code] ??
            welcomeMessages[defaultLanguageCode] ??
            (previewLanguage.isRtl
              ? `مرحبًا بك في ${displayName}!`
              : `Welcome to ${displayName}!`)
          }
        />

        {isDirty ? (
          <MenuPreview
            title="Pending unsaved changes"
            description="This preview updates as you edit. It is not live in Telegram until you save."
            config={draft}
            visibility={visibility}
            isDraft
            previewLanguage={previewLanguage}
            welcomeText={
              welcomeMessages[previewLanguage.code] ??
              welcomeMessages[defaultLanguageCode] ??
              (previewLanguage.isRtl
                ? `مرحبًا بك في ${displayName}!`
                : `Welcome to ${displayName}!`)
            }
          />
        ) : null}
      </div>
    </div>
  );
}
