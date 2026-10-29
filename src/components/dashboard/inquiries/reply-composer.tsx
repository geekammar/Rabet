"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { sendSellerReplyAction } from "@/app/actions/inquiries";

const MAX_TELEGRAM_MESSAGE_CHARS = 4096;

interface BoundOperation {
  id: string;
  body: string;
  status?: "pending" | "failed" | "unconfirmed";
}

interface UnresolvedOperation {
  id: string;
  body: string;
  status: "pending" | "unconfirmed";
}

interface ReplyComposerProps {
  inquiryId: string;
  reference: string;
  isBlocked?: boolean;
  isActive: boolean;
  onReplySuccess?: () => void;
}

export function ReplyComposer({
  inquiryId,
  reference,
  isBlocked = false,
  isActive,
  onReplySuccess,
}: ReplyComposerProps) {
  const prefix = `[${reference}]\n\n`;
  const maxBodyChars = MAX_TELEGRAM_MESSAGE_CHARS - prefix.length;

  const storageKey = `rabet_draft_inquiry_${inquiryId}`;
  const boundOpKey = `rabet_bound_op_${inquiryId}`;
  const unresolvedOpKey = `rabet_unresolved_op_${inquiryId}`;

  const [body, setBody] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return sessionStorage.getItem(`rabet_draft_inquiry_${inquiryId}`) ?? "";
    } catch {
      return "";
    }
  });

  const [boundOp, setBoundOp] = useState<BoundOperation | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(`rabet_bound_op_${inquiryId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const [unresolvedOp, setUnresolvedOp] = useState<UnresolvedOperation | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(`rabet_unresolved_op_${inquiryId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const boundOpRef = useRef<BoundOperation | null>(boundOp);
  useEffect(() => {
    boundOpRef.current = boundOp;
  }, [boundOp]);

  const unresolvedOpRef = useRef<UnresolvedOperation | null>(unresolvedOp);
  useEffect(() => {
    unresolvedOpRef.current = unresolvedOp;
  }, [unresolvedOp]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [duplicationRiskAcknowledged, setDuplicationRiskAcknowledged] = useState(false);

  // Listen for retry events from the message history to reconcile composer state
  useEffect(() => {
    function handleMessageRetried(e: Event) {
      const customEvent = e as CustomEvent<{
        inquiryId: string;
        sourceMessageId: string;
        retriedBody?: string;
      }>;
      if (customEvent.detail?.inquiryId !== inquiryId) return;

      const sourceMsgId = customEvent.detail?.sourceMessageId;
      const retriedBody = customEvent.detail?.retriedBody;

      // Reconcile bound / unresolved operation ONLY if sourceMessageId matches:
      setBoundOp((cur) => {
        if (cur && cur.id === sourceMsgId) {
          try {
            sessionStorage.removeItem(boundOpKey);
          } catch {
            // ignore
          }
          return null;
        }
        return cur;
      });

      setUnresolvedOp((cur) => {
        if (cur && cur.id === sourceMsgId) {
          try {
            sessionStorage.removeItem(unresolvedOpKey);
          } catch {
            // ignore
          }
          return null;
        }
        return cur;
      });

      // Reconcile draft ONLY if current body matches retriedBody EXACTLY (exact equality, not trimmed!)
      setBody((currentBody) => {
        if (
          boundOpRef.current?.id === sourceMsgId &&
          typeof retriedBody === "string" &&
          currentBody === retriedBody
        ) {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            // ignore
          }
          return "";
        }
        // Preserve newer edits (including whitespace-only changes)
        return currentBody;
      });

      setErrorMessage(null);
      setWarningMessage(null);
    }

    window.addEventListener("rabet:reply_retried", handleMessageRetried);
    return () => {
      window.removeEventListener("rabet:reply_retried", handleMessageRetried);
    };
  }, [inquiryId, storageKey, boundOpKey, unresolvedOpKey]);

  // Persist draft on edit and manage operation binding
  function handleBodyChange(text: string) {
    setBody(text);
    setErrorMessage(null);
    setSuccessNotice(null);

    // If text was edited so it no longer matches the bound operation, detach the bound operation ID
    // but retain any unresolved uncertain operation identity separately
    if (boundOp && boundOp.body !== text) {
      setBoundOp(null);
      try {
        sessionStorage.removeItem(boundOpKey);
      } catch {
        // ignore
      }
    }

    // Keep visible warning if there is an unresolved operation
    if (unresolvedOp && unresolvedOp.status === "unconfirmed") {
      setWarningMessage(
        "An earlier delivery attempt is unconfirmed and may have reached the customer. Sending an edited reply requires acknowledging the duplication risk.",
      );
    } else {
      setWarningMessage(null);
    }

    try {
      if (text.length === 0) {
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(boundOpKey);
        setBoundOp(null);
      } else {
        sessionStorage.setItem(storageKey, text);
      }
    } catch {
      // ignore
    }
  }

  const remainingChars = maxBodyChars - body.length;
  const isOverLimit = remainingChars < 0;
  const isBlank = body.trim().length === 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Synchronous guard against double-clicks and invalid inputs
    if (
      isSubmittingRef.current ||
      isSubmitting ||
      isBlank ||
      isOverLimit ||
      !isActive ||
      isBlocked
    ) {
      return;
    }

    setErrorMessage(null);
    setWarningMessage(null);
    setSuccessNotice(null);

    const currentBody = body;

    // Check if the current body matches a previously submitted operation
    if (boundOp && boundOp.body === currentBody) {
      // 1. If the bound operation previously failed delivery, do not automatically resend through composer
      if (boundOp.status === "failed") {
        setErrorMessage(
          "This reply was already recorded and delivery failed. Use the Retry button in conversation history to retry it, or edit your draft to send a new message.",
        );
        onReplySuccess?.();
        return;
      }

      // 2. If the bound operation is unconfirmed, show duplication warning and require explicit seller action
      if (boundOp.status === "unconfirmed") {
        setWarningMessage(
          "A previous delivery attempt with this exact text is unconfirmed and may have reached the customer. Sending again may cause duplicate messages. Edit your message to send as a new reply.",
        );
        onReplySuccess?.();
        return;
      }
    }

    // If text was edited while an unresolved uncertain operation exists, require explicit duplication-risk decision
    if (
      unresolvedOp &&
      unresolvedOp.status === "unconfirmed" &&
      currentBody !== unresolvedOp.body &&
      !duplicationRiskAcknowledged
    ) {
      setWarningMessage(
        "An earlier delivery attempt is unconfirmed and may have reached the customer. Confirm duplication risk below to send this edited message.",
      );
      return;
    }

    // Determine operation ID:
    // If repeating unchanged pending submission, reuse its operation ID.
    // Otherwise, generate a fresh stable UUID.
    let opId: string;
    if (boundOp && boundOp.body === currentBody && boundOp.status === "pending") {
      opId = boundOp.id;
    } else if (unresolvedOp && unresolvedOp.body === currentBody && unresolvedOp.status === "pending") {
      opId = unresolvedOp.id;
    } else {
      opId = crypto.randomUUID();
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);

    try {
      const result = await sendSellerReplyAction({
        inquiryId,
        body: currentBody,
        clientOperationId: opId,
      });

      // Always trigger message history reconciliation even on delivery failure
      onReplySuccess?.();

      if (result.reserved === false) {
        // Pre-reservation failure (e.g. invalid input, missing bot configuration):
        // NO reservation was created in the database. Draft remains editable and NOT bound to a failed operation.
        setBoundOp(null);
        try {
          sessionStorage.removeItem(boundOpKey);
        } catch {
          // ignore
        }
        setErrorMessage(
          result.message || "Failed to process reply before reservation.",
        );
        return;
      }

      if (result.outcome === "confirmed_sent") {
        // Confirmed sent: clear draft from sessionStorage and composer state
        setBody((cur) => {
          if (cur === currentBody) {
            try {
              sessionStorage.removeItem(storageKey);
              sessionStorage.removeItem(boundOpKey);
              sessionStorage.removeItem(unresolvedOpKey);
            } catch {
              // ignore
            }
            setBoundOp(null);
            setUnresolvedOp(null);
            return "";
          }
          return cur;
        });

        setDuplicationRiskAcknowledged(false);
        setSuccessNotice(result.message || "Reply sent successfully.");
      } else if (result.outcome === "recorded_pending") {
        // Recorded/pending: keep draft and update bound operation
        const pendingBound: BoundOperation = {
          id: opId,
          body: currentBody,
          status: "pending",
        };
        setBoundOp(pendingBound);
        setUnresolvedOp({
          id: opId,
          body: currentBody,
          status: "pending",
        });
        try {
          sessionStorage.setItem(boundOpKey, JSON.stringify(pendingBound));
          sessionStorage.setItem(unresolvedOpKey, JSON.stringify(pendingBound));
        } catch {
          // ignore
        }
        setSuccessNotice(
          result.message || "Reply is in flight. Waiting for delivery confirmation.",
        );
      } else if (result.outcome === "unconfirmed_outcome") {
        // Unconfirmed outcome: preserve draft and show duplication risk warning
        const unconfirmedBound: BoundOperation = {
          id: opId,
          body: currentBody,
          status: "unconfirmed",
        };
        setBoundOp(unconfirmedBound);
        setUnresolvedOp({
          id: opId,
          body: currentBody,
          status: "unconfirmed",
        });
        try {
          sessionStorage.setItem(boundOpKey, JSON.stringify(unconfirmedBound));
          sessionStorage.setItem(unresolvedOpKey, JSON.stringify(unconfirmedBound));
        } catch {
          // ignore
        }
        setWarningMessage(
          result.message ||
            "Delivery outcome could not be confirmed. The message may have reached the customer.",
        );
      } else {
        // Confirmed delivery rejection/failure: preserve draft and update bound operation as failed
        const failedBound: BoundOperation = {
          id: opId,
          body: currentBody,
          status: "failed",
        };
        setBoundOp(failedBound);
        // Confirmed failure means it did not deliver, so clear unresolved uncertainty
        setUnresolvedOp(null);
        try {
          sessionStorage.setItem(boundOpKey, JSON.stringify(failedBound));
          sessionStorage.removeItem(unresolvedOpKey);
        } catch {
          // ignore
        }
        setErrorMessage(
          result.message ||
            "Reply was recorded but delivery failed. Use the Retry button in conversation history to retry, or edit your draft to send a new reply.",
        );
      }
    } catch {
      // Server outcome unknown: preserve stable operation identity
      const uncertainBound: BoundOperation = {
        id: opId,
        body: currentBody,
        status: "unconfirmed",
      };
      setBoundOp(uncertainBound);
      setUnresolvedOp({
        id: opId,
        body: currentBody,
        status: "unconfirmed",
      });
      try {
        sessionStorage.setItem(boundOpKey, JSON.stringify(uncertainBound));
        sessionStorage.setItem(unresolvedOpKey, JSON.stringify(uncertainBound));
      } catch {
        // ignore
      }
      setErrorMessage(
        "A network error occurred while communicating with the server. Your draft has been preserved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (isBlocked) {
    return (
      <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-center text-sm text-destructive">
        This customer has blocked the bot or is deactivated. Replies cannot be sent.
      </div>
    );
  }

  if (!isActive) {
    return (
      <div className="rounded-xl border border-muted bg-muted/40 p-4 text-center text-sm text-muted-foreground">
        This conversation is not active. Reopen the thread to send replies.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {errorMessage ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1 break-words">{errorMessage}</span>
        </div>
      ) : null}

      {warningMessage ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1 break-words">{warningMessage}</span>
        </div>
      ) : null}

      {unresolvedOp &&
      unresolvedOp.status === "unconfirmed" &&
      body !== unresolvedOp.body ? (
        <div
          data-testid="duplication-risk-banner"
          className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
        >
          <input
            type="checkbox"
            id="confirm-duplication-risk"
            data-testid="confirm-duplication-risk"
            checked={duplicationRiskAcknowledged}
            onChange={(e) => setDuplicationRiskAcknowledged(e.target.checked)}
            className="size-4 rounded border-amber-500 text-primary focus:ring-primary shrink-0"
          />
          <label
            htmlFor="confirm-duplication-risk"
            className="cursor-pointer select-none leading-tight"
          >
            I understand an earlier message may have arrived and acknowledge the duplication risk for this edited reply.
          </label>
        </div>
      ) : null}

      {successNotice ? (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-400"
        >
          {successNotice}
        </div>
      ) : null}

      <div className="relative rounded-lg border bg-background focus-within:ring-2 focus-within:ring-primary/40">
        <textarea
          value={body}
          onChange={(e) => handleBodyChange(e.target.value)}
          placeholder="Write a plain-text reply to the customer..."
          disabled={isSubmitting}
          dir="auto"
          rows={3}
          className="w-full resize-y rounded-lg bg-transparent p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none min-h-[90px] max-h-[300px]"
        />

        <div className="flex flex-wrap items-center justify-between border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span
              className={
                isOverLimit
                  ? "font-semibold text-destructive"
                  : remainingChars < 100
                    ? "font-medium text-amber-600"
                    : ""
              }
            >
              {remainingChars} chars remaining
            </span>
            <span className="hidden sm:inline text-muted-foreground/60">
              • Delivered with [{reference}]
            </span>
          </div>

          <Button
            type="submit"
            size="sm"
            disabled={isSubmitting || isBlank || isOverLimit}
            className="min-h-[44px] min-w-[100px] gap-1.5 touch-manipulation"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Sending
              </>
            ) : (
              <>
                <Send className="size-3.5" />
                Send Reply
              </>
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
