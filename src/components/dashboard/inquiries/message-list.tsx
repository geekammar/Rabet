"use client";

import { useEffect, useState } from "react";
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
    if (retryingId || !isActive) return;

    setRetryingId(sourceMessageId);
    setRetryError(null);

    try {
      const res = await retrySellerReplyAction({
        inquiryId,
        sourceMessageId,
      });

      if (!res.success) {
        setRetryError(res.message || "Retry failed. You may try again.");
      } else {
        onMessageRetried?.();
      }
    } catch {
      setRetryError("A network error occurred while attempting retry.");
    } finally {
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
                <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
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
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="size-3" />
                        Unconfirmed send (pending &gt;2m)
                      </span>
                      {isActive ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRetry(msg.id)}
                          disabled={Boolean(retryingId)}
                          className="h-7 min-h-[32px] px-2 text-xs gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 touch-manipulation"
                          title="Message delivery could not be confirmed. Earlier attempt may have arrived."
                        >
                          {retryingId === msg.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3" />
                          )}
                          Resend
                        </Button>
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
