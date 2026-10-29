"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  RefreshCw,
  User,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { retrySellerReplyAction } from "@/app/actions/inquiries";
import { cn } from "@/lib/utils";

export interface MessageItem {
  id: string;
  inquiryId: string;
  author: "customer" | "admin";
  body: string;
  telegramMessageId: number | null;
  deliveryStatus: "pending" | "sent" | "failed";
  deliveryError: string | null;
  deliveredAt: Date | string | null;
  createdAt: Date | string;
}

interface MessageListProps {
  inquiryId: string;
  messages: MessageItem[];
  isActive: boolean;
  onMessageRetried?: () => void;
}

export function MessageList({
  inquiryId,
  messages,
  isActive,
  onMessageRetried,
}: MessageListProps) {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retryingIdsRef = useRef<Set<string>>(new Set());
  const [retryError, setRetryError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(0);

  useEffect(() => {
    const timerId = setTimeout(() => {
      setCurrentTime(Date.now());
    }, 0);
    const interval = setInterval(() => setCurrentTime(Date.now()), 15_000);
    return () => {
      clearTimeout(timerId);
      clearInterval(interval);
    };
  }, []);

  async function handleRetry(sourceMessageId: string) {
    // Synchronous guard against concurrent / rapid clicks on the same retry
    if (retryingIdsRef.current.has(sourceMessageId) || retryingId || !isActive) {
      return;
    }

    retryingIdsRef.current.add(sourceMessageId);
    setRetryingId(sourceMessageId);
    setRetryError(null);

    const sourceMsg = messages.find((m) => m.id === sourceMessageId);

    try {
      const res = await retrySellerReplyAction({
        inquiryId,
        sourceMessageId,
      });

      if (!res.success) {
        setRetryError(res.message || "Retry failed. You may try again.");
      } else {
        // Broadcast successful retry event so the composer can reconcile its draft state
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("rabet:reply_retried", {
              detail: {
                inquiryId,
                sourceMessageId,
                retriedBody: sourceMsg?.body,
              },
            }),
          );
        }
        onMessageRetried?.();
      }
    } catch {
      setRetryError("A network error occurred while attempting retry.");
    } finally {
      retryingIdsRef.current.delete(sourceMessageId);
      setRetryingId(null);
    }
  }

  if (messages.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        No messages recorded on this conversation yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {retryError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"
        >
          {retryError}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        {messages.map((msg) => {
          const isAdmin = msg.author === "admin";
          const createdAtDate =
            msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdAt);
          const isStalePending =
            isAdmin &&
            msg.deliveryStatus === "pending" &&
            currentTime > 0 &&
            currentTime - createdAtDate.getTime() >= 120_000;

          return (
            <div
              key={msg.id}
              className={cn(
                "flex flex-col gap-1 max-w-[88%] sm:max-w-[80%]",
                isAdmin ? "self-end items-end" : "self-start items-start",
              )}
            >
              {/* Message Header / Author */}
              <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                {isAdmin ? (
                  <>
                    <ShieldCheck className="size-3 text-primary" />
                    <span className="font-medium text-foreground">Seller (You)</span>
                  </>
                ) : (
                  <>
                    <User className="size-3" />
                    <span className="font-medium text-foreground">Customer</span>
                  </>
                )}
                <span>•</span>
                <time dateTime={createdAtDate.toISOString()}>
                  {createdAtDate.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>

              {/* Message Bubble */}
              <div
                className={cn(
                  "rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words min-w-0 max-w-full",
                  isAdmin
                    ? "rounded-tr-none bg-primary text-primary-foreground shadow-xs"
                    : "rounded-tl-none border bg-muted/60 text-foreground",
                )}
                dir="auto"
              >
                {msg.body}
              </div>

              {/* Delivery Metadata for Admin Messages */}
              {isAdmin ? (
                <div className="flex flex-col gap-1 px-1 text-xs">
                  {msg.deliveryStatus === "sent" ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3" />
                      Sent via Telegram
                    </span>
                  ) : msg.deliveryStatus === "failed" ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-destructive font-medium">
                        <AlertTriangle className="size-3" />
                        Delivery failed {msg.deliveryError ? `(${msg.deliveryError})` : ""}
                      </span>
                      {isActive ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRetry(msg.id)}
                          disabled={Boolean(retryingId)}
                          className="h-7 min-h-[32px] px-2 text-xs gap-1 border-destructive/40 text-destructive hover:bg-destructive/10 touch-manipulation"
                        >
                          {retryingId === msg.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3" />
                          )}
                          Retry
                        </Button>
                      ) : null}
                    </div>
                  ) : isStalePending ? (
                    <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                      <div className="flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span>Delivery unconfirmed (pending &gt;2m)</span>
                      </div>
                      <p className="text-[11px] leading-tight text-amber-700/90 dark:text-amber-400/90">
                        Delivery could not be confirmed. The earlier message may have already reached the customer. Resending requires explicit seller action and may deliver a duplicate message.
                      </p>
                      {isActive ? (
                        <div className="pt-0.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRetry(msg.id)}
                            disabled={Boolean(retryingId)}
                            className="h-7 min-h-[32px] px-2.5 text-xs gap-1 border-amber-600/40 text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 touch-manipulation"
                          >
                            {retryingId === msg.id ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <RefreshCw className="size-3" />
                            )}
                            Resend message
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Clock className="size-3 animate-pulse" />
                      Sending...
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
