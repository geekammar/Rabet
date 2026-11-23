"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, RefreshCw, Send } from "lucide-react";

import type { MerchantLocale } from "@/components/merchant/language-toggle";
import { MERCHANT_TELEGRAM_COPY } from "@/components/merchant/merchant-telegram-copy";
import {
  buildAndroidTelegramLaunchTarget,
  buildTelegramLaunchFallbackUrl,
  MERCHANT_TELEGRAM_START_PATH,
} from "@/components/merchant/telegram-official-launch";
import type { MerchantTelegramConnectionState } from "@/lib/telegram/manager-provisioning";
import {
  confirmMerchantTelegramConnection,
  startMerchantTelegramConnection,
  publishMerchantTelegramStore,
  recoverMerchantTelegramConnection,
  type MerchantTelegramActionResult,
} from "@/app/actions/merchant-telegram";
import { Button } from "@/components/ui/button";

function subscribeToLocation(onStoreChange: () => void) {
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener("popstate", onStoreChange);

  return () => {
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

function getLaunchFailureSnapshot(): boolean {
  return /telegram-launch-failed=telegram/.test(window.location.hash);
}

function getServerLaunchFailure(): boolean {
  return false;
}

function getStartErrorSnapshot(): string | null {
  const match = window.location.hash.match(/^#telegram-start-error=([A-Z_]+)$/);
  return match?.[1] ?? null;
}

function getServerStartError(): string | null {
  return null;
}

function StartAttemptControl({
  isAndroid,
  readOnly,
  isPending,
  onStart,
  label,
  testId,
  variant = "default",
  icon,
}: {
  isAndroid: boolean;
  readOnly: boolean;
  isPending: boolean;
  onStart: () => void;
  label: string;
  testId: string;
  variant?: "default" | "outline";
  icon: ReactNode;
}) {
  // On Android the create/retry action is a real form post. The server creates
  // the attempt and answers with a 303 to a package-targeted intent, so the
  // handoff keeps the tap's user gesture instead of waiting on async JS.
  if (isAndroid) {
    return (
      <form method="post" action={MERCHANT_TELEGRAM_START_PATH}>
        <Button
          type="submit"
          variant={variant}
          className="min-h-11"
          disabled={readOnly || isPending}
          data-testid={testId}
        >
          {icon}
          {label}
        </Button>
      </form>
    );
  }

  return (
    <Button
      type="button"
      variant={variant}
      className="min-h-11"
      disabled={readOnly || isPending}
      onClick={onStart}
      data-testid={testId}
    >
      {icon}
      {label}
    </Button>
  );
}

export function MerchantTelegramConnection({
  state,
  storeStatus,
  locale,
  readOnly,
  isAndroidTelegramLaunch,
  telegramLaunchOrigin,
}: {
  state: MerchantTelegramConnectionState;
  storeStatus: "onboarding" | "active" | "suspended";
  locale: MerchantLocale;
  readOnly: boolean;
  isAndroidTelegramLaunch: boolean;
  telegramLaunchOrigin: string | null;
}) {
  const copy = MERCHANT_TELEGRAM_COPY[locale];
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const launchFailure = useSyncExternalStore(
    subscribeToLocation,
    getLaunchFailureSnapshot,
    getServerLaunchFailure,
  );
  const startError = useSyncExternalStore(
    subscribeToLocation,
    getStartErrorSnapshot,
    getServerStartError,
  );
  const startErrorMessage = startError
    ? copy.errors[startError] ?? copy.errors.OPERATION_FAILED
    : null;

  const failureReason = state.state === "failed" ? state.reason : null;
  const failureMessage = failureReason
    ? copy.errors[failureReason] ?? copy.errors.failed
    : null;

  const connectedOpenBotHref =
    state.state === "connected"
      ? isAndroidTelegramLaunch
        ? telegramLaunchOrigin
          ? buildAndroidTelegramLaunchTarget(
              state.openUrl,
              buildTelegramLaunchFallbackUrl(telegramLaunchOrigin),
            )
          : null
        : state.openUrl
      : null;

  const recoverKey =
    state.state === "recoverable"
      ? `${state.connectionId ?? "attempt"}:${state.attemptId}`
      : null;
  const recoveryStarted = useRef<string | null>(null);

  const recoverCandidate = useCallback(
    (connectionId: string | null, attemptId: string) => {
      setActionError(null);
      startTransition(async () => {
        const result = await recoverMerchantTelegramConnection(
          connectionId ? { connectionId } : { attemptId },
        );

        if (result.ok) {
          router.refresh();
        } else {
          setActionError(
            copy.errors[result.error] ?? copy.errors.OPERATION_FAILED,
          );
        }
      });
    },
    [copy.errors, router, startTransition],
  );

  useEffect(() => {
    if (!recoverKey || readOnly) return;
    if (recoveryStarted.current === recoverKey) return;

    recoveryStarted.current = recoverKey;

    if (state.state !== "recoverable") return;

    const connectionId = state.connectionId;
    const attemptId = state.attemptId;
    const timer = window.setTimeout(() => {
      recoverCandidate(connectionId, attemptId);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [recoverKey, readOnly, recoverCandidate, state]);

  useEffect(() => {
    if (readOnly) return;

    function refresh() {
      router.refresh();
    }

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refresh();
    }

    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);

    const shouldPoll = state.state === "waiting" || state.state === "preparing";
    const interval = shouldPoll ? window.setInterval(refresh, 5_000) : null;

    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      if (interval) window.clearInterval(interval);
    };
  }, [readOnly, router, state.state]);

  function handleResult(result: MerchantTelegramActionResult) {
    if (result.ok) {
      setActionError(null);
      router.refresh();

      // Android starts through the POST route instead, so this JS navigation
      // is only reached on iOS/desktop where the original HTTPS link is kept.
      if (result.deepLink) window.location.assign(result.deepLink);

      return;
    }

    setActionError(copy.errors[result.error] ?? copy.errors.OPERATION_FAILED);
  }

  function startConnection() {
    setActionError(null);
    startTransition(async () => {
      handleResult(await startMerchantTelegramConnection());
    });
  }

  function confirmConnection(connectionId: string) {
    setActionError(null);
    startTransition(async () => {
      handleResult(
        await confirmMerchantTelegramConnection({ connectionId }),
      );
    });
  }

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid="merchant-telegram-connection"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 font-heading text-lg font-semibold">
            <Send className="size-4 text-muted-foreground" aria-hidden="true" />
            {copy.title}
          </h2>
          <p className="text-sm text-muted-foreground">{copy.intro}</p>
        </div>
        {state.state === "connected" ? (
          <span
            className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-3 text-sm font-medium text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200"
            data-testid="merchant-telegram-connected"
          >
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {copy.connectedTitle}
          </span>
        ) : null}
      </div>

      {readOnly ? (
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          {copy.readOnly}
        </p>
      ) : null}

      {state.state === "not_connected" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{copy.notConnected}</p>
          <StartAttemptControl
            isAndroid={isAndroidTelegramLaunch}
            readOnly={readOnly}
            isPending={isPending}
            onStart={startConnection}
            label={copy.connect}
            testId="merchant-telegram-connect"
            icon={<Send className="size-4" aria-hidden="true" />}
          />
        </div>
      ) : null}

      {state.state === "waiting" ? (
        <div className="space-y-3" data-testid="merchant-telegram-waiting">
          <p className="font-medium">{copy.waitingTitle}</p>
          <p className="text-sm text-muted-foreground">
            {state.telegramBound
              ? copy.waitingProvisioning
              : copy.waitingOpen}
          </p>
          {state.lastError ? (
            <p
              role="status"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              data-testid="merchant-telegram-waiting-error"
            >
              {copy.errors[state.lastError] ?? copy.errors.failed}
            </p>
          ) : null}
          {launchFailure ? (
            <div
              role="status"
              className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              data-testid="merchant-telegram-launch-failure"
            >
              <p className="font-medium">{copy.launchFailedTitle}</p>
              <p>{copy.launchFailedBody}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button asChild className="min-h-11">
              <a
                href={
                  isAndroidTelegramLaunch && telegramLaunchOrigin
                    ? buildAndroidTelegramLaunchTarget(
                        state.deepLink,
                        buildTelegramLaunchFallbackUrl(telegramLaunchOrigin),
                      )
                    : state.deepLink
                }
                rel="noreferrer"
                data-testid="merchant-telegram-open"
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                {copy.openTelegram}
              </a>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => router.refresh()}
              disabled={isPending}
              data-testid="merchant-telegram-refresh"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {copy.refresh}
            </Button>
          </div>
        </div>
      ) : null}

      {state.state === "preparing" ? (
        <div className="space-y-3" data-testid="merchant-telegram-preparing">
          <p className="font-medium">{copy.preparingTitle}</p>
          <p className="text-sm text-muted-foreground">
            {copy.preparingBody}
          </p>
          {state.botName || state.botUsername ? (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              {state.botName ? (
                <p
                  className="break-words font-medium"
                  data-testid="merchant-telegram-bot-name"
                >
                  {state.botName}
                </p>
              ) : null}
              {state.botUsername ? (
                <p
                  className="break-all font-mono text-sm"
                  data-testid="merchant-telegram-bot-username"
                >
                  @{state.botUsername}
                </p>
              ) : null}
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => router.refresh()}
            disabled={isPending}
            data-testid="merchant-telegram-refresh"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {copy.refresh}
          </Button>
        </div>
      ) : null}

      {state.state === "recoverable" ? (
        <div className="space-y-3" data-testid="merchant-telegram-recoverable">
          <p className="font-medium">{copy.recoverTitle}</p>
          <p className="text-sm text-muted-foreground">{copy.recoverBody}</p>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            {state.botName ? (
              <p
                className="break-words font-medium"
                data-testid="merchant-telegram-bot-name"
              >
                {state.botName}
              </p>
            ) : null}
            <p
              className="break-all font-mono text-sm"
              data-testid="merchant-telegram-bot-username"
            >
              @{state.botUsername}
            </p>
          </div>
          <Button
            type="button"
            className="min-h-11"
            disabled={readOnly || isPending}
            onClick={() => {
              recoveryStarted.current = null;
              recoverCandidate(state.connectionId, state.attemptId);
            }}
            data-testid="merchant-telegram-recover"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {isPending ? copy.recovering : copy.recover}
          </Button>
        </div>
      ) : null}

      {state.state === "confirm" ? (
        <div className="space-y-3" data-testid="merchant-telegram-confirm">
          <p className="font-medium">{copy.confirmTitle}</p>
          <p className="text-sm text-muted-foreground">{copy.confirmBody}</p>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            {state.botName ? (
              <p
                className="break-words font-medium"
                data-testid="merchant-telegram-bot-name"
              >
                {state.botName}
              </p>
            ) : null}
            <p
              className="break-all font-mono text-sm"
              data-testid="merchant-telegram-bot-username"
            >
              @{state.botUsername}
            </p>
          </div>
          {state.lastError ? (
            <p
              role="status"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              data-testid="merchant-telegram-activation-error"
            >
              {copy.errors[state.lastError] ?? copy.errors.OPERATION_FAILED}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="min-h-11"
              disabled={readOnly || isPending}
              onClick={() => confirmConnection(state.connectionId)}
              data-testid="merchant-telegram-confirm-button"
            >
              <CheckCircle2 className="size-4" aria-hidden="true" />
              {copy.confirm}
            </Button>
          </div>
        </div>
      ) : null}

      {state.state === "connected" ? (
        <div className="space-y-3" data-testid="merchant-telegram-connected-panel">
          <p className="text-sm text-muted-foreground">
            {storeStatus === "active" ? copy.connectedBody : storeStatus === "onboarding" ? copy.unpublishedBody : copy.readOnly}
          </p>
          <p
            className="break-all rounded-lg border border-border bg-muted/30 p-3 font-mono text-sm"
            data-testid="merchant-telegram-bot-username"
          >
            @{state.botUsername}
          </p>
          {storeStatus === "onboarding" && !readOnly ? (
            <Button
              type="button"
              className="min-h-11"
              disabled={isPending}
              onClick={() => startTransition(async () => {
                const result = await publishMerchantTelegramStore();
                handleResult(result);
                if (!result.ok) router.refresh();
              })}
              data-testid="merchant-store-publish"
            >
              {copy.publish}
            </Button>
          ) : null}
          {launchFailure ||
          (isAndroidTelegramLaunch && connectedOpenBotHref === null) ? (
            <div
              role="status"
              className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              data-testid="merchant-telegram-open-bot-launch-failure"
            >
              <p className="font-medium">{copy.launchFailedTitle}</p>
              <p>{copy.openBotLaunchFailedBody}</p>
            </div>
          ) : null}
          {storeStatus === "active" ? (
            connectedOpenBotHref ? (
              <Button asChild className="min-h-11">
                <a
                  href={connectedOpenBotHref}
                  {...(isAndroidTelegramLaunch
                    ? {}
                    : { target: "_blank" })}
                  rel="noreferrer"
                  data-testid="merchant-telegram-open-bot"
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  {copy.openBot}
                </a>
              </Button>
            ) : (
              <Button
                type="button"
                className="min-h-11"
                disabled
                data-testid="merchant-telegram-open-bot"
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                {copy.openBot}
              </Button>
            )
          ) : null}
        </div>
      ) : null}

      {state.state === "failed" ? (
        <div className="space-y-3" data-testid="merchant-telegram-failed">
          <p className="font-medium">
            {state.reason === "expired"
              ? copy.expiredTitle
              : copy.failedTitle}
          </p>
          <p className="text-sm text-muted-foreground">{failureMessage}</p>
          {state.retryable ? (
            <StartAttemptControl
              isAndroid={isAndroidTelegramLaunch}
              readOnly={readOnly}
              isPending={isPending}
              onStart={startConnection}
              label={copy.retry}
              testId="merchant-telegram-retry"
              icon={<RefreshCw className="size-4" aria-hidden="true" />}
            />
          ) : null}
        </div>
      ) : null}

      {actionError ?? startErrorMessage ? (
        <p
          role="status"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="merchant-telegram-error"
        >
          {actionError ?? startErrorMessage}
        </p>
      ) : null}
    </section>
  );
}
