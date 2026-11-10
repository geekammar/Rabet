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

  // Store language info
  const defaultLangCode = defaultLanguage?.code ?? "en";
  const defaultLangLabel =
    defaultLanguage?.label ?? (defaultLangCode === "ar" ? "العربية" : "English");
  const arabicRegistered = languages.some((l) => l.code === "ar");

  // Create Form State
  const [createAdminLabel, setCreateAdminLabel] = useState("");
  const [createIsActive, setCreateIsActive] = useState(false); // Default to disabled
  const [createTitle, setCreateTitle] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");
  const [createArabicTitle, setCreateArabicTitle] = useState("");
  const [createArabicInstructions, setCreateArabicInstructions] = useState("");

  // Edit Form State
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

  const handleOpenCreate = () => {
    setCreateAdminLabel("");
    setCreateIsActive(false);
    setCreateTitle("");
    setCreateInstructions("");
    setCreateArabicTitle("");
    setCreateArabicInstructions("");
    setFeedback(null);
    setIsCreateOpen(true);
  };

  const handleStartEdit = (method: PaymentMethodRecord) => {
    setEditingMethodId(method.id);
    setEditAdminLabel(method.adminLabel);
    setEditIsActive(method.isActive);
    setEditActiveLangTab(defaultLangCode);

    const draft: Record<string, { title: string; instructions: string }> = {};
    for (const [code, t] of Object.entries(method.translations)) {
      draft[code] = {
        title: t.title ?? "",
        instructions: t.instructions ?? "",
      };
    }
    setEditDraftTranslations(draft);
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
    startTransition(async () => {
      try {
        const res = await createPaymentMethodAction({
          adminLabel: createAdminLabel,
          isActive: createIsActive,
          title: createTitle,
          instructions: createInstructions,
          arabicTitle: arabicRegistered && defaultLangCode !== "ar" && createArabicTitle.trim().length > 0 ? createArabicTitle : undefined,
          arabicInstructions: arabicRegistered && defaultLangCode !== "ar" && createArabicInstructions.trim().length > 0 ? createArabicInstructions : undefined,
        });

        setFeedback(res);
        if (res.success && res.method) {
          setMethods((prev) => [...prev, res.method!]);
          setIsCreateOpen(false);
        }
      } catch {
        setFeedback({
          success: false,
          message: "An unexpected error occurred while creating payment method.",
        });
      }
    });
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEditingMethod) return;

    const submittedDraft = editDraftTranslations[editActiveLangTab] || {
      title: "",
      instructions: "",
    };

    startTransition(async () => {
      try {
        const res = await updatePaymentMethodAction({
          id: selectedEditingMethod.id,
          adminLabel: editAdminLabel,
          isActive: editIsActive,
          languageCode: editActiveLangTab,
          title: submittedDraft.title,
          instructions: submittedDraft.instructions,
        });

        setFeedback(res);
        if (res.success && res.method) {
          setMethods((prev) =>
            prev.map((m) => (m.id === res.method!.id ? res.method! : m)),
          );
          setEditingMethodId(null);
        }
      } catch {
        setFeedback({
          success: false,
          message: "An unexpected error occurred while saving payment method.",
        });
      }
    });
  };

  // Resolve preview content for a given method and language
  const resolvePreviewContent = (
    method: PaymentMethodRecord,
    langCode: string,
  ) => {
    const direct = method.translations[langCode];
    if (direct && direct.title.trim().length > 0) {
      return {
        title: direct.title,
        instructions: direct.instructions ?? null,
        isFallback: false,
      };
    }
    const fallback = method.translations[defaultLangCode];
    if (fallback && fallback.title.trim().length > 0) {
      return {
        title: fallback.title,
        instructions: fallback.instructions ?? null,
        isFallback: true,
      };
    }
    return {
      title: method.adminLabel,
      instructions: null,
      isFallback: false,
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

      {/* Feedback banner */}
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
              They do not enable live checkout, store financial credentials, or create orders.
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
                        {method.isActive ? "Active" : "Disabled"}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto"
        >
          <div className="w-full max-w-xl rounded-xl border bg-background shadow-xl my-8">
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
                  <p className="text-[11px] text-muted-foreground">
                    Internal label shown in the admin dashboard and product button selector.
                  </p>
                </div>

                {/* Default Active State (Default disabled) */}
                <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/10">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold">Status: {createIsActive ? "Active" : "Disabled (Default)"}</span>
                    <p className="text-[11px] text-muted-foreground">
                      Methods start disabled until you choose to activate them.
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
                    {createIsActive ? "Active" : "Disabled"}
                  </Button>
                </div>

                {/* Localized Customer-facing Content */}
                <div className="space-y-3 pt-2 border-t">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Customer-facing Content ({defaultLangLabel})</span>
                    <Badge variant="secondary" className="text-[10px] font-mono">
                      {defaultLangCode.toUpperCase()}
                    </Badge>
                  </div>

                  {/* Title */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label htmlFor="create-title" className="text-xs font-medium">
                        Customer Title <span className="text-destructive">*</span>
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(createTitle).length}/{MAX_PAYMENT_TITLE_LENGTH}
                      </span>
                    </div>
                    <input
                      id="create-title"
                      data-testid="create-title-input"
                      type="text"
                      required
                      value={createTitle}
                      disabled={isPending}
                      onChange={(e) => setCreateTitle(e.target.value)}
                      maxLength={MAX_PAYMENT_TITLE_LENGTH}
                      placeholder="e.g. Bank Wire Transfer"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    />
                  </div>

                  {/* Instructions */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label htmlFor="create-instructions" className="text-xs font-medium">
                        Customer Instructions (Optional)
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(createInstructions).length}/{MAX_PAYMENT_INSTRUCTIONS_LENGTH}
                      </span>
                    </div>
                    <textarea
                      id="create-instructions"
                      data-testid="create-instructions-input"
                      rows={3}
                      value={createInstructions}
                      disabled={isPending}
                      onChange={(e) => setCreateInstructions(e.target.value)}
                      maxLength={MAX_PAYMENT_INSTRUCTIONS_LENGTH}
                      placeholder="e.g. Transfer the quote amount to IBAN EG... and reply to the seller with your reference."
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    />
                  </div>
                </div>

                {/* Optional Arabic Fields */}
                {arabicRegistered && defaultLangCode !== "ar" && (
                  <div className="space-y-3 pt-2 border-t">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">العربية (Arabic Optional)</span>
                      <Badge variant="secondary" className="text-[10px] font-mono">
                        AR
                      </Badge>
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="create-ar-title" className="text-xs font-medium">
                        عنوان طريقة الدفع (بالعربية)
                      </label>
                      <input
                        id="create-ar-title"
                        data-testid="create-ar-title-input"
                        dir="rtl"
                        type="text"
                        value={createArabicTitle}
                        disabled={isPending}
                        onChange={(e) => setCreateArabicTitle(e.target.value)}
                        placeholder="مثال: تحويل بنكي"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="create-ar-instructions" className="text-xs font-medium">
                        تعليمات الدفع للعميل (بالعربية)
                      </label>
                      <textarea
                        id="create-ar-instructions"
                        data-testid="create-ar-instructions-input"
                        dir="rtl"
                        rows={3}
                        value={createArabicInstructions}
                        disabled={isPending}
                        onChange={(e) => setCreateArabicInstructions(e.target.value)}
                        placeholder="مثال: قم بتحويل المبلغ إلى حسابنا البنكي وأرسل إشعار التحويل."
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                      />
                    </div>
                  </div>
                )}
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
                  disabled={isPending || createAdminLabel.trim().length === 0 || createTitle.trim().length === 0}
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

      {/* EDIT PAYMENT METHOD DRAWER / MODAL */}
      {selectedEditingMethod && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-payment-method-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto"
        >
          <div className="w-full max-w-xl rounded-xl border bg-background shadow-xl my-8">
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
                </div>

                {/* Status Toggle */}
                <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/10">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold">Status: {editIsActive ? "Active" : "Disabled"}</span>
                    <p className="text-[11px] text-muted-foreground">
                      Disabling keeps existing button bindings intact while hiding them from customers.
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
                    {editIsActive ? "Active" : "Disabled"}
                  </Button>
                </div>

                {/* Localized Tabs */}
                <div className="space-y-3 pt-2 border-t">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Customer-facing Content</span>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant={editActiveLangTab === defaultLangCode ? "default" : "outline"}
                        size="sm"
                        onClick={() => setEditActiveLangTab(defaultLangCode)}
                        className="text-xs min-h-11 px-3"
                      >
                        {defaultLangLabel} ({defaultLangCode.toUpperCase()})
                      </Button>
                      {arabicRegistered && defaultLangCode !== "ar" && (
                        <Button
                          type="button"
                          variant={editActiveLangTab === "ar" ? "default" : "outline"}
                          size="sm"
                          onClick={() => setEditActiveLangTab("ar")}
                          className="text-xs min-h-11 px-3"
                        >
                          العربية (AR)
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Title */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label htmlFor="edit-title" className="text-xs font-medium">
                        Customer Title ({editActiveLangTab.toUpperCase()}) <span className="text-destructive">*</span>
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(editDraftTranslations[editActiveLangTab]?.title || "").length}/{MAX_PAYMENT_TITLE_LENGTH}
                      </span>
                    </div>
                    <input
                      id="edit-title"
                      data-testid="edit-title-input"
                      dir={editActiveLangTab === "ar" ? "rtl" : "ltr"}
                      type="text"
                      required
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
                      dir={editActiveLangTab === "ar" ? "rtl" : "ltr"}
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
                    (editDraftTranslations[editActiveLangTab]?.title ?? "").trim().length === 0
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto"
        >
          <div className="w-full max-w-md rounded-xl border bg-background shadow-xl my-8">
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
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant={previewLangTab === defaultLangCode ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPreviewLangTab(defaultLangCode)}
                    className="text-xs min-h-11 px-3"
                  >
                    {defaultLangLabel} ({defaultLangCode.toUpperCase()})
                  </Button>
                  {arabicRegistered && defaultLangCode !== "ar" && (
                    <Button
                      type="button"
                      variant={previewLangTab === "ar" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPreviewLangTab("ar")}
                      className="text-xs min-h-11 px-3"
                    >
                      العربية (AR)
                    </Button>
                  )}
                </div>
              </div>

              {/* Status Banner */}
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
                  {selectedPreviewMethod.isActive ? "Active (Customer visible)" : "Disabled (Hidden)"}
                </Badge>
              </div>

              {/* Simulated Customer Device Card */}
              {(() => {
                const previewContent = resolvePreviewContent(selectedPreviewMethod, previewLangTab);
                const isRtl = previewLangTab === "ar";

                return (
                  <div
                    data-testid="customer-preview-box"
                    dir={isRtl ? "rtl" : "ltr"}
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
