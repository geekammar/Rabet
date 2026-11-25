"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PackageCheck,
  XCircle,
} from "lucide-react";

import {
  acceptMerchantOrderAction,
  cancelMerchantOrderAction,
  collectMerchantOrderPaymentAction,
  handMerchantOrderToShippingAction,
  markMerchantOrderDeliveredAction,
  prepareMerchantOrderAction,
  type MerchantOrderActionCode,
  type MerchantOrderActionState,
} from "@/app/actions/merchant-orders";
import { Button } from "@/components/ui/button";
import type { MerchantLocale } from "@/lib/merchant/locale";
import {
  CANCELLATION_REASON_MAX_LENGTH,
  CANCELLATION_REASON_MIN_LENGTH,
  canCancelMerchantOrder,
  nextMerchantOrderAction,
  type MerchantOrderNextAction,
} from "@/lib/commerce/order-state";

type Copy = {
  nextAction: string;
  accept: string;
  prepare: string;
  handToShipping: string;
  deliver: string;
  collectCod: string;
  working: string;
  preparingNote: string;
  shippedNote: string;
  deliveredNote: string;
  collectedNote: string;
  cancelledNote: string;
  shippingTitle: string;
  shippingHint: string;
  confirmShipping: string;
  keepPreparing: string;
  collectionTitle: string;
  collectionHint: string;
  confirmCollection: string;
  keepAwaiting: string;
  cancel: string;
  cancelTitle: string;
  cancelHint: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  confirmCancel: string;
  keepOrder: string;
  reasonRequired: string;
  readOnlyNote: string;
  localisation: Record<MerchantOrderActionCode | "NETWORK", string>;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    nextAction: "الإجراء التالي",
    accept: "قبول الطلب",
    prepare: "بدء التجهيز",
    handToShipping: "تسليم للشحن",
    deliver: "تأكيد التوصيل",
    collectCod: "تسجيل تحصيل الدفع",
    working: "جارٍ الحفظ…",
    preparingNote: "الطلب جاهز وبانتظار تسليمه للشحن.",
    shippedNote: "تم تسليم الطلب للشحن. أكّد التوصيل بعد استلام العميل.",
    deliveredNote: "تم توصيل الطلب. سجّل التحصيل بعد استلام المبلغ نقدًا.",
    collectedNote: "تم التوصيل وتحصيل الدفع نقدًا. اكتمل الطلب.",
    cancelledNote: "تم إلغاء هذا الطلب وتحرير المخزون المحجوز.",
    shippingTitle: "تسليم الطلب للشحن",
    shippingHint:
      "سيتم تثبيت الحجز وخصم الكمية المشحونة من المخزون المتاح والفعلي. لا يمكن التراجع عن هذه الخطوة.",
    confirmShipping: "تأكيد التسليم للشحن",
    keepPreparing: "ليس الآن",
    collectionTitle: "تسجيل تحصيل الدفع عند الاستلام",
    collectionHint:
      "أكّد فقط بعد استلام المبلغ نقدًا. ستتغير حالة الدفع وحدها، دون تغيير المخزون أو حالة التوصيل.",
    confirmCollection: "تأكيد استلام المبلغ",
    keepAwaiting: "لم يُحصّل بعد",
    cancel: "إلغاء الطلب",
    cancelTitle: "إلغاء الطلب قبل الشحن",
    cancelHint:
      "سيُحرر الحجز المحفوظ لهذا الطلب، ولن يتغير المخزون الفعلي. اكتب سببًا واضحًا.",
    reasonLabel: "سبب الإلغاء",
    reasonPlaceholder: "لماذا يتم إلغاء هذا الطلب؟",
    confirmCancel: "تأكيد الإلغاء",
    keepOrder: "الاحتفاظ بالطلب",
    reasonRequired: "اكتب سببًا من ٣ إلى ٣٠٠ حرف.",
    readOnlyNote:
      "يمكنك مراجعة الطلب فقط. القبول والتجهيز والشحن والتوصيل والتحصيل والإلغاء غير متاحة حتى يعيد مسؤول المنصة تفعيل المتجر.",
    localisation: {
      ACCEPTED: "تم قبول الطلب.",
      PREPARED: "تم تحويل الطلب إلى قيد التجهيز.",
      HANDED_TO_SHIPPING: "تم تسليم الطلب للشحن وتثبيت المخزون مرة واحدة.",
      DELIVERED: "تم تسجيل توصيل الطلب.",
      COLLECTED: "تم تسجيل تحصيل الدفع عند الاستلام.",
      CANCELLED: "تم إلغاء الطلب وتحرير الحجز مرة واحدة.",
      ALREADY_APPLIED: "تمت هذه الخطوة مسبقًا؛ لم يتغير شيء.",
      INVALID_TRANSITION:
        "لم يعد هذا الطلب يسمح بهذا الإجراء. حدّث الصفحة وراجع حالته.",
      INVALID_REASON: "سبب الإلغاء مطلوب من ٣ إلى ٣٠٠ حرف.",
      INVALID_INPUT: "معرّف الطلب غير صالح.",
      NOT_FOUND: "لم يُعثر على الطلب داخل متجرك.",
      DENIED: "انتهت صلاحية جلسة التاجر. سجّل الدخول مرة أخرى.",
      UNAVAILABLE: "عمليات الطلبات غير متاحة حاليًا.",
      DATABASE_ERROR: "تعذّر حفظ التغيير. حاول مرة أخرى.",
      NETWORK: "تعذّر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.",
    },
  },
  en: {
    nextAction: "Next action",
    accept: "Accept order",
    prepare: "Start preparing",
    handToShipping: "Hand to shipping",
    deliver: "Mark delivered",
    collectCod: "Record COD collection",
    working: "Saving…",
    preparingNote: "This order is prepared and waiting to be handed to shipping.",
    shippedNote: "The order is with shipping. Mark it delivered once the buyer receives it.",
    deliveredNote: "The order is delivered. Record the collection after cash is received.",
    collectedNote: "Delivered and cash collected. This order is complete.",
    cancelledNote: "This order is cancelled and its stock reservation was released.",
    shippingTitle: "Hand this order to shipping",
    shippingHint:
      "This commits the reservation and removes the shipped quantity from on-hand stock. This step cannot be undone.",
    confirmShipping: "Confirm hand to shipping",
    keepPreparing: "Not yet",
    collectionTitle: "Record cash-on-delivery collection",
    collectionHint:
      "Confirm only after you received the cash. This changes payment state only; stock and delivery do not change.",
    confirmCollection: "Confirm cash received",
    keepAwaiting: "Not collected yet",
    cancel: "Cancel order",
    cancelTitle: "Cancel before shipping",
    cancelHint:
      "This releases the held stock without changing on-hand stock. Add a clear reason.",
    reasonLabel: "Cancellation reason",
    reasonPlaceholder: "Why is this order being cancelled?",
    confirmCancel: "Confirm cancellation",
    keepOrder: "Keep order",
    reasonRequired: "Enter a reason of 3–300 characters.",
    readOnlyNote:
      "You can review this order only. Accept, prepare, shipping, delivery, collection and cancel are unavailable until a platform administrator reactivates the store.",
    localisation: {
      ACCEPTED: "Order accepted.",
      PREPARED: "Order marked as preparing.",
      HANDED_TO_SHIPPING:
        "Order handed to shipping and stock committed exactly once.",
      DELIVERED: "Order delivery recorded.",
      COLLECTED: "Cash-on-delivery collection recorded.",
      CANCELLED: "Order cancelled and the reservation released once.",
      ALREADY_APPLIED: "This step was already completed; nothing changed.",
      INVALID_TRANSITION:
        "This order can no longer take that action. Refresh and check its state.",
      INVALID_REASON: "A cancellation reason of 3–300 characters is required.",
      INVALID_INPUT: "The order identifier is invalid.",
      NOT_FOUND: "The order was not found in your store.",
      DENIED: "Your merchant session is no longer valid. Sign in again.",
      UNAVAILABLE: "Order operations are unavailable.",
      DATABASE_ERROR: "The change could not be saved. Try again.",
      NETWORK: "Could not reach the server. Check the network and try again.",
    },
  },
};

