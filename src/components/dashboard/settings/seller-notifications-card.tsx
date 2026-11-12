"use client";

import { useState, useTransition } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ExternalLink,
  HelpCircle,
  Info,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
} from "lucide-react";

import {
  checkNotificationBotConnectionAction,
  detectNotificationBotChatsAction,
  loadSellerNotificationStateAction,
  retrySellerNotificationDeliveryAction,
  saveSellerNotificationConfigAction,
  sendSellerTestNotificationAction,
  toggleSellerNotificationEnabledAction,
  type SellerNotificationActionResult,
} from "@/app/actions/seller-notifications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  SellerNotificationDeliveryRecord,
  SellerNotificationSettingRecord,
} from "@/lib/data/seller-notifications";
import type {
  BotIdentity,
  OperatorDetectedChat,
} from "@/lib/telegram/seller-notifications";

interface SellerNotificationsCardProps {
  initialState: SellerNotificationActionResult;
}

export function SellerNotificationsCard({
  initialState,
}: SellerNotificationsCardProps) {
  const [supported, setSupported] = useState(initialState.supported ?? false);
  const [supportMessage, setSupportMessage] = useState(initialState.message);
  const [isTokenConfigured, setIsTokenConfigured] = useState(
    Boolean(initialState.isTokenConfigured)
  );
  const [config, setConfig] = useState<SellerNotificationSettingRecord | null>(
    initialState.config ?? null
  );
  const [recentDeliveries, setRecentDeliveries] = useState<
    SellerNotificationDeliveryRecord[]
  >(initialState.recentDeliveries ?? []);

  // Form draft state
  const [destinationChatId, setDestinationChatId] = useState(
    config?.destinationChatId ?? ""
  );
  const [notificationLanguage, setNotificationLanguage] = useState<"ar" | "en">(
    config?.language === "en" ? "en" : "ar"
  );
  const [hasEditedChatId, setHasEditedChatId] = useState(false);
  const [hasEditedLanguage, setHasEditedLanguage] = useState(false);

  // Connected Bot check state
  const [botIdentity, setBotIdentity] = useState<BotIdentity | null>(
    config?.verifiedBotUsername
      ? {
          id: config.verifiedBotId ?? 0,
          username: config.verifiedBotUsername,
          firstName: "Notification Bot",
        }
      : null
  );

  // Operator chat helper state
  const [detectedChats, setDetectedChats] = useState<OperatorDetectedChat[] | null>(
    null
  );
  const [showHelper, setShowHelper] = useState(false);

  // Feedback banner
  const [feedback, setFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // Async transitions
  const [isCheckingBot, startCheckingBot] = useTransition();
  const [isDetectingChats, startDetectingChats] = useTransition();
  const [isSavingConfig, startSavingConfig] = useTransition();
  const [isSendingTest, startSendingTest] = useTransition();
  const [isTogglingEnabled, startTogglingEnabled] = useTransition();
  const [isRetryingDelivery, startRetryingDelivery] = useTransition();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Unknown confirmation modal state
  const [pendingUnknownRetry, setPendingUnknownRetry] = useState<SellerNotificationDeliveryRecord | null>(
    null
  );
  const [acknowledgedUnknownRisk, setAcknowledgedUnknownRisk] = useState(false);

  // Refresh entire state from server
  async function refreshState() {
    const fresh = await loadSellerNotificationStateAction();
    if (fresh.success) {
      setSupported(fresh.supported ?? false);
      setSupportMessage(fresh.message);
      setIsTokenConfigured(Boolean(fresh.isTokenConfigured));
      setConfig(fresh.config ?? null);
      if (fresh.config) {
        if (!hasEditedChatId) {
          setDestinationChatId(fresh.config.destinationChatId ?? "");
        }
        if (!hasEditedLanguage) {
          setNotificationLanguage(fresh.config.language === "en" ? "en" : "ar");
        }
        if (fresh.config.verifiedBotUsername && fresh.config.verifiedAt) {
          setBotIdentity({
            id: fresh.config.verifiedBotId ?? 0,
            username: fresh.config.verifiedBotUsername,
            firstName: "Notification Bot",
          });
        } else if (!fresh.config.verifiedAt) {
          setBotIdentity(null);
        }
      }
      setRecentDeliveries(fresh.recentDeliveries ?? []);
    }
  }

  // 1. Check Bot Connection
  function handleCheckBot() {
    setFeedback(null);
    startCheckingBot(async () => {
      const res = await checkNotificationBotConnectionAction();
      if (!res.success) {
        setFeedback({
          type: "error",
          message: res.message || "Failed to connect to Telegram bot.",
        });
        return;
      }
      if (res.bot) {
        setBotIdentity(res.bot);
        setIsTokenConfigured(true);
        setFeedback({
          type: "success",
          message: `Bot connection verified: @${res.bot.username} (ID: ${res.bot.id}).`,
        });
      }
    });
  }

  // 2. Detect Chat ID helper
  function handleDetectChats() {
    setFeedback(null);
    startDetectingChats(async () => {
      const res = await detectNotificationBotChatsAction();
      if (!res.success) {
        setFeedback({
          type: "error",
          message: res.message || "Failed to read recent updates from bot.",
        });
        return;
      }
      setDetectedChats(res.chats ?? []);
      setShowHelper(true);
      if (!res.chats || res.chats.length === 0) {
        setFeedback({
          type: "info",
          message:
            "No recent messages received by this bot. Open your notification bot in Telegram and click /start, then try again.",
        });
      }
    });
  }

  // 3. Save Configuration
  function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    startSavingConfig(async () => {
      const formData = new FormData();
      formData.set("destinationChatId", destinationChatId);
      formData.set("language", notificationLanguage);

      const res = await saveSellerNotificationConfigAction(formData);

      if (!res.success) {
        setFeedback({
          type: "error",
          message: res.message || "Failed to save configuration.",
        });
        return;
      }

      setHasEditedChatId(false);
      setHasEditedLanguage(false);
      await refreshState();
      setFeedback({
        type: "success",
        message:
          res.message ||
          "Notification configuration saved. Please send a test notification to verify destination before enabling.",
      });
    });
  }

  // 4. Send Test Notification
  function handleSendTest() {
    setFeedback(null);
    startSendingTest(async () => {
      const res = await sendSellerTestNotificationAction();
      if (!res.success) {
        setFeedback({
          type: "error",
          message: res.message || "Test notification delivery failed.",
        });
        return;
      }

      await refreshState();
      setFeedback({
        type: "success",
        message:
          res.message ||
          "Test notification delivered successfully! Bot and destination are verified. You can now enable alerts.",
      });
    });
  }

  // 5. Toggle Enabled State
  function handleToggleEnabled() {
    if (!config?.verifiedAt && !config?.enabled) {
      setFeedback({
        type: "error",
        message: "You must verify the destination chat with a successful test notification before enabling.",
      });
      return;
    }

    setFeedback(null);
    const targetState = !config?.enabled;
    startTogglingEnabled(async () => {
      const res = await toggleSellerNotificationEnabledAction(targetState);
      if (!res.success) {
        setFeedback({
          type: "error",
          message: res.message || "Failed to update notification status.",
        });
        return;
      }

      await refreshState();
      setFeedback({
        type: "success",
        message: targetState
          ? "Seller new-inquiry notifications are now ENABLED."
          : "Seller new-inquiry notifications are now DISABLED.",
      });
    });
  }

  // 6. Retry Delivery
  function handleInitiateRetry(delivery: SellerNotificationDeliveryRecord) {
    if (delivery.status === "unknown") {
      setPendingUnknownRetry(delivery);
      setAcknowledgedUnknownRisk(false);
      return;
    }
    executeRetry(delivery.id, false);
  }

  function executeRetry(deliveryId: string, acknowledgeUnknownRisk: boolean) {
    setFeedback(null);
    setRetryingId(deliveryId);
    startRetryingDelivery(async () => {
      try {
        const res = await retrySellerNotificationDeliveryAction(deliveryId, {
          acknowledgeUnknownRisk,
        });

        if (!res.success) {
          setFeedback({
            type: "error",
            message: res.message || "Delivery retry attempt failed.",
          });
        } else {
          setFeedback({
            type: "success",
            message: res.message || "Delivery succeeded and marked sent.",
          });
        }
        await refreshState();
      } finally {
        setRetryingId(null);
        setPendingUnknownRetry(null);
      }
    });
  }

  const isVerified = Boolean(
    config?.verifiedAt &&
      config?.destinationChatId &&
      config?.verifiedBotUsername
  );

  return (
    <Card id="seller-notifications-section" data-testid="seller-notifications-card" className="w-full">
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Bell className="size-5 text-primary" />
            <CardTitle>Seller Notifications (Telegram)</CardTitle>
          </div>
          <div>
            {config?.enabled ? (
              <Badge className="bg-emerald-600 text-white font-medium hover:bg-emerald-700">
                Notifications Enabled
              </Badge>
            ) : (
              <Badge variant="secondary" className="font-medium">
                Notifications Disabled
              </Badge>
            )}
          </div>
        </div>
        <CardDescription>
          Outbound-only Telegram alerts sent to the store owner whenever a genuinely new product or support inquiry is opened.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Schema / Support Check Banner */}
        {!supported && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300"
          >
            <AlertTriangle className="size-5 shrink-0 text-amber-600 mt-0.5" />
            <div>
              <p className="font-medium">Seller Notifications Unavailable</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {supportMessage ||
                  "Database tables for seller notifications are not present. Apply migration 0003_seller_notifications to enable this feature."}
              </p>
            </div>
          </div>
        )}

        {/* Action feedback banner */}
        {feedback && (
          <div
            role="alert"
            className={`flex items-start gap-3 rounded-xl border p-4 text-sm font-medium ${
              feedback.type === "success"
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : feedback.type === "error"
                ? "border-destructive/20 bg-destructive/10 text-destructive"
                : "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300"
            }`}
          >
            {feedback.type === "success" ? (
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
            ) : feedback.type === "error" ? (
              <AlertCircle className="size-5 shrink-0 text-destructive" />
            ) : (
              <Info className="size-5 shrink-0 text-blue-600" />
            )}
            <div className="flex-1">
              <p>{feedback.message}</p>
            </div>
          </div>
        )}

        {/* Setup Instructions Box */}
        <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <HelpCircle className="size-4 text-primary" />
            <span>Setup Instructions</span>
          </div>
          <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
            <li>Create a separate bot with @BotFather on Telegram.</li>
            <li>
              Add its token as{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground font-semibold">
                TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN
              </code>{" "}
              in your server environment variables (never public, never shared with customer bot).
            </li>
            <li>Open the new bot from your seller Telegram account and press <strong>Start</strong>.</li>
            <li>Enter your numeric private chat ID below (or use the chat detection helper).</li>
            <li>Send a test notification to verify delivery.</li>
            <li>Enable new-inquiry alerts.</li>
          </ol>
        </div>

        {/* Token Status & Connection Check */}
        <div className="rounded-xl border p-4 space-y-3 bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Bot Secret Token Status
                </span>
                {isTokenConfigured ? (
                  <Badge variant="outline" className="text-emerald-600 border-emerald-500/30 bg-emerald-500/10 text-xs">
                    Configured in Environment
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-600 border-amber-500/30 bg-amber-500/10 text-xs">
                    Not Configured
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                The bot token is stored securely in the server environment and never exposed to the browser.
              </p>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isCheckingBot || !supported}
              onClick={handleCheckBot}
              data-testid="check-bot-connection-button"
              className="gap-2 shrink-0 self-start sm:self-center"
            >
              {isCheckingBot ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Checking...</span>
                </>
              ) : (
                <>
                  <Bot className="size-3.5" />
                  <span>Check Bot Connection</span>
                </>
              )}
            </Button>
          </div>

          {botIdentity && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/40 p-2.5 text-xs">
              <Bot className="size-4 text-primary" />
              <span className="text-muted-foreground">Connected Bot:</span>
              <span className="font-semibold text-foreground">@{botIdentity.username}</span>
              <span className="font-mono text-muted-foreground">(ID: {botIdentity.id})</span>
            </div>
          )}
        </div>

        {/* Configuration Form */}
        <form onSubmit={handleSaveConfig} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Destination Chat ID */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="seller-destination-chat-id"
                  className="text-sm font-medium text-foreground"
                >
                  Seller Chat ID <span className="text-destructive">*</span>
                </label>
                <button
                  type="button"
                  onClick={handleDetectChats}
                  disabled={isDetectingChats || !supported || !isTokenConfigured}
                  data-testid="detect-chats-button"
                  className="text-xs text-primary hover:underline flex items-center gap-1 disabled:opacity-50"
                >
                  {isDetectingChats ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  Detect Chat ID
                </button>
              </div>

              <input
                id="seller-destination-chat-id"
                name="destinationChatId"
                type="text"
                inputMode="numeric"
                required
                pattern="^-?[0-9]{1,20}$"
                value={destinationChatId}
                onChange={(e) => {
                  setDestinationChatId(e.target.value.trim());
                  setHasEditedChatId(true);
                }}
                data-testid="destination-chat-id-input"
                placeholder="e.g. 123456789"
                disabled={!supported}
                className="flex min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Your numeric Telegram chat ID. Must be a positive or negative decimal integer.
              </p>
            </div>

            {/* Notification Language */}
            <div className="space-y-2">
              <label
                htmlFor="seller-notification-lang"
                className="text-sm font-medium text-foreground"
              >
                Notification Language <span className="text-destructive">*</span>
              </label>
              <select
                id="seller-notification-lang"
                name="notificationLanguage"
                value={notificationLanguage}
                onChange={(e) => {
                  setNotificationLanguage(e.target.value as "ar" | "en");
                  setHasEditedLanguage(true);
                }}
                data-testid="notification-language-select"
                disabled={!supported}
                className="flex min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="ar">العربية (Arabic) — RTL</option>
                <option value="en">English — LTR</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Language used when sending inquiry alert messages to your Telegram chat.
              </p>
            </div>
          </div>

          {/* Operator Chat ID helper drawer/section */}
          {showHelper && detectedChats && detectedChats.length > 0 && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-2">
              <p className="text-xs font-semibold text-primary">
                Recently received chat IDs for this bot:
              </p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {detectedChats.map((c) => (
                  <div
                    key={c.chatId}
                    className="flex items-center justify-between gap-2 rounded-lg bg-background p-2 text-xs border"
                  >
                    <div>
                      <span className="font-semibold text-foreground">
                        {c.firstName}
                      </span>
                      {c.username && (
                        <span className="text-muted-foreground ml-1">
                          (@{c.username})
                        </span>
                      )}
                      <span className="font-mono text-xs text-muted-foreground ml-2">
                        ID: {c.chatId}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs px-2.5"
                      onClick={() => {
                        setDestinationChatId(c.chatId);
                        setHasEditedChatId(true);
                        setShowHelper(false);
                      }}
                    >
                      Use This ID
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
            <p className="text-xs text-muted-foreground">
              {config?.destinationChatId &&
              destinationChatId !== config.destinationChatId
                ? "Notice: Changing the destination chat ID will disable notifications and invalidate previous verification."
                : "Settings are stored in the database singleton."}
            </p>

            <Button
              type="submit"
              size="sm"
              disabled={isSavingConfig || !supported}
              data-testid="save-notification-config-button"
              className="gap-2 self-start sm:self-auto"
            >
              {isSavingConfig ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save Configuration</span>
              )}
            </Button>
          </div>
        </form>

        {/* Verification Status & Test Action */}
        <div className="rounded-xl border p-4 space-y-4 bg-muted/15">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  Connection Verification Status
                </span>
                {isVerified ? (
                  <Badge className="bg-emerald-600 text-white text-xs gap-1">
                    <Check className="size-3" />
                    Verified
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-600 border-amber-500/30 bg-amber-500/10 text-xs">
                    Not Verified
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {isVerified
                  ? `Verified with bot @${config?.verifiedBotUsername} to destination ${config?.destinationChatId} at ${
                      config?.verifiedAt
                        ? new Date(config.verifiedAt).toLocaleString()
                        : "recently"
                    }.`
                  : "A test notification must succeed to verify the exact bot token and destination chat ID."}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  isSendingTest ||
                  !supported ||
                  !isTokenConfigured ||
                  !config?.destinationChatId
                }
                onClick={handleSendTest}
                data-testid="send-test-notification-button"
                className="gap-2"
              >
                {isSendingTest ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>Sending Test...</span>
                  </>
                ) : (
                  <>
                    <Send className="size-3.5" />
                    <span>Send Test Notification</span>
                  </>
                )}
              </Button>

              <Button
                type="button"
                size="sm"
                variant={config?.enabled ? "destructive" : "default"}
                disabled={
                  isTogglingEnabled ||
                  !supported ||
                  (!isVerified && !config?.enabled)
                }
                onClick={handleToggleEnabled}
                data-testid="enable-notifications-toggle"
                className="gap-2"
              >
                {isTogglingEnabled ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : config?.enabled ? (
                  <span>Disable Alerts</span>
                ) : (
                  <span>Enable Alerts</span>
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Modal / Dialog for Unknown Delivery Risk Confirmation */}
        {pendingUnknownRetry && (
          <div
            role="dialog"
            aria-modal="true"
            data-testid="unknown-retry-dialog"
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3"
          >
            <div className="flex items-start gap-3">
              <ShieldAlert className="size-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1.5 flex-1">
                <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  Potential Duplicate Delivery Warning
                </h4>
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  This delivery attempt timed out or had a network interruption, so Telegram may have already delivered it to the seller.
                  Retrying an <strong>unknown</strong> delivery may cause the seller to receive a duplicate notification.
                </p>
                <div className="flex items-center gap-2 pt-2">
                  <input
                    id="ack-unknown-risk"
                    type="checkbox"
                    checked={acknowledgedUnknownRisk}
                    onChange={(e) => setAcknowledgedUnknownRisk(e.target.checked)}
                    data-testid="unknown-retry-ack-checkbox"
                    className="size-4 rounded border-input accent-primary"
                  />
                  <label
                    htmlFor="ack-unknown-risk"
                    className="text-xs font-medium text-foreground cursor-pointer"
                  >
                    I understand that retrying this notification might deliver a duplicate message to the seller.
                  </label>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPendingUnknownRetry(null)}
                data-testid="unknown-retry-cancel-button"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={!acknowledgedUnknownRisk || isRetryingDelivery}
                onClick={() =>
                  executeRetry(pendingUnknownRetry.id, acknowledgedUnknownRisk)
                }
                data-testid="unknown-retry-confirm-button"
                className="gap-2"
              >
                {isRetryingDelivery ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <span>Confirm Retry</span>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Delivery Outbox / Audit Trail */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">
              Recent Notification Deliveries
            </h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={refreshState}
              className="text-xs gap-1 h-7"
            >
              <RefreshCw className="size-3" />
              Refresh Outbox
            </Button>
          </div>

          {recentDeliveries.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
              No new-inquiry notification delivery events recorded yet.
            </div>
          ) : (
            <div data-testid="delivery-history-table" className="overflow-x-auto rounded-xl border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 border-b text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Reference</th>
                    <th className="px-3 py-2 font-medium">Inquiry</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Attempts</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 font-medium">Diagnostics</th>
                    <th className="px-3 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {recentDeliveries.map((delivery) => {
                    const isRetrying = retryingId === delivery.id;
                    const canRetry =
                      delivery.status === "failed" ||
                      delivery.status === "unknown" ||
                      delivery.status === "pending";

                    return (
                      <tr key={delivery.id} className="hover:bg-muted/20">
                        <td className="px-3 py-2.5 font-mono text-[11px] text-foreground">
                          {delivery.reference}
                        </td>
                        <td className="px-3 py-2.5">
                          {delivery.inquiryId ? (
                            <a
                              href={`/inquiries/${delivery.inquiryId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline inline-flex items-center gap-1 font-mono text-[11px]"
                            >
                              <span>#{delivery.inquiryId.slice(0, 8)}</span>
                              <ExternalLink className="size-2.5" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <DeliveryStatusBadge status={delivery.status} />
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground font-mono">
                          {delivery.attemptCount}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                          {delivery.createdAt
                            ? new Date(delivery.createdAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground max-w-xs truncate font-mono text-[11px]">
                          {delivery.errorCategory ? (
                            <span className="text-destructive font-sans">
                              {delivery.errorCategory}
                            </span>
                          ) : delivery.telegramMessageId ? (
                            <span className="text-emerald-600 font-sans">
                              msg #{delivery.telegramMessageId}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {canRetry ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={isRetrying || isRetryingDelivery}
                              onClick={() => handleInitiateRetry(delivery)}
                              data-testid="delivery-retry-button"
                              className="h-7 text-xs px-2.5 gap-1"
                            >
                              {isRetrying ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <RefreshCw className="size-3" />
                              )}
                              <span>Retry</span>
                            </Button>
                          ) : (
                            <span className="text-muted-foreground text-[11px]">
                              {delivery.status === "sent" ? "Delivered" : "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DeliveryStatusBadge({
  status,
}: {
  status: SellerNotificationDeliveryRecord["status"];
}) {
  switch (status) {
    case "sent":
      return (
        <Badge className="bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-700">
          sent
        </Badge>
      );
    case "sending":
      return (
        <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-600 text-[11px]">
          sending
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive text-[11px]">
          failed
        </Badge>
      );
    case "unknown":
      return (
        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[11px]">
          unknown
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="border-muted bg-muted/50 text-muted-foreground text-[11px]">
          cancelled
        </Badge>
      );
    case "pending":
    default:
      return (
        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 text-[11px]">
          pending
        </Badge>
      );
  }
}
