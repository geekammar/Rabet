"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  reconcileSellerOperationAction,
  sendSellerReplyAction,
} from "@/app/actions/inquiries";

const MAX_TELEGRAM_MESSAGE_CHARS = 4096;

function safeSessionStorageGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionStorageSet(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeSessionStorageRemove(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function checkStorageAvailability(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const test = "__rabet_storage_test__";
    sessionStorage.setItem(test, "1");
    sessionStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

function verifyStorageOperationMatches(key: string, expectedId: string): boolean {
  const raw = safeSessionStorageGet(key);
  if (!raw) return true;
  try {
    const parsed = JSON.parse(raw);
    return parsed.id === expectedId;
  } catch {
    return false;
  }
}

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

  const isStorageAvailable = typeof window !== "undefined" && checkStorageAvailability();

  const [body, setBody] = useState<string>(() => {
    return safeSessionStorageGet(`rabet_draft_inquiry_${inquiryId}`) ?? "";
  });

  const [boundOp, setBoundOp] = useState<BoundOperation | null>(() => {
    const raw = safeSessionStorageGet(`rabet_bound_op_${inquiryId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  const [unresolvedOp, setUnresolvedOp] = useState<UnresolvedOperation | null>(() => {
    const raw = safeSessionStorageGet(`rabet_unresolved_op_${inquiryId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
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

  const inFlightOpRef = useRef<{ id: string; body: string } | null>(null);
  const reconciliationEpochRef = useRef<number>(0);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [duplicationRiskAcknowledged, setDuplicationRiskAcknowledged] = useState(false);

  // Mount effect: Reconcile unresolved operation if restored from browser storage
  useEffect(() => {
    const targetUnresolved = unresolvedOpRef.current;
    if (!targetUnresolved) return;
    const targetInquiryId = inquiryId;
    const targetOpId = targetUnresolved.id;
    const targetOpBody = targetUnresolved.body;
    const epoch = ++reconciliationEpochRef.current;

    let cancelled = false;
    async function reconcileOnMount() {
      try {
        const res = await reconcileSellerOperationAction({
          inquiryId: targetInquiryId,
          operationId: targetOpId,
        });
        if (cancelled) return;
        // Verify this result still belongs to the active reconciliation target
        if (reconciliationEpochRef.current !== epoch) return;
        if (inquiryId !== targetInquiryId) return;
        if (
          boundOpRef.current?.id !== targetOpId &&
          unresolvedOpRef.current?.id !== targetOpId
        ) {
          return;
        }

        if (res.success && res.found) {
          if (res.outcome === "confirmed_sent") {
            if (boundOpRef.current?.id === targetOpId) setBoundOp(null);
            if (unresolvedOpRef.current?.id === targetOpId) setUnresolvedOp(null);
            if (verifyStorageOperationMatches(boundOpKey, targetOpId)) {
              safeSessionStorageRemove(boundOpKey);
            }
            if (verifyStorageOperationMatches(unresolvedOpKey, targetOpId)) {
              safeSessionStorageRemove(unresolvedOpKey);
            }
            setBody((cur) => {
              if (cur === targetOpBody) {
                if (safeSessionStorageGet(storageKey) === targetOpBody) {
                  safeSessionStorageRemove(storageKey);
                }
                return "";
              }
              return cur;
            });
            setWarningMessage(null);
            setSuccessNotice("Earlier reply was confirmed delivered to the customer.");
            onReplySuccess?.();
          } else if (res.outcome === "confirmed_failed") {
            const failedBound: BoundOperation = {
              id: targetOpId,
              body: targetOpBody,
              status: "failed",
            };
            if (boundOpRef.current?.id === targetOpId || !boundOpRef.current) {
              setBoundOp(failedBound);
              if (verifyStorageOperationMatches(boundOpKey, targetOpId)) {
                safeSessionStorageSet(boundOpKey, JSON.stringify(failedBound));
              }
            }
            if (unresolvedOpRef.current?.id === targetOpId) {
              setUnresolvedOp(null);
              if (verifyStorageOperationMatches(unresolvedOpKey, targetOpId)) {
                safeSessionStorageRemove(unresolvedOpKey);
              }
            }
            setWarningMessage(null);
            setErrorMessage(
              "Previous reply delivery failed. Use the Retry button in conversation history, or edit your draft to send a new reply.",
            );
            onReplySuccess?.();
          } else {
            // "unconfirmed_outcome" or "recorded_pending"
            setWarningMessage(
              "An earlier delivery attempt is unconfirmed and may have reached the customer. Sending an edited reply requires acknowledging the duplication risk.",
            );
          }
        } else if (res.success && !res.found) {
          // Absent from server: reservation never completed yet.
          // Keep exact operation ID and authored body.
          // Allow explicit retry of unchanged text using that same ID without generating a fresh UUID.
          const retryableBound: BoundOperation = {
            id: targetOpId,
            body: targetOpBody,
            status: "pending",
          };
          if (boundOpRef.current?.id === targetOpId || !boundOpRef.current) {
            setBoundOp(retryableBound);
            if (verifyStorageOperationMatches(boundOpKey, targetOpId)) {
              safeSessionStorageSet(boundOpKey, JSON.stringify(retryableBound));
            }
          }
          if (unresolvedOpRef.current?.id === targetOpId) {
            setUnresolvedOp(null);
            if (verifyStorageOperationMatches(unresolvedOpKey, targetOpId)) {
              safeSessionStorageRemove(unresolvedOpKey);
            }
          }
          setWarningMessage(
            "No record was found yet. Retrying will use the same submission ID.",
          );
        }
      } catch {
        // Read error does not prove absence; retain identity and warn safely.
        setWarningMessage(
          "Could not check status of the earlier delivery attempt. Draft and operation identity are preserved.",
        );
      }
    }

    reconcileOnMount();
    return () => {
      cancelled = true;
    };
  }, [inquiryId, boundOpKey, unresolvedOpKey, storageKey, onReplySuccess]);

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
          if (verifyStorageOperationMatches(boundOpKey, sourceMsgId)) {
            safeSessionStorageRemove(boundOpKey);
          }
          return null;
        }
        return cur;
      });

      setUnresolvedOp((cur) => {
        if (cur && cur.id === sourceMsgId) {
          if (verifyStorageOperationMatches(unresolvedOpKey, sourceMsgId)) {
            safeSessionStorageRemove(unresolvedOpKey);
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
          safeSessionStorageRemove(storageKey);
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

    // If text was reverted back to match unresolvedOp.body, reconnect boundOp so submission reuses unresolvedOp.id!
    if (unresolvedOp && text === unresolvedOp.body) {
      const reconnected: BoundOperation = {
        id: unresolvedOp.id,
        body: unresolvedOp.body,
        status: unresolvedOp.status,
      };
      setBoundOp(reconnected);
      safeSessionStorageSet(boundOpKey, JSON.stringify(reconnected));
    } else if (boundOp && boundOp.body !== text) {
      // If text was edited so it no longer matches the bound operation, detach the bound operation ID
      // but retain any unresolved uncertain operation identity separately
      setBoundOp(null);
      safeSessionStorageRemove(boundOpKey);
    }

    // Keep visible warning if there is an unresolved operation
    if (unresolvedOp && (unresolvedOp.status === "unconfirmed" || unresolvedOp.status === "pending")) {
      setWarningMessage(
        "An earlier delivery attempt is unconfirmed and may have reached the customer. Sending an edited reply requires acknowledging the duplication risk.",
      );
    } else {
      setWarningMessage(null);
    }

    if (text.length === 0) {
      safeSessionStorageRemove(storageKey);
      safeSessionStorageRemove(boundOpKey);
      setBoundOp(null);
    } else {
      safeSessionStorageSet(storageKey, text);
    }
  }

  // Manual reconciliation handler
  async function handleManualReconcile() {
    const targetOp = unresolvedOpRef.current;
    if (!targetOp || isCheckingStatus) return;
    const targetInquiryId = inquiryId;
    const targetOpId = targetOp.id;
    const targetOpBody = targetOp.body;
    const epoch = ++reconciliationEpochRef.current;

    setIsCheckingStatus(true);
    try {
      const res = await reconcileSellerOperationAction({
        inquiryId: targetInquiryId,
        operationId: targetOpId,
      });

      // Verify this result still belongs to the active reconciliation target
      if (reconciliationEpochRef.current !== epoch) return;
      if (inquiryId !== targetInquiryId) return;
      if (
        boundOpRef.current?.id !== targetOpId &&
        unresolvedOpRef.current?.id !== targetOpId
      ) {
        return;
      }

      if (res.success && res.found) {
        if (res.outcome === "confirmed_sent") {
          if (boundOpRef.current?.id === targetOpId) setBoundOp(null);
          if (unresolvedOpRef.current?.id === targetOpId) setUnresolvedOp(null);
          if (verifyStorageOperationMatches(boundOpKey, targetOpId)) {
            safeSessionStorageRemove(boundOpKey);
          }
          if (verifyStorageOperationMatches(unresolvedOpKey, targetOpId)) {
            safeSessionStorageRemove(unresolvedOpKey);
          }
          setBody((cur) => {
            if (cur === targetOpBody) {
              if (safeSessionStorageGet(storageKey) === targetOpBody) {
                safeSessionStorageRemove(storageKey);
              }
              return "";
            }
            return cur;
          });
          setWarningMessage(null);
          setSuccessNotice("Earlier reply was confirmed delivered to the customer.");
          onReplySuccess?.();
        } else if (res.outcome === "confirmed_failed") {
          const failedBound: BoundOperation = {
            id: targetOpId,
            body: targetOpBody,
            status: "failed",
          };
          if (boundOpRef.current?.id === targetOpId || !boundOpRef.current) {
            setBoundOp(failedBound);
            if (verifyStorageOperationMatches(boundOpKey, targetOpId)) {
              safeSessionStorageSet(boundOpKey, JSON.stringify(failedBound));
            }
          }
          if (unresolvedOpRef.current?.id === targetOpId) {
            setUnresolvedOp(null);
            if (verifyStorageOperationMatches(unresolvedOpKey, targetOpId)) {
              safeSessionStorageRemove(unresolvedOpKey);
            }
          }
          setWarningMessage(null);
          setErrorMessage(
            "Previous reply delivery failed. Use the Retry button in conversation history, or edit your draft to send a new reply.",
          );
          onReplySuccess?.();
        } else {
          setWarningMessage(
            "Delivery status is still unconfirmed or in flight. The message may have reached the customer.",
          );
        }
      } else if (res.success && !res.found) {
        // Absent from server: keep exact operation ID and allow deliberate resend using original ID
        const retryableBound: BoundOperation = {
          id: targetOpId,
          body: targetOpBody,
          status: "pending",
        };
        if (boundOpRef.current?.id === targetOpId || !boundOpRef.current) {
          setBoundOp(retryableBound);
          if (verifyStorageOperationMatches(boundOpKey, targetOpId)) {
            safeSessionStorageSet(boundOpKey, JSON.stringify(retryableBound));
          }
        }
        if (unresolvedOpRef.current?.id === targetOpId) {
          setUnresolvedOp(null);
          if (verifyStorageOperationMatches(unresolvedOpKey, targetOpId)) {
            safeSessionStorageRemove(unresolvedOpKey);
          }
        }
        setWarningMessage(
          "No record was found yet. Retrying will use the same submission ID.",
        );
      } else {
        setWarningMessage(
          "Could not check status due to a server error. Your draft and operation identity are preserved.",
        );
      }
    } catch {
      setWarningMessage(
        "Could not check status due to a network error. Your draft and operation identity are preserved.",
      );
    } finally {
      setIsCheckingStatus(false);
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

      // 2. If the bound operation is unconfirmed AND unresolvedOp is still bound to it, require explicit decision
      if (boundOp.status === "unconfirmed" && unresolvedOp && unresolvedOp.id === boundOp.id) {
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
      (unresolvedOp.status === "unconfirmed" || unresolvedOp.status === "pending") &&
      currentBody !== unresolvedOp.body &&
      !duplicationRiskAcknowledged
    ) {
      setWarningMessage(
        "An earlier delivery attempt is unconfirmed and may have reached the customer. Confirm duplication risk below to send this edited message.",
      );
      return;
    }

    // Determine operation ID:
    // If repeating unchanged pending or unconfirmed submission, reuse its operation ID.
    // If text matches unresolvedOp.body, reuse unresolvedOp.id.
    // Otherwise, generate a fresh stable UUID.
    let opId: string;
    if (
      boundOp &&
      boundOp.body === currentBody &&
      (boundOp.status === "pending" || boundOp.status === "unconfirmed")
    ) {
      opId = boundOp.id;
    } else if (unresolvedOp && unresolvedOp.body === currentBody) {
      opId = unresolvedOp.id;
    } else {
      opId = crypto.randomUUID();
    }

    // Invalidate any in-flight asynchronous reconciliation checks from previous operations
    reconciliationEpochRef.current++;

    // PERSIST OPERATION IDENTITY BEFORE DISPATCH
    // Synchronously bind and persist operation identity so page reloads or crashes preserve it
    const preDispatchBound: BoundOperation = {
      id: opId,
      body: currentBody,
      status: "pending",
    };
    const preDispatchUnresolved: UnresolvedOperation = {
      id: opId,
      body: currentBody,
      status: "pending",
    };

    boundOpRef.current = preDispatchBound;
    unresolvedOpRef.current = preDispatchUnresolved;
    inFlightOpRef.current = { id: opId, body: currentBody };

    setBoundOp(preDispatchBound);
    setUnresolvedOp(preDispatchUnresolved);

    safeSessionStorageSet(storageKey, currentBody);
    safeSessionStorageSet(boundOpKey, JSON.stringify(preDispatchBound));
    safeSessionStorageSet(unresolvedOpKey, JSON.stringify(preDispatchUnresolved));

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
        setUnresolvedOp(null);
        inFlightOpRef.current = null;
        safeSessionStorageRemove(boundOpKey);
        safeSessionStorageRemove(unresolvedOpKey);
        setErrorMessage(
          result.message || "Failed to process reply before reservation.",
        );
        return;
      }

      if (result.outcome === "confirmed_sent") {
        // Confirmed sent: clear draft from sessionStorage and composer state
        setBody((cur) => {
          if (cur === currentBody) {
            safeSessionStorageRemove(storageKey);
            safeSessionStorageRemove(boundOpKey);
            safeSessionStorageRemove(unresolvedOpKey);
            setBoundOp(null);
            setUnresolvedOp(null);
            inFlightOpRef.current = null;
            return "";
          }
          return cur;
        });

        setDuplicationRiskAcknowledged(false);
        setSuccessNotice(result.message || "Reply sent successfully.");
      } else if (result.outcome === "recorded_pending") {
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
        safeSessionStorageSet(boundOpKey, JSON.stringify(pendingBound));
        safeSessionStorageSet(unresolvedOpKey, JSON.stringify(pendingBound));
        setSuccessNotice(
          result.message || "Reply is in flight. Waiting for delivery confirmation.",
        );
      } else if (result.outcome === "unconfirmed_outcome") {
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
        safeSessionStorageSet(boundOpKey, JSON.stringify(unconfirmedBound));
        safeSessionStorageSet(unresolvedOpKey, JSON.stringify(unconfirmedBound));
        setWarningMessage(
          result.message ||
            "Delivery outcome could not be confirmed. The message may have reached the customer.",
        );
      } else if (result.outcome === "confirmed_failed") {
        // Explicit confirmed failure: preserve draft and mark bound operation as failed
        const failedBound: BoundOperation = {
          id: opId,
          body: currentBody,
          status: "failed",
        };
        setBoundOp(failedBound);
        setUnresolvedOp(null);
        safeSessionStorageSet(boundOpKey, JSON.stringify(failedBound));
        safeSessionStorageRemove(unresolvedOpKey);
        setErrorMessage(
          result.message ||
            "Reply was recorded but delivery failed. Use the Retry button in conversation history to retry, or edit your draft to send a new reply.",
        );
      } else {
        // Generic unknown outcome: retain stable identity as unconfirmed; do NOT mark saved failed
        const genericUncertainBound: BoundOperation = {
          id: opId,
          body: currentBody,
          status: "unconfirmed",
        };
        setBoundOp(genericUncertainBound);
        setUnresolvedOp({
          id: opId,
          body: currentBody,
          status: "unconfirmed",
        });
        safeSessionStorageSet(boundOpKey, JSON.stringify(genericUncertainBound));
        safeSessionStorageSet(unresolvedOpKey, JSON.stringify(genericUncertainBound));
        setWarningMessage(
          result.message ||
            "Submission outcome could not be verified. Your draft and operation identity are preserved. Check status before resending.",
        );
      }
    } catch {
      // Server outcome unknown: preserve stable operation identity as unconfirmed
      const networkUncertainBound: BoundOperation = {
        id: opId,
        body: currentBody,
        status: "unconfirmed",
      };
      setBoundOp(networkUncertainBound);
      setUnresolvedOp({
        id: opId,
        body: currentBody,
        status: "unconfirmed",
      });
      safeSessionStorageSet(boundOpKey, JSON.stringify(networkUncertainBound));
      safeSessionStorageSet(unresolvedOpKey, JSON.stringify(networkUncertainBound));
      setWarningMessage(
        "A network error occurred while communicating with the server. Your draft and operation identity are preserved. Check status before resending.",
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
      {!isStorageAvailable ? (
        <div
          data-testid="storage-unavailable-notice"
          className="rounded-lg border border-muted bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          Browser storage is unavailable. Draft saving and reload recovery are disabled in this session.
        </div>
      ) : null}

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
          className="flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1 break-words">{warningMessage}</span>
          </div>
          {unresolvedOp ? (
            <div className="flex items-center gap-2 pl-6">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="check-status-button"
                disabled={isCheckingStatus || isSubmitting}
                onClick={handleManualReconcile}
                className="h-7 text-xs px-2.5"
              >
                {isCheckingStatus ? (
                  <>
                    <Loader2 className="mr-1 size-3 animate-spin" />
                    Checking...
                  </>
                ) : (
                  "Check status"
                )}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {unresolvedOp &&
      (unresolvedOp.status === "unconfirmed" || unresolvedOp.status === "pending") &&
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
