"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ExternalLink,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Unplug,
} from "lucide-react";

import {
  checkMerchantNotificationBotManagedAction,
  checkMerchantNotificationBotPairingAction,
  connectMerchantNotificationBotAction,
  disconnectMerchantNotificationBotAction,
  sendMerchantNotificationBotTestAction,
  startMerchantNotificationBotPairingAction,
  type MerchantNotificationBotActionResult,
} from "@/app/actions/merchant-notification-bot";
import type { MerchantLocale } from "@/components/merchant/language-toggle";
import { MERCHANT_NOTIFICATION_BOT_COPY } from "@/components/merchant/merchant-notification-bot-copy";
import { Button } from "@/components/ui/button";
import type { MerchantNotificationBotState } from "@/lib/data/merchant-notification-bot";
import type { NotificationManagedAttemptState } from "@/lib/telegram/manager-provisioning";

type PendingAction =
  | "connect"
  | "link"
  | "check"
  | "managed_check"
  | "test"
  | "disconnect"
  | null;

type Feedback = {
  kind: "success" | "error" | "info";
  text: string;
};

function stableUtc(value: string | null): string | null {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}

function destinationLabel(
  state: MerchantNotificationBotState,
): string | null {
  if (state.destinationChatTitle) return state.destinationChatTitle;
  if (state.destinationChatId) return `ID: ${state.destinationChatId}`;
  return null;
}