type Feedback = {
  tone: "success" | "info" | "error";
  text: string;
};

type PendingAction = MerchantOrderNextAction | "cancel" | null;
type Confirmation = "hand_to_shipping" | "collect_cod" | null;

export function MerchantOrderActions({
  orderId,
  status,
  fulfillmentStatus,
  paymentStatus,
  cancellationReason,
  total,
  currency,
  locale,
  readOnly,
}: {
  orderId: string;
  status: string;
  fulfillmentStatus: string;
  paymentStatus: string;
  cancellationReason: string | null;
  total: string;
  currency: string;
  locale: MerchantLocale;
  readOnly: boolean;
}) {
  const copy = COPY[locale];
  const router = useRouter();
  const reasonId = useId();
  const reasonHintId = useId();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [isPending, startTransition] = useTransition();
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const nextAction = nextMerchantOrderAction(
    status,
    fulfillmentStatus,
    paymentStatus,
  );
  const canCancel = canCancelMerchantOrder(status, fulfillmentStatus);

  if (readOnly) {
    return (
      <section
        className="space-y-3 rounded-lg border border-border bg-background p-3"
        data-testid="merchant-order-actions"
        data-order-status={status}
        data-read-only="true"
      >
        {status === "cancelled" && cancellationReason ? (
          <div
            className="rounded-lg border border-border bg-muted/50 p-3 text-sm"
            data-testid="merchant-order-cancelled-note"
          >
            <p className="text-xs text-muted-foreground">{copy.reasonLabel}</p>
            <p className="break-words font-medium">{cancellationReason}</p>
          </div>
        ) : null}
        <p
          className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          data-testid="merchant-order-readonly-note"
        >
          {copy.readOnlyNote}
        </p>
      </section>
    );
  }

  function applyResult(
    result: MerchantOrderActionState,
    closeCancelForm: boolean,
  ): boolean {
    if (!result.success) {
      setFeedback({
        tone: "error",
        text: copy.localisation[result.code] ?? copy.localisation.DATABASE_ERROR,
      });
      return false;
    }

    const quantity = result.shippedQuantity ?? 0;
    const text =
      result.code === "HANDED_TO_SHIPPING" && quantity > 0
        ? locale === "ar"
          ? `تم تسليم ${quantity} قطعة للشحن وتثبيت المخزون مرة واحدة.`
          : `Handed ${quantity} ${quantity === 1 ? "unit" : "units"} to shipping and committed stock exactly once.`
        : copy.localisation[result.code] ?? copy.localisation.ALREADY_APPLIED;

    setFeedback({
      tone: result.code === "ALREADY_APPLIED" ? "info" : "success",
      text,
    });

    if (closeCancelForm) {
      setIsCancelOpen(false);
      setReason("");
      setReasonError(null);
    }

    setConfirmation(null);
    router.refresh();
    return true;
  }

  function runAction(action: Exclude<PendingAction, null>) {
    if (isPending) return;

    setFeedback(null);
    setPendingAction(action);

    startTransition(async () => {
      try {
        const result =
          action === "accept"
            ? await acceptMerchantOrderAction(orderId)
            : action === "prepare"
              ? await prepareMerchantOrderAction(orderId)
              : action === "hand_to_shipping"
                ? await handMerchantOrderToShippingAction(orderId)
                : action === "deliver"
                  ? await markMerchantOrderDeliveredAction(orderId)
                  : action === "collect_cod"
                    ? await collectMerchantOrderPaymentAction(orderId)
                    : await cancelMerchantOrderAction({ orderId, reason });
        applyResult(result, action === "cancel");
      } catch {
        setFeedback({ tone: "error", text: copy.localisation.NETWORK });
      } finally {
        setPendingAction(null);
      }
    });
  }

  function choosePrimaryAction(action: MerchantOrderNextAction) {
    if (action === "hand_to_shipping" || action === "collect_cod") {
      setFeedback(null);
      setIsCancelOpen(false);
      setConfirmation(action);
      return;
    }

    runAction(action);
  }

  function submitCancellation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = reason.trim();
    if (
      trimmed.length < CANCELLATION_REASON_MIN_LENGTH ||
      trimmed.length > CANCELLATION_REASON_MAX_LENGTH
    ) {
      setReasonError(copy.reasonRequired);
      return;
    }

    setReasonError(null);
    runAction("cancel");
  }

  const busyLabel = isPending ? copy.working : null;
  const primaryLabel = nextAction
    ? nextAction === "accept"
      ? copy.accept
      : nextAction === "prepare"
        ? copy.prepare
        : nextAction === "hand_to_shipping"
          ? copy.handToShipping
          : nextAction === "deliver"
            ? copy.deliver
            : copy.collectCod
    : null;

  const stateNote =
    status === "cancelled"
      ? copy.cancelledNote
      : fulfillmentStatus === "handed_to_shipping"
        ? copy.shippedNote
        : fulfillmentStatus === "delivered" && paymentStatus === "collected"
          ? copy.collectedNote
          : fulfillmentStatus === "delivered"
            ? copy.deliveredNote
            : status === "preparing"
              ? copy.preparingNote
              : "";

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-background p-3"
      data-testid="merchant-order-actions"
      data-order-status={status}
      data-fulfillment-status={fulfillmentStatus}
      data-payment-status={paymentStatus}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {copy.nextAction}
        </p>
        <span className="text-xs text-muted-foreground">{stateNote}</span>
      </div>

      {nextAction && confirmation === null ? (
        <Button
          type="button"
          className="min-h-11 w-full touch-manipulation gap-2 sm:w-auto"
          onClick={() => choosePrimaryAction(nextAction)}
          disabled={isPending}
          data-testid={`merchant-order-action-${nextAction}`}
        >
          {isPending && pendingAction === nextAction ? (
            <Loader2 className="size-4 animate-spin" />
          ) : nextAction === "accept" || nextAction === "deliver" ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <PackageCheck className="size-4" />
          )}
          {busyLabel ?? primaryLabel}
        </Button>
      ) : null}

      {confirmation === "hand_to_shipping" ? (
        <div
          className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
          data-testid="merchant-order-shipping-confirm"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">{copy.shippingTitle}</p>
            <p className="text-xs text-muted-foreground">
              {copy.shippingHint}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="min-h-11 w-full touch-manipulation gap-2 sm:w-auto"
              onClick={() => runAction("hand_to_shipping")}
              disabled={isPending}
              data-testid="merchant-order-shipping-submit"
            >
              {isPending && pendingAction === "hand_to_shipping" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <PackageCheck className="size-4" />
              )}
              {isPending && pendingAction === "hand_to_shipping"
                ? copy.working
                : copy.confirmShipping}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full touch-manipulation sm:w-auto"
              onClick={() => setConfirmation(null)}
              disabled={isPending}
              data-testid="merchant-order-shipping-cancel"
            >
              {copy.keepPreparing}
            </Button>
          </div>
        </div>
      ) : null}

      {confirmation === "collect_cod" ? (
        <div
          className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
          data-testid="merchant-order-collection-confirm"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">{copy.collectionTitle}</p>
            <p className="text-xs text-muted-foreground">
              {copy.collectionHint}
            </p>
            <p className="text-sm font-semibold">
              {total} {currency}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="min-h-11 w-full touch-manipulation gap-2 sm:w-auto"
              onClick={() => runAction("collect_cod")}
              disabled={isPending}
              data-testid="merchant-order-collection-submit"
            >
              {isPending && pendingAction === "collect_cod" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <PackageCheck className="size-4" />
              )}
              {isPending && pendingAction === "collect_cod"
                ? copy.working
                : copy.confirmCollection}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full touch-manipulation sm:w-auto"
              onClick={() => setConfirmation(null)}
              disabled={isPending}
              data-testid="merchant-order-collection-cancel"
            >
              {copy.keepAwaiting}
            </Button>
          </div>
        </div>
      ) : null}

      {canCancel && !isCancelOpen && confirmation === null ? (
        <Button
          type="button"
          variant="destructive"
          className="min-h-11 w-full touch-manipulation gap-2 sm:w-auto"
          onClick={() => {
            setIsCancelOpen(true);
            setReasonError(null);
            setFeedback(null);
          }}
          disabled={isPending}
          data-testid="merchant-order-action-cancel"
        >
          <XCircle className="size-4" />
          {copy.cancel}
        </Button>
      ) : null}

      {canCancel && isCancelOpen ? (
        <form
          className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          onSubmit={submitCancellation}
          data-testid="merchant-order-cancel-form"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">{copy.cancelTitle}</p>
            <p className="text-xs text-muted-foreground">{copy.cancelHint}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={reasonId} className="text-sm font-medium">
              {copy.reasonLabel}
            </label>
            <textarea
              id={reasonId}
              name="reason"
              required
              minLength={CANCELLATION_REASON_MIN_LENGTH}
              maxLength={CANCELLATION_REASON_MAX_LENGTH}
              rows={3}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (reasonError) setReasonError(null);
              }}
              placeholder={copy.reasonPlaceholder}
              aria-describedby={reasonHintId}
              aria-invalid={reasonError ? true : undefined}
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
              data-testid="merchant-order-cancel-reason"
            />
            <p id={reasonHintId} className="text-xs text-muted-foreground">
              {copy.reasonRequired}
            </p>
            {reasonError ? (
              <p role="alert" className="text-xs text-destructive">
                {reasonError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="submit"
              variant="destructive"
              className="min-h-11 w-full touch-manipulation gap-2 sm:w-auto"
              disabled={isPending}
              data-testid="merchant-order-cancel-submit"
            >
              {isPending && pendingAction === "cancel" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <XCircle className="size-4" />
              )}
              {isPending && pendingAction === "cancel"
                ? copy.working
                : copy.confirmCancel}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full touch-manipulation sm:w-auto"
              onClick={() => {
                setIsCancelOpen(false);
                setReasonError(null);
              }}
              disabled={isPending}
              data-testid="merchant-order-cancel-keep"
            >
              {copy.keepOrder}
            </Button>
          </div>
        </form>
      ) : null}

      {status === "cancelled" && cancellationReason ? (
        <div
          className="rounded-lg border border-border bg-muted/50 p-3 text-sm"
          data-testid="merchant-order-cancelled-note"
        >
          <p className="text-xs text-muted-foreground">{copy.reasonLabel}</p>
          <p className="break-words font-medium">{cancellationReason}</p>
        </div>
      ) : null}

      {feedback ? (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={
            feedback.tone === "error"
              ? "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
              : "flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-400"
          }
          data-testid={
            feedback.tone === "error"
              ? "merchant-order-action-error"
              : "merchant-order-action-feedback"
          }
        >
          {feedback.tone === "error" ? (
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          )}
          <span className="flex-1 break-words">{feedback.text}</span>
        </div>
      ) : null}
    </section>
  );
}
