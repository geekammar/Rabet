"use client";

import { useState } from "react";
import { CheckCircle2, Lock, Unlock, Loader2, AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { transitionInquiryStatusAction } from "@/app/actions/inquiries";

interface LifecycleActionsProps {
  inquiryId: string;
  status: "open" | "waiting_on_customer" | "resolved" | "closed";
  onStatusChanged?: () => void;
}

export function LifecycleActions({
  inquiryId,
  status,
  onStatusChanged,
}: LifecycleActionsProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleTransition(targetStatus: "open" | "resolved" | "closed") {
    if (isUpdating) return;

    setIsUpdating(true);
    setErrorMessage(null);

    try {
      const res = await transitionInquiryStatusAction({
        inquiryId,
        targetStatus,
      });

      if (!res.success) {
        setErrorMessage(res.message || "Failed to update inquiry status.");
      } else {
        onStatusChanged?.();
      }
    } catch {
      setErrorMessage("A network error occurred while updating status.");
    } finally {
      setIsUpdating(false);
    }
  }

  const canResolve = status === "open" || status === "waiting_on_customer";
  const canClose =
    status === "open" ||
    status === "waiting_on_customer" ||
    status === "resolved";
  const canReopen = status === "closed";

  return (
    <div className="flex flex-col gap-2">
      {errorMessage ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1 break-words">{errorMessage}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canResolve ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTransition("resolved")}
            disabled={isUpdating}
            className="min-h-[44px] min-w-[90px] gap-1.5 touch-manipulation"
          >
            {isUpdating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="size-3.5 text-sky-600" />
            )}
            Resolve
          </Button>
        ) : null}

        {canClose ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTransition("closed")}
            disabled={isUpdating}
            className="min-h-[44px] min-w-[90px] gap-1.5 touch-manipulation"
          >
            {isUpdating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Lock className="size-3.5" />
            )}
            Close
          </Button>
        ) : null}

        {canReopen ? (
          <Button
            variant="default"
            size="sm"
            onClick={() => handleTransition("open")}
            disabled={isUpdating}
            className="min-h-[44px] min-w-[100px] gap-1.5 touch-manipulation"
          >
            {isUpdating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Unlock className="size-3.5" />
            )}
            Reopen Thread
          </Button>
        ) : null}
      </div>
    </div>
  );
}