export function MerchantNotificationBot({
  state,
  supported,
  managed,
  locale,
  readOnly,
}: {
  state: MerchantNotificationBotState | null;
  supported: boolean;
  managed: NotificationManagedAttemptState | null;
  locale: MerchantLocale;
  readOnly: boolean;
}) {
  const copy = MERCHANT_NOTIFICATION_BOT_COPY[locale];
  const router = useRouter();
  const [token, setToken] = useState("");
  const [pairingLink, setPairingLink] = useState<{
    deepLink: string;
    expiresAt: string;
  } | null>(null);
  const [lastMessageId, setLastMessageId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isPending, startTransition] = useTransition();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const disabled = readOnly || !supported || isPending;

  function errorText(result: MerchantNotificationBotActionResult): string {
    if (result.ok) return "";

    const base =
      copy.errors[result.error] ?? copy.errors.OPERATION_FAILED;

    return result.retryAfterSeconds
      ? `${base} (${result.retryAfterSeconds}s)`
      : base;
  }

  function run(
    action: Exclude<PendingAction, null>,
    task: () => Promise<void>,
  ) {
    setFeedback(null);
    setPendingAction(action);

    startTransition(async () => {
      try {
        await task();
      } finally {
        setPendingAction(null);
      }
    });
  }

  function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    run("connect", async () => {
      const result = await connectMerchantNotificationBotAction({ token });

      if (!result.ok) {
        setFeedback({ kind: "error", text: errorText(result) });
        return;
      }

      setToken("");
      setPairingLink(result.pairing ?? null);
      setFeedback({
        kind: "info",
        text: copy.pairingBody,
      });
      router.refresh();
    });
  }

  function handleNewPairingLink() {
    run("link", async () => {
      const result = await startMerchantNotificationBotPairingAction();

      if (!result.ok) {
        setFeedback({ kind: "error", text: errorText(result) });
        return;
      }

      setPairingLink(result.pairing ?? null);
      setFeedback({ kind: "info", text: copy.pairingBody });
      router.refresh();
    });
  }

  function handleCheckPairing() {
    run("check", async () => {
      const result = await checkMerchantNotificationBotPairingAction();

      if (!result.ok) {
        setFeedback({
          kind: result.error === "PAIRING_PENDING" ? "info" : "error",
          text: errorText(result),
        });
        return;
      }

      setPairingLink(null);
      setFeedback({ kind: "success", text: copy.pairedTitle });
      router.refresh();
    });
  }

  function handleCheckManaged() {
    run("managed_check", async () => {
      const result = await checkMerchantNotificationBotManagedAction();

      if (!result.ok) {
        setFeedback({
          kind: result.error === "BOT_START_PENDING" ? "info" : "error",
          text: errorText(result),
        });
        return;
      }

      setFeedback({ kind: "success", text: copy.pairedTitle });
      router.refresh();
    });
  }

  function handleSendTest() {
    run("test", async () => {
      const result = await sendMerchantNotificationBotTestAction({ locale });

      if (!result.ok) {
        setFeedback({ kind: "error", text: errorText(result) });
        return;
      }

      setLastMessageId(result.messageId ?? null);
      setFeedback({ kind: "success", text: copy.testAccepted });
      router.refresh();
    });
  }

  function handleDisconnect() {
    run("disconnect", async () => {
      const result = await disconnectMerchantNotificationBotAction();

      if (!result.ok) {
        setConfirmDisconnect(false);
        setFeedback({ kind: "error", text: errorText(result) });
        return;
      }

      setConfirmDisconnect(false);
      setPairingLink(null);
      setLastMessageId(null);
      setFeedback({ kind: "success", text: copy.disconnected });
      router.refresh();
    });
  }

  const pairingAmbiguous = state?.pairingFailureCode === "ambiguous";
  const managedActive =
    !state &&
    managed !== null &&
    (managed.state === "waiting" ||
      managed.state === "awaiting_start" ||
      managed.state === "preparing");
  const managedStatusLabel =
    managed?.state === "waiting"
      ? copy.managedWaiting
      : managed?.state === "awaiting_start"
        ? copy.managedAwaitingStart
        : managed?.state === "preparing"
          ? copy.managedPreparing
          : copy.statusUnpaired;
  const statusLabel = !state
    ? managedActive
      ? managedStatusLabel
      : copy.statusUnpaired
    : state.destinationChatId
      ? copy.statusConnected
      : state.pairingActive
        ? copy.statusPairing
        : pairingAmbiguous
          ? copy.statusPairingFailed
          : copy.statusUnpaired;

  const destination = state ? destinationLabel(state) : null;
  const verified = Boolean(state?.verifiedAt && state.destinationChatId);
  const pairingExpired = Boolean(
    state?.pairingExpiresAt && !state.pairingActive && !state.destinationChatId,
  );

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid="merchant-notification-bot"
      aria-busy={isPending}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 font-heading text-lg font-semibold">
            <Bell className="size-4 text-muted-foreground" aria-hidden="true" />
            {copy.title}
          </h2>
          <p className="text-sm text-muted-foreground">{copy.intro}</p>
        </div>
        <span
          className="inline-flex min-h-8 items-center rounded-full border border-border bg-muted/40 px-3 text-sm font-medium"
          data-testid="merchant-notification-bot-status"
        >
          {statusLabel}
        </span>
      </div>

      <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        {copy.separateNotice}
      </p>

      {readOnly ? (
        <p
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="merchant-notification-bot-read-only"
        >
          {copy.readOnly}
        </p>
      ) : null}

      {!supported ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
          data-testid="merchant-notification-bot-unsupported"
        >
          {copy.unsupported}
        </p>
      ) : null}

      {supported && !state ? (
        <div className="space-y-4">
          <div
            className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3"
            data-testid="merchant-notification-bot-managed"
          >
            <div>
              <p className="font-medium">{copy.managedTitle}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {copy.managedBody}
              </p>
            </div>

            {managedActive ? (
              <div className="space-y-3">
                <p
                  className="text-sm font-medium"
                  data-testid="merchant-notification-bot-managed-status"
                >
                  {managedStatusLabel}
                </p>
                {managed?.state === "waiting" ? (
                  <Button asChild className="min-h-11">
                    <a
                      href={managed.deepLink}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="merchant-notification-bot-managed-open"
                    >
                      <ExternalLink className="size-4" aria-hidden="true" />
                      {copy.managedOpenManager}
                    </a>
                  </Button>
                ) : null}
                {managed?.state === "awaiting_start" ? (
                  <Button asChild className="min-h-11">
                    <a
                      href={managed.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="merchant-notification-bot-managed-open"
                    >
                      <ExternalLink className="size-4" aria-hidden="true" />
                      {copy.managedOpenBot}
                    </a>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled}
                  onClick={handleCheckManaged}
                  data-testid="merchant-notification-bot-managed-check"
                >
                  {pendingAction === "managed_check" ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                  )}
                  {pendingAction === "managed_check"
                    ? copy.managedChecking
                    : copy.managedCheck}
                </Button>
              </div>
            ) : (
              <form method="post" action="/app/setup/notification-bot/start">
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={disabled}
                  data-testid="merchant-notification-bot-managed-create"
                >
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  {copy.managedCreate}
                </Button>
              </form>
            )}

            {managed?.state === "expired" || managed?.state === "failed" ? (
              <p
                role="alert"
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
                data-testid="merchant-notification-bot-managed-error"
              >
                {managed.state === "expired"
                  ? copy.managedExpired
                  : copy.managedFailed}
              </p>
            ) : null}
          </div>

          <details
            className="rounded-lg border border-border bg-muted/10 p-3"
            data-testid="merchant-notification-bot-advanced"
          >
            <summary className="cursor-pointer text-sm font-medium">
              {copy.advancedTitle}
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              {copy.advancedBody}
            </p>

            <div className="mt-4 rounded-lg border border-border bg-muted/20 p-3">
              <p className="mb-2 text-sm font-medium">{copy.setupStepsTitle}</p>
              <ol className="list-decimal space-y-1.5 ps-5 text-sm text-muted-foreground">
                {copy.setupSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            <form onSubmit={handleConnect} className="mt-4 space-y-3" noValidate>
              <div className="space-y-1.5">
                <label
                  htmlFor="merchant-notification-bot-token"
                  className="text-sm font-medium"
                >
                  {copy.tokenLabel}
                </label>
                <input
                  id="merchant-notification-bot-token"
                  name="notificationBotToken"
                  type="password"
                  dir="ltr"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={200}
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    if (feedback) setFeedback(null);
                  }}
                  disabled={disabled}
                  placeholder={copy.tokenPlaceholder}
                  aria-describedby="merchant-notification-bot-token-hint"
                  data-testid="merchant-notification-bot-token-input"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 font-mono text-base text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-sm"
                />
                <p
                  id="merchant-notification-bot-token-hint"
                  className="text-xs text-muted-foreground"
                >
                  {copy.tokenHint}
                </p>
              </div>

              <Button
                type="submit"
                disabled={disabled || token.trim().length === 0}
                className="min-h-11 w-full gap-2 sm:w-auto"
                data-testid="merchant-notification-bot-connect"
              >
                {pendingAction === "connect" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <KeyRound className="size-4" aria-hidden="true" />
                )}
                {pendingAction === "connect" ? copy.connecting : copy.connect}
              </Button>
            </form>
          </details>
        </div>
      ) : null}

      {supported && state ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Bot</p>
              <p
                className="break-all font-mono text-sm font-medium"
                data-testid="merchant-notification-bot-username"
              >
                @{state.botUsername}
              </p>
              {state.botName ? (
                <p className="break-words text-sm text-muted-foreground">
                  {state.botName}
                </p>
              ) : null}
            </div>
          </div>

          {state.pairingActive ? (
            <div
              className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3"
              data-testid="merchant-notification-bot-pairing"
            >
              <p className="font-medium">{copy.pairingTitle}</p>
              <p className="text-sm text-muted-foreground">
                {copy.pairingBody}
              </p>
              <p className="text-xs text-muted-foreground">
                {copy.pairingExpires}
              </p>

              <div className="flex flex-wrap gap-2">
                {pairingLink ? (
                  <Button asChild className="min-h-11">
                    <a
                      href={pairingLink.deepLink}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="merchant-notification-bot-open"
                    >
                      <ExternalLink className="size-4" aria-hidden="true" />
                      {copy.openBot}
                    </a>
                  </Button>
                ) : null}

                <Button
                  type="button"
                  variant={pairingLink ? "outline" : "default"}
                  className="min-h-11"
                  disabled={disabled}
                  onClick={handleNewPairingLink}
                  data-testid="merchant-notification-bot-new-link"
                >
                  {pendingAction === "link" ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                  {pendingAction === "link"
                    ? copy.generatingLink
                    : copy.newPairingLink}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled}
                  onClick={handleCheckPairing}
                  data-testid="merchant-notification-bot-check-pairing"
                >
                  {pendingAction === "check" ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                  )}
                  {pendingAction === "check"
                    ? copy.checkingPairing
                    : copy.checkPairing}
                </Button>
              </div>
            </div>
          ) : null}

          {pairingExpired ? (
            <div
              className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
              data-testid="merchant-notification-bot-pairing-expired"
            >
              <p>{copy.errors.PAIRING_EXPIRED}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={disabled}
                onClick={handleNewPairingLink}
                data-testid="merchant-notification-bot-new-link"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {copy.newPairingLink}
              </Button>
            </div>
          ) : null}

          {pairingAmbiguous ? (
            <div
              className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
              data-testid="merchant-notification-bot-pairing-ambiguous"
            >
              <p className="font-medium">{copy.pairingAmbiguousTitle}</p>
              <p>{copy.errors.PAIRING_AMBIGUOUS}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={disabled}
                onClick={handleNewPairingLink}
                data-testid="merchant-notification-bot-new-link"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {copy.newPairingLink}
              </Button>
            </div>
          ) : null}

          {state.destinationChatId ? (
            <div
              className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
              data-testid="merchant-notification-bot-paired"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {copy.destinationLabel}
                  </p>
                  <p
                    className="break-words text-sm font-medium"
                    data-testid="merchant-notification-bot-destination"
                  >
                    {destination}
                  </p>
                </div>
                {verified ? (
                  <span
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-3 text-xs font-medium text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200"
                    data-testid="merchant-notification-bot-verified"
                  >
                    <ShieldCheck className="size-3.5" aria-hidden="true" />
                    {copy.verified}
                  </span>
                ) : (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-800 dark:text-amber-300">
                    {copy.notVerified}
                  </span>
                )}
              </div>

              {state.lastTestAt ? (
                <p className="text-xs text-muted-foreground">
                  {copy.lastTest}: {stableUtc(state.lastTestAt)}
                </p>
              ) : null}

              <div className="rounded-lg border border-border bg-background p-3">
                <p className="text-sm font-medium">{copy.testTitle}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {copy.testBody}
                </p>
                <Button
                  type="button"
                  className="mt-3 min-h-11 gap-2"
                  disabled={disabled}
                  onClick={handleSendTest}
                  data-testid="merchant-notification-bot-send-test"
                >
                  {pendingAction === "test" ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Send className="size-4" aria-hidden="true" />
                  )}
                  {pendingAction === "test" ? copy.sendingTest : copy.sendTest}
                </Button>
                {lastMessageId !== null ? (
                  <span className="ms-2 font-mono text-xs text-muted-foreground">
                    #{lastMessageId}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled}
                  onClick={handleNewPairingLink}
                  data-testid="merchant-notification-bot-change-chat"
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  {copy.changeChat}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {copy.disconnectHint}
            </p>
            {confirmDisconnect ? (
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="merchant-notification-bot-disconnect-confirm"
              >
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11"
                  disabled={disabled}
                  onClick={handleDisconnect}
                  data-testid="merchant-notification-bot-disconnect-confirm-button"
                >
                  {pendingAction === "disconnect" ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Unplug className="size-4" aria-hidden="true" />
                  )}
                  {pendingAction === "disconnect"
                    ? copy.disconnecting
                    : copy.disconnect}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={disabled}
                  onClick={() => setConfirmDisconnect(false)}
                >
                  {locale === "ar" ? "إلغاء" : "Cancel"}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={disabled}
                onClick={() => setConfirmDisconnect(true)}
                data-testid="merchant-notification-bot-disconnect"
              >
                <Unplug className="size-4" aria-hidden="true" />
                {copy.disconnect}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {feedback ? (
        <div
          role={feedback.kind === "error" ? "alert" : "status"}
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            feedback.kind === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
              : feedback.kind === "error"
                ? "border-destructive/30 bg-destructive/5 text-destructive"
                : "border-border bg-muted/30 text-muted-foreground"
          }`}
          data-testid="merchant-notification-bot-feedback"
        >
          {feedback.kind === "success" ? (
            <CheckCircle2
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          ) : feedback.kind === "error" ? (
            <AlertCircle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <Info
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <p className="break-words">{feedback.text}</p>
        </div>
      ) : null}
    </section>
  );
}
