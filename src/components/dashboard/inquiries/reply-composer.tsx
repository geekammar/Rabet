"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { sendSellerReplyAction } from "@/app/actions/inquiries";

const MAX_TELEGRAM_MESSAGE_CHARS = 4096;

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
  const opIdStorageKey = `rabet_op_inquiry_${inquiryId}`;

  const [body, setBody] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return sessionStorage.getItem(`rabet_draft_inquiry_${inquiryId}`) ?? "";
    } catch {
      return "";
    }
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // Maintain a stable operation UUID per composed reply across submission retries
  const operationIdRef = useRef<string | null>(null);

  // Restore operation ID on mount if present
  useEffect(() => {
    try {
      const savedOpId = sessionStorage.getItem(opIdStorageKey);
      if (savedOpId) {
        operationIdRef.current = savedOpId;
      }
    } catch {
      // ignore
    }
  }, [opIdStorageKey]);

  // Persist draft on edit
  function handleBodyChange(text: string) {
    setBody(text);
    setErrorMessage(null);
    setSuccessNotice(null);

    // If composer was empty and user starts typing, initialize a new stable operation UUID
    if (!operationIdRef.current && text.trim().length > 0) {
      operationIdRef.current = crypto.randomUUID();
      try {
        sessionStorage.setItem(opIdStorageKey, operationIdRef.current);
      } catch {
        // ignore
      }
    }

    try {
      if (text.length === 0) {
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(opIdStorageKey);
        operationIdRef.current = null;
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

    if (isSubmitting || isBlank || isOverLimit || !isActive || isBlocked) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessNotice(null);

    // Ensure we have a stable operation UUID for this submission
    if (!operationIdRef.current) {
      operationIdRef.current = crypto.randomUUID();
      try {
        sessionStorage.setItem(opIdStorageKey, operationIdRef.current);
      } catch {
        // ignore
      }
    }

    const currentOperationId = operationIdRef.current;
    const submittedBody = body;

    try {
      const result = await sendSellerReplyAction({
        inquiryId,
        body: submittedBody,
        clientOperationId: currentOperationId,
      });

      if (!result.success) {
        // Keep draft intact on error so seller does not lose their typed message
        setErrorMessage(
          result.message || "Failed to deliver message. Your draft is preserved.",
        );
        setIsSubmitting(false);
        return;
      }

      // Reconcile draft: Only clear if the current input matches what was submitted
      setBody((current) => {
        if (current === submittedBody) {
          try {
            sessionStorage.removeItem(storageKey);
            sessionStorage.removeItem(opIdStorageKey);
          } catch {
            // ignore
          }
          operationIdRef.current = null;
          return "";
        }
        return current;
      });

      setSuccessNotice(result.message || "Reply dispatched.");
      setIsSubmitting(false);
      onReplySuccess?.();
    } catch {
      setErrorMessage(
        "A network or transport error occurred. Your draft has been preserved.",
      );
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
