"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Power,
  X,
} from "lucide-react";

import {
  createPaymentMethodAction,
  type PaymentMethodActionResult,
  togglePaymentMethodActiveAction,
  updatePaymentMethodAction,
} from "@/app/actions/payment-methods";
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
import type { LanguageRow, PaymentMethodRecord, ResolvedLanguage } from "@/lib/data";
import {
  MAX_ADMIN_LABEL_LENGTH,
  MAX_PAYMENT_INSTRUCTIONS_LENGTH,
  MAX_PAYMENT_TITLE_LENGTH,
} from "@/lib/payment-methods/constants";

interface PaymentMethodsManagerProps {
  initialMethods: PaymentMethodRecord[];
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
}

export function PaymentMethodsManager({
  initialMethods,
  defaultLanguage,
  languages,
}: PaymentMethodsManagerProps) {
  const [methods, setMethods] = useState<PaymentMethodRecord[]>(initialMethods);
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<PaymentMethodActionResult | null>(null);

  // Modals & Drawers state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingMethodId, setEditingMethodId] = useState<string | null>(null);
  const [previewMethodId, setPreviewMethodId] = useState<string | null>(null);

  // Form error states inside open modals
  const [createModalError, setCreateModalError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
  const [editModalError, setEditModalError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>({});

  // Store language info
  const defaultLangCode = (defaultLanguage?.code ?? "en").toLowerCase();

  // Create Form State - symmetrical multi-language support
  const [createAdminLabel, setCreateAdminLabel] = useState("");
  const [createIsActive, setCreateIsActive] = useState(false); // Default to disabled
  const [createActiveLangTab, setCreateActiveLangTab] = useState<string>(defaultLangCode);
  const [createDraftTranslations, setCreateDraftTranslations] = useState<
    Record<string, { title: string; instructions: string }>
  >({});

  // Edit Form State - symmetrical multi-language support
  const [editAdminLabel, setEditAdminLabel] = useState("");
  const [editIsActive, setEditIsActive] = useState(false);
  const [editActiveLangTab, setEditActiveLangTab] = useState<string>(defaultLangCode);
  const [editDraftTranslations, setEditDraftTranslations] = useState<
    Record<string, { title: string; instructions: string }>
  >({});

  // Active language tab in preview modal
  const [previewLangTab, setPreviewLangTab] = useState<string>(defaultLangCode);

  const selectedEditingMethod = useMemo(() => {
    if (!editingMethodId) return null;
    return methods.find((m) => m.id === editingMethodId) ?? null;
  }, [methods, editingMethodId]);

  const selectedPreviewMethod = useMemo(() => {
    if (!previewMethodId) return null;
    return methods.find((m) => m.id === previewMethodId) ?? null;
  }, [methods, previewMethodId]);

  const getLanguageDir = (code: string): "ltr" | "rtl" => {
    const lang = languages.find((l) => l.code.toLowerCase() === code.toLowerCase());
    if (lang?.textDirection === "rtl" || lang?.textDirection === "ltr") {
      return lang.textDirection;
    }
    return code.toLowerCase() === "ar" ? "rtl" : "ltr";
  };

  const getLanguageLabel = (code: string): string => {
    const lang = languages.find((l) => l.code.toLowerCase() === code.toLowerCase());
    if (lang?.label) return lang.label;
    return code.toLowerCase() === "ar" ? "العربية" : code.toUpperCase();
  };

  const handleOpenCreate = () => {
    setCreateAdminLabel("");
    setCreateIsActive(false);
    setCreateActiveLangTab(defaultLangCode);
    const initialDrafts: Record<string, { title: string; instructions: string }> = {};
    for (const l of languages) {
      initialDrafts[l.code.toLowerCase()] = { title: "", instructions: "" };
    }
    setCreateDraftTranslations(initialDrafts);
    setCreateModalError(null);
    setCreateFieldErrors({});
    setFeedback(null);
    setIsCreateOpen(true);
  };

  const handleStartEdit = (method: PaymentMethodRecord) => {
    setEditingMethodId(method.id);
    setEditAdminLabel(method.adminLabel);
    setEditIsActive(method.isActive);
    setEditActiveLangTab(defaultLangCode);

    const drafts: Record<string, { title: string; instructions: string }> = {};
    for (const l of languages) {
      const existing = method.translations[l.code.toLowerCase()];
      drafts[l.code.toLowerCase()] = {
        title: existing?.title ?? "",
        instructions: existing?.instructions ?? "",
      };
    }
    // Also include any translations present on method but not in languages list
    for (const [code, t] of Object.entries(method.translations)) {
      if (!drafts[code.toLowerCase()]) {
        drafts[code.toLowerCase()] = {
          title: t.title ?? "",
          instructions: t.instructions ?? "",
        };
      }
    }

    setEditDraftTranslations(drafts);
    setEditModalError(null);
    setEditFieldErrors({});
    setFeedback(null);
  };

  const handleToggleActive = (method: PaymentMethodRecord) => {
    const nextState = !method.isActive;
    startTransition(async () => {
      try {
        const res = await togglePaymentMethodActiveAction(method.id, nextState);
        setFeedback(res);
        if (res.success && res.method) {
          setMethods((prev) =>
            prev.map((m) => (m.id === res.method!.id ? res.method! : m)),
          );
        }
      } catch {
        setFeedback({
          success: false,
          message: "Failed to update payment method status.",
        });
      }
    });
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCreateModalError(null);
    setCreateFieldErrors({});

    // Symmetrically collect drafts from all registered languages
    const translationsPayload = Object.entries(createDraftTranslations)
      .map(([code, draft]) => ({
        languageCode: code,
        title: draft.title,
        instructions: draft.instructions,
      }))
      .filter((t) => t.title.trim().length > 0 || t.instructions.trim().length > 0);

    const defaultDraft = createDraftTranslations[defaultLangCode];

    startTransition(async () => {
      try {
        const res = await createPaymentMethodAction({
          adminLabel: createAdminLabel,
          isActive: createIsActive,
          translations: translationsPayload,
          title: defaultDraft?.title,
          instructions: defaultDraft?.instructions,
        });

        if (res.success && res.method) {
          setFeedback(res);
          setMethods((prev) => [...prev, res.method!]);
          setIsCreateOpen(false);
        } else {
          // Keep form open, preserve drafts, display error inside modal
          setCreateModalError(res.message || "Failed to create payment method.");
          setCreateFieldErrors(res.errors || {});
        }
      } catch {
        setCreateModalError("An unexpected error occurred while creating payment method.");
      }
    });
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEditingMethod) return;

    setEditModalError(null);
    setEditFieldErrors({});

    // Atomic multilingual save: Send all drafts across all languages in one payload
    const translationsPayload = Object.entries(editDraftTranslations).map(([code, draft]) => ({
      languageCode: code,
      title: draft.title,
      instructions: draft.instructions,
    }));

    startTransition(async () => {
      try {
        const res = await updatePaymentMethodAction({
          id: selectedEditingMethod.id,
          adminLabel: editAdminLabel,
          isActive: editIsActive,
          translations: translationsPayload,
        });

        if (res.success && res.method) {
          setFeedback(res);
          setMethods((prev) =>
            prev.map((m) => (m.id === res.method!.id ? res.method! : m)),
          );
          setEditingMethodId(null);
        } else {
          // Keep form open, preserve drafts, display error inside modal
          setEditModalError(res.message || "Failed to save payment method changes.");
          setEditFieldErrors(res.errors || {});
        }
      } catch {
        setEditModalError("An unexpected error occurred while saving payment method.");
      }
    });
  };

  // Resolve preview content for a given method and language
  const resolvePreviewContent = (
    method: PaymentMethodRecord,
    langCode: string,
  ) => {
    const direct = method.translations[langCode.toLowerCase()];
    if (direct && direct.title.trim().length > 0) {
      return {
        title: direct.title,
        instructions: direct.instructions ?? null,
        isFallback: false,
        langCode: langCode.toLowerCase(),
      };
    }
    const fallback = method.translations[defaultLangCode];
    if (fallback && fallback.title.trim().length > 0) {
      return {
        title: fallback.title,
        instructions: fallback.instructions ?? null,
        isFallback: true,
        langCode: defaultLangCode,
      };
    }
    return {
      title: method.adminLabel,
      instructions: null,
      isFallback: false,
      langCode: defaultLangCode,
    };
  };

  return (
    <div className="space-y-6 w-full min-w-0" data-testid="payment-methods-manager">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <div>
          <PageHeader
            title="Payment Methods"
            description="Define payment methods once, bind them to product buttons, and preview customer instructions."
          />
        </div>

        <Button
          type="button"
          onClick={handleOpenCreate}
          disabled={isPending}
          className="min-h-11 px-4 gap-2 font-medium touch-manipulation"
          data-testid="create-payment-method-btn"
        >
          <Plus className="size-4" />
          Add Payment Method
        </Button>
      </div>

      {/* Global feedback banner */}
      {feedback?.message && (
        <div
          role="alert"
          className={`flex items-start gap-3 rounded-xl border p-4 text-sm font-medium ${
            feedback.success
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-destructive/20 bg-destructive/10 text-destructive"
          }`}
          data-testid="payment-method-feedback"
        >
          {feedback.success ? (
            <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
          ) : (
            <AlertCircle className="size-5 shrink-0 text-destructive" />
          )}
          <div className="flex-1">
            <p>{feedback.message}</p>
            {feedback.errors && (
              <ul className="mt-1 list-disc pl-5 text-xs space-y-0.5">
                {Object.entries(feedback.errors).map(([k, err]) => (
                  <li key={k}>{err}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-muted-foreground hover:text-foreground size-6 flex items-center justify-center rounded"
            aria-label="Dismiss feedback"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Scope Disclaimer / PR Boundary Note */}
      <Card className="border-border/60 bg-muted/20">
        <CardContent className="p-4 flex items-start gap-3 text-xs text-muted-foreground">
          <CreditCard className="size-4 shrink-0 text-primary/70 mt-0.5" />
          <div>
            <p className="font-semibold text-foreground">Future Channel Preparation (No Live Checkout)</p>
            <p>
              Payment methods defined here provide centralized instructions and button binding for future channels.
              They do not enable live checkout, store financial credentials, or create orders. Customer-facing Telegram currently excludes payment method buttons.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Payment Methods List */}
      <div className="space-y-4">
        {methods.length === 0 ? (
          <Card className="border-dashed p-8 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
              <CreditCard className="size-6 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-base font-semibold">No payment methods configured</h3>
            <p className="mt-1 text-sm text-muted-foreground max-w-sm mx-auto">
              Add a payment method (e.g. Bank Transfer, Cash, or Wallet) to define customer-facing instructions and bind it to product buttons.
            </p>
            <div className="mt-6">
              <Button
                type="button"
                onClick={handleOpenCreate}
                className="min-h-11 px-4 gap-2"
              >
                <Plus className="size-4" />
                Add Your First Method
              </Button>
            </div>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {methods.map((method) => {
              const defaultTrans = method.translations[defaultLangCode];
              const customerTitle = defaultTrans?.title || method.adminLabel;
              const hasInstructions = Boolean(defaultTrans?.instructions?.trim());

              return (
                <Card
                  key={method.id}
                  data-testid="payment-method-card"
                  data-method-id={method.id}
                  className="flex flex-col justify-between border-border/80 hover:border-border transition-colors"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base font-bold truncate">
                          {method.adminLabel}
                        </CardTitle>
                        <CardDescription className="text-xs truncate mt-0.5">
                          Title: &quot;{customerTitle}&quot;
                        </CardDescription>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          method.isActive
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 font-medium shrink-0"
                            : "border-muted text-muted-foreground font-medium shrink-0"
                        }
                        data-testid="method-status-badge"
                      >
                        {method.isActive ? "Enabled" : "Disabled"}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-3 pb-3 flex-1 text-xs text-muted-foreground">
                    <p className="line-clamp-2">
                      {defaultTrans?.instructions?.trim() || "No instructions provided."}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <Badge variant="secondary" className="text-[10px]">
                        {Object.keys(method.translations).length} {Object.keys(method.translations).length === 1 ? "Language" : "Languages"}
                      </Badge>
                      {hasInstructions && (
                        <Badge variant="secondary" className="text-[10px]">
                          Has Instructions
                        </Badge>
                      )}
                    </div>
                  </CardContent>

                  <div className="border-t p-3 flex items-center justify-between gap-2 bg-muted/10">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isPending}
                        onClick={() => {
                          setPreviewMethodId(method.id);
                          setPreviewLangTab(defaultLangCode);
                        }}
                        className="min-h-11 px-2.5 text-xs gap-1.5"
                        data-testid="preview-method-btn"
                        title="Preview customer-facing presentation"
                      >
                        <Eye className="size-3.5" />
                        Preview
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isPending}
                        onClick={() => handleStartEdit(method)}
                        className="min-h-11 px-2.5 text-xs gap-1.5"
                        data-testid="edit-method-btn"
                        title="Edit payment method details"
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </Button>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleToggleActive(method)}
                      className={`min-h-11 px-3 text-xs gap-1.5 ${
                        method.isActive
                          ? "text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                          : "text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10"
                      }`}
                      data-testid="toggle-active-btn"
                    >
                      <Power className="size-3.5" />
                      {method.isActive ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* CREATE PAYMENT METHOD MODAL */}
      {isCreateOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-payment-method-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto overflow-x-hidden"
        >
          <div className="w-full max-w-xl rounded-xl border bg-background shadow-xl my-8 min-w-0">
            <form onSubmit={handleCreateSubmit} noValidate>
              <div className="flex items-center justify-between border-b p-4">
                <div className="flex items-center gap-2">
                  <CreditCard className="size-5 text-primary" />
                  <h3 id="create-payment-method-title" className="text-base font-bold">
                    Add Payment Method
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={isPending}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground size-11 flex items-center justify-center"
                  aria-label="Close modal"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
                {/* In-form error alert banner */}
                {createModalError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive font-medium"
                    data-testid="create-modal-error"
                  >
                    <AlertCircle className="size-4 shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <p>{createModalError}</p>
                      {Object.keys(createFieldErrors).length > 0 && (
                        <ul className="list-disc pl-4 space-y-0.5">
                          {Object.entries(createFieldErrors).map(([key, msg]) => (
                            <li key={key}>{msg}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

                {/* Admin Label */}
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label htmlFor="create-admin-label" className="text-xs font-semibold">
                      Admin Label <span className="text-destructive">*</span>
                    </label>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {Array.from(createAdminLabel).length}/{MAX_ADMIN_LABEL_LENGTH}
                    </span>
                  </div>
                  <input
                    id="create-admin-label"
                    data-testid="create-admin-label-input"
                    type="text"
                    required
                    value={createAdminLabel}
                    disabled={isPending}
                    onChange={(e) => setCreateAdminLabel(e.target.value)}
                    maxLength={MAX_ADMIN_LABEL_LENGTH}
                    placeholder="e.g. Bank Transfer (CIB) or Vodafone Cash"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                  />
                  {createFieldErrors.adminLabel && (
                    <p className="text-[11px] text-destructive font-medium">
                      {createFieldErrors.adminLabel}
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Internal label shown in the admin dashboard and product button selector.
                  </p>
                </div>

                {/* Default Active State (Default disabled) */}
                <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/10">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold">
                      Status: {createIsActive ? "Enabled (Preview ready)" : "Disabled (Default)"}
                    </span>
                    <p className="text-[11px] text-muted-foreground">
                      Methods start disabled until you choose to activate them. Buttons referencing disabled methods show status clearly to admins.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant={createIsActive ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCreateIsActive((prev) => !prev)}
                    className="min-h-11 px-3 text-xs"
                    data-testid="create-status-toggle"
                  >
                    {createIsActive ? "Enabled" : "Disabled"}
                  </Button>
                </div>

                {/* Symmetrical Multilingual Content Tabs */}
                <div className="space-y-3 pt-2 border-t">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Customer-facing Content</span>
                    <div className="flex gap-1 flex-wrap">
                      {languages.map((l) => {
                        const code = l.code.toLowerCase();
                        const isDefault = code === defaultLangCode;
                        return (
                          <Button
                            key={code}
                            type="button"
                            variant={createActiveLangTab === code ? "default" : "outline"}
                            size="sm"
                            onClick={() => setCreateActiveLangTab(code)}
                            className="text-xs min-h-11 px-3"
                          >
                            {getLanguageLabel(code)} ({code.toUpperCase()})
                            {isDefault ? " *" : ""}
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Title for active tab */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label htmlFor="create-title" className="text-xs font-medium">
                        Customer Title ({createActiveLangTab.toUpperCase()})
                        {createActiveLangTab === defaultLangCode && (
                          <span className="text-destructive"> *</span>
                        )}
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(createDraftTranslations[createActiveLangTab]?.title || "").length}/{MAX_PAYMENT_TITLE_LENGTH}
                      </span>
                    </div>
                    <input
                      id="create-title"
                      data-testid="create-title-input"
                      dir={getLanguageDir(createActiveLangTab)}
                      type="text"
                      required={createActiveLangTab === defaultLangCode}
                      value={createDraftTranslations[createActiveLangTab]?.title ?? ""}
                      disabled={isPending}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCreateDraftTranslations((prev) => ({
                          ...prev,
                          [createActiveLangTab]: {
                            title: val,
                            instructions: prev[createActiveLangTab]?.instructions ?? "",
                          },
                        }));
                      }}
                      maxLength={MAX_PAYMENT_TITLE_LENGTH}
                      placeholder={
                        createActiveLangTab === "ar"
                          ? "مثال: تحويل بنكي"
                          : "e.g. Bank Wire Transfer"
                      }
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    />
                    {createFieldErrors[`title_${createActiveLangTab}`] && (
                      <p className="text-[11px] text-destructive font-medium">
                        {createFieldErrors[`title_${createActiveLangTab}`]}
                      </p>
                    )}
                  </div>

                  {/* Instructions for active tab */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label htmlFor="create-instructions" className="text-xs font-medium">
                        Customer Instructions ({createActiveLangTab.toUpperCase()}) (Optional)
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(createDraftTranslations[createActiveLangTab]?.instructions || "").length}/{MAX_PAYMENT_INSTRUCTIONS_LENGTH}
                      </span>
                    </div>
                    <textarea
                      id="create-instructions"
                      data-testid="create-instructions-input"
                      dir={getLanguageDir(createActiveLangTab)}
                      rows={3}
                      value={createDraftTranslations[createActiveLangTab]?.instructions ?? ""}
                      disabled={isPending}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCreateDraftTranslations((prev) => ({
                          ...prev,
                          [createActiveLangTab]: {
                            title: prev[createActiveLangTab]?.title ?? "",
                            instructions: val,
                          },
                        }));
                      }}
                      maxLength={MAX_PAYMENT_INSTRUCTIONS_LENGTH}
                      placeholder={
                        createActiveLangTab === "ar"
                          ? "مثال: قم بتحويل المبلغ إلى حسابنا البنكي وأرسل إشعار التحويل."
                          : "e.g. Transfer the quote amount to IBAN EG... and reply with your reference."
                      }
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t p-4 bg-muted/20">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={isPending}
                  className="min-h-11 px-4"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    isPending ||
                    createAdminLabel.trim().length === 0 ||
                    (createDraftTranslations[defaultLangCode]?.title ?? "").trim().length === 0
                  }
                  className="min-h-11 px-5 gap-2"
                  data-testid="submit-create-payment-method-btn"
                >
                  {isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    "Create Method"
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT PAYMENT METHOD MODAL */}
      {selectedEditingMethod && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-payment-method-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto overflow-x-hidden"
        >
          <div className="w-full max-w-xl rounded-xl border bg-background shadow-xl my-8 min-w-0">
            <form onSubmit={handleEditSubmit} noValidate>
              <div className="flex items-center justify-between border-b p-4">
                <div className="flex items-center gap-2">
                  <Pencil className="size-5 text-primary" />
                  <h3 id="edit-payment-method-title" className="text-base font-bold">
                    Edit Payment Method
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingMethodId(null)}
                  disabled={isPending}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground size-11 flex items-center justify-center"
                  aria-label="Close edit"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
                {/* In-form error alert banner */}
                {editModalError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive font-medium"
                    data-testid="edit-modal-error"
                  >
                    <AlertCircle className="size-4 shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <p>{editModalError}</p>
                      {Object.keys(editFieldErrors).length > 0 && (
                        <ul className="list-disc pl-4 space-y-0.5">
                          {Object.entries(editFieldErrors).map(([key, msg]) => (
                            <li key={key}>{msg}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

                {/* Admin Label */}
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label htmlFor="edit-admin-label" className="text-xs font-semibold">
                      Admin Label <span className="text-destructive">*</span>
                    </label>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {Array.from(editAdminLabel).length}/{MAX_ADMIN_LABEL_LENGTH}
                    </span>
                  </div>
                  <input
                    id="edit-admin-label"
                    data-testid="edit-admin-label-input"
                    type="text"
                    required
                    value={editAdminLabel}
                    disabled={isPending}
                    onChange={(e) => setEditAdminLabel(e.target.value)}
                    maxLength={MAX_ADMIN_LABEL_LENGTH}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                  />
                  {editFieldErrors.adminLabel && (
                    <p className="text-[11px] text-destructive font-medium">
                      {editFieldErrors.adminLabel}
                    </p>
                  )}
                </div>

                {/* Status Toggle */}
                <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/10">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold">
                      Status: {editIsActive ? "Enabled (Preview ready)" : "Disabled"}
                    </span>
                    <p className="text-[11px] text-muted-foreground">
                      Disabling keeps existing button bindings intact while marking the method as disabled in dashboard previews.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant={editIsActive ? "default" : "outline"}
                    size="sm"
                    onClick={() => setEditIsActive((prev) => !prev)}
                    className="min-h-11 px-3 text-xs"
                    data-testid="edit-status-toggle"
                  >
                    {editIsActive ? "Enabled" : "Disabled"}
                  </Button>
                </div>

                {/* Symmetrical Multilingual Tabs */}
                <div className="space-y-3 pt-2 border-t">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Customer-facing Content</span>
                    <div className="flex gap-1 flex-wrap">
                      {languages.map((l) => {
                        const code = l.code.toLowerCase();
                        const isDefault = code === defaultLangCode;
                        return (
                          <Button
                            key={code}
                            type="button"
                            variant={editActiveLangTab === code ? "default" : "outline"}
                            size="sm"
                            onClick={() => setEditActiveLangTab(code)}
                            className="text-xs min-h-11 px-3"
                          >
                            {getLanguageLabel(code)} ({code.toUpperCase()})
                            {isDefault ? " *" : ""}
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Title */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label htmlFor="edit-title" className="text-xs font-medium">
                        Customer Title ({editActiveLangTab.toUpperCase()})
                        {editActiveLangTab === defaultLangCode && (
                          <span className="text-destructive"> *</span>
                        )}
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(editDraftTranslations[editActiveLangTab]?.title || "").length}/{MAX_PAYMENT_TITLE_LENGTH}
                      </span>
                    </div>
                    <input
                      id="edit-title"
                      data-testid="edit-title-input"
                      dir={getLanguageDir(editActiveLangTab)}
                      type="text"
                      required={editActiveLangTab === defaultLangCode}
                      value={editDraftTranslations[editActiveLangTab]?.title ?? ""}
                      disabled={isPending}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEditDraftTranslations((prev) => ({
                          ...prev,
                          [editActiveLangTab]: {
                            title: val,
                            instructions: prev[editActiveLangTab]?.instructions ?? "",
                          },
                        }));
                      }}
                      maxLength={MAX_PAYMENT_TITLE_LENGTH}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    />
                    {editFieldErrors[`title_${editActiveLangTab}`] && (
                      <p className="text-[11px] text-destructive font-medium">
                        {editFieldErrors[`title_${editActiveLangTab}`]}
                      </p>
                    )}
                  </div>

                  {/* Instructions */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label htmlFor="edit-instructions" className="text-xs font-medium">
                        Customer Instructions ({editActiveLangTab.toUpperCase()})
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(editDraftTranslations[editActiveLangTab]?.instructions || "").length}/{MAX_PAYMENT_INSTRUCTIONS_LENGTH}
                      </span>
                    </div>
                    <textarea
                      id="edit-instructions"
                      data-testid="edit-instructions-input"
                      dir={getLanguageDir(editActiveLangTab)}
                      rows={3}
                      value={editDraftTranslations[editActiveLangTab]?.instructions ?? ""}
                      disabled={isPending}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEditDraftTranslations((prev) => ({
                          ...prev,
                          [editActiveLangTab]: {
                            title: prev[editActiveLangTab]?.title ?? "",
                            instructions: val,
                          },
                        }));
                      }}
                      maxLength={MAX_PAYMENT_INSTRUCTIONS_LENGTH}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t p-4 bg-muted/20">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingMethodId(null)}
                  disabled={isPending}
                  className="min-h-11 px-4"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    isPending ||
                    editAdminLabel.trim().length === 0 ||
                    (editDraftTranslations[defaultLangCode]?.title ?? "").trim().length === 0
                  }
                  className="min-h-11 px-5 gap-2"
                  data-testid="submit-edit-payment-method-btn"
                >
                  {isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Changes"
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CUSTOMER PREVIEW MODAL */}
      {selectedPreviewMethod && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-payment-method-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto overflow-x-hidden"
        >
          <div className="w-full max-w-md rounded-xl border bg-background shadow-xl my-8 min-w-0">
            <div className="flex items-center justify-between border-b p-4">
              <div className="flex items-center gap-2">
                <Eye className="size-5 text-primary" />
                <h3 id="preview-payment-method-title" className="text-base font-bold">
                  Customer Preview
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPreviewMethodId(null)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground size-11 flex items-center justify-center"
                aria-label="Close preview"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Language Selector */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Preview Language:</span>
                <div className="flex gap-1 flex-wrap">
                  {languages.map((l) => {
                    const code = l.code.toLowerCase();
                    return (
                      <Button
                        key={code}
                        type="button"
                        variant={previewLangTab === code ? "default" : "outline"}
                        size="sm"
                        onClick={() => setPreviewLangTab(code)}
                        className="text-xs min-h-11 px-3"
                      >
                        {getLanguageLabel(code)} ({code.toUpperCase()})
                      </Button>
                    );
                  })}
                </div>
              </div>

              {/* Status Banner - Honest Availability Language */}
              <div className="flex items-center justify-between rounded-lg border p-2.5 text-xs">
                <span className="text-muted-foreground">Method Status:</span>
                <Badge
                  variant="outline"
                  className={
                    selectedPreviewMethod.isActive
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 font-medium"
                      : "border-muted text-muted-foreground font-medium"
                  }
                >
                  {selectedPreviewMethod.isActive
                    ? "Enabled (Preview ready — Telegram channel unavailable)"
                    : "Disabled (Draft)"}
                </Badge>
              </div>

              {/* Simulated Customer Device Card */}
              {(() => {
                const previewContent = resolvePreviewContent(selectedPreviewMethod, previewLangTab);
                const contentDir = getLanguageDir(previewContent.langCode);

                return (
                  <div
                    data-testid="customer-preview-box"
                    dir={contentDir}
                    className="rounded-xl border bg-muted/30 p-4 space-y-3 text-left shadow-xs"
                  >
                    <div className="flex items-center gap-2">
                      <CreditCard className="size-4 text-primary shrink-0" />
                      <h4 className="text-sm font-bold text-foreground">
                        {previewContent.title}
                      </h4>
                      {previewContent.isFallback && (
                        <Badge variant="outline" className="text-[10px] shrink-0 text-muted-foreground">
                          Fallback ({defaultLangCode.toUpperCase()})
                        </Badge>
                      )}
                    </div>

                    {previewContent.instructions ? (
                      <div className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed bg-background/80 rounded-lg p-3 border">
                        {previewContent.instructions}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">
                        No instructions provided for this method.
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="flex items-center justify-end border-t p-3 bg-muted/20">
              <Button
                type="button"
                onClick={() => setPreviewMethodId(null)}
                className="min-h-11 px-4 text-xs"
              >
                Close Preview
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
