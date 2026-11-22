"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, RefreshCw, Send } from "lucide-react";

import type { MerchantLocale } from "@/components/merchant/language-toggle";
import type { MerchantTelegramConnectionState } from "@/lib/telegram/manager-provisioning";
import {
  confirmMerchantTelegramConnection,
  startMerchantTelegramConnection,
  type MerchantTelegramActionResult,
} from "@/app/actions/merchant-telegram";
import { Button } from "@/components/ui/button";

type Copy = {
  title: string;
  intro: string;
  notConnected: string;
  connect: string;
  retry: string;
  waitingTitle: string;
  waitingOpen: string;
  waitingTelegram: string;
  waitingProvisioning: string;
  openTelegram: string;
  refresh: string;
  confirmTitle: string;
  confirmBody: string;
  confirm: string;
  startOver: string;
  connectedTitle: string;
  connectedBody: string;
  openBot: string;
  expiredTitle: string;
  failedTitle: string;
  readOnly: string;
  errors: Record<string, string>;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    title: "بوت المتجر على تيليجرام",
    intro:
      "اربط بوتًا واحدًا لخدمة عملاء متجرك. يتم إنشاء البوت عبر تيليجرام ثم تؤكد ارتباطه هنا.",
    notConnected: "لم يتم ربط بوت المتجر بعد.",
    connect: "ربط تيليجرام",
    retry: "إعادة المحاولة",
    waitingTitle: "بانتظار تأكيد تيليجرام…",
    waitingOpen: "افتح تيليجرام وأنشئ بوت متجرك من الرسالة.",
    waitingTelegram:
      "تم فتح الرابط. أكمل إنشاء البوت في تيليجرام ثم ارجع وحدّث الحالة.",
    waitingProvisioning:
      "تم استلام البوت. يجري التحقق من بياناته وربط الويبهوك…",
    openTelegram: "فتح تيليجرام",
    refresh: "تحديث الحالة",
    confirmTitle: "تأكيد بوت المتجر",
    confirmBody:
      "تحقق من اسم البوت أدناه. لا يتم تفعيل الاتصال حتى تؤكد أنه البوت الذي أنشأته لهذا المتجر.",
    confirm: "تأكيد الربط",
    startOver: "البدء من جديد",
    connectedTitle: "تم ربط البوت",
    connectedBody: "هذا البوت متصل بمتجرك وهو جاهز لاستقبال العملاء.",
    openBot: "فتح البوت في تيليجرام",
    expiredTitle: "انتهت صلاحية رابط الربط.",
    failedTitle: "لم يكتمل ربط البوت.",
    readOnly: "المتجر موقوف مؤقتًا، ولا يمكن تغيير اتصال تيليجرام الآن.",
    errors: {
      UNAVAILABLE: "ربط تيليجرام غير متاح في هذه البيئة.",
      DENIED: "لا يمكن تنفيذ هذا الإجراء لحسابك أو حالة متجرك الحالية.",
      NOT_FOUND: "لم يعد هذا الارتباط موجودًا. ابدأ محاولة جديدة.",
      EXPIRED: "انتهت صلاحية المحاولة. ابدأ محاولة جديدة.",
      CONFLICT: "هناك محاولة أخرى قيد التنفيذ. حدّث الحالة ثم أعد المحاولة.",
      OPERATION_FAILED: "تعذر إكمال العملية. أعد المحاولة.",
      expired: "انتهت صلاحية رابط الربط. ابدأ محاولة جديدة.",
      superseded: "تم استبدال هذه المحاولة بمحاولة أحدث.",
      token_fetch_failed: "تعذر الحصول على بيانات البوت من تيليجرام. أعد المحاولة.",
      verification_failed: "تعذر التحقق من هوية البوت. أعد المحاولة.",
      webhook_registration_failed: "تعذر ربط الويبهوك بالبوت. أعد المحاولة.",
      webhook_verification_failed: "تعذر تأكيد الويبهوك. أعد المحاولة.",
      bot_bound_elsewhere: "هذا البوت مرتبط بمتجر آخر.",
      ambiguous_event: "تعذر ربط حدث تيليجرام بمحاولة واحدة. ابدأ محاولة جديدة.",
      connection_persist_failed: "تعذر حفظ الاتصال. أعد المحاولة.",
      unavailable: "حالة الاتصال غير متاحة الآن. أعد المحاولة.",
      failed: "لم يكتمل ربط البوت. أعد المحاولة.",
    },
  },
  en: {
    title: "Telegram store bot",
    intro:
      "Connect one bot to serve your store customers. Telegram creates the bot, then you confirm the connection here.",
    notConnected: "No store bot is connected yet.",
    connect: "Connect Telegram",
    retry: "Try again",
    waitingTitle: "Waiting for Telegram…",
    waitingOpen: "Open Telegram and create your store bot from the message.",
    waitingTelegram:
      "The link is open. Finish creating the bot in Telegram, then return and refresh the status.",
    waitingProvisioning:
      "The bot was received. Verifying its identity and registering the webhook…",
    openTelegram: "Open Telegram",
    refresh: "Refresh status",
    confirmTitle: "Confirm the store bot",
    confirmBody:
      "Check the bot username below. The connection is not enabled until you confirm this is the bot you created for this store.",
    confirm: "Confirm connection",
    startOver: "Start over",
    connectedTitle: "Bot connected",
    connectedBody: "This bot is connected to your store and ready for customers.",
    openBot: "Open the bot in Telegram",
    expiredTitle: "The connection link expired.",
    failedTitle: "The bot connection was not completed.",
    readOnly:
      "The store is suspended, so the Telegram connection cannot be changed right now.",
    errors: {
      UNAVAILABLE: "Telegram connection is not available in this environment.",
      DENIED: "This action is not allowed for your account or store state.",
      NOT_FOUND: "This connection no longer exists. Start a new attempt.",
      EXPIRED: "The attempt expired. Start a new attempt.",
      CONFLICT: "Another attempt is in progress. Refresh and try again.",
      OPERATION_FAILED: "The operation could not be completed. Try again.",
      expired: "The connection link expired. Start a new attempt.",
      superseded: "This attempt was replaced by a newer one.",
      token_fetch_failed: "Telegram did not return the bot token. Try again.",
      verification_failed: "The bot identity could not be verified. Try again.",
      webhook_registration_failed: "The bot webhook could not be registered. Try again.",
      webhook_verification_failed: "The bot webhook could not be verified. Try again.",
      bot_bound_elsewhere: "This bot is already connected to another store.",
      ambiguous_event: "A Telegram event could not be matched to one attempt. Start a new attempt.",
      connection_persist_failed: "The connection could not be saved. Try again.",
      unavailable: "The connection state is unavailable right now. Try again.",
      failed: "The bot connection was not completed. Try again.",
    },
  },
};

export function MerchantTelegramConnection({
  state,
  locale,
  readOnly,
}: {
  state: MerchantTelegramConnectionState;
  locale: MerchantLocale;
  readOnly: boolean;
}) {
  const copy = COPY[locale];
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const failureReason = state.state === "failed" ? state.reason : null;
  const failureMessage = failureReason
    ? copy.errors[failureReason] ?? copy.errors.failed
    : null;

  function handleResult(result: MerchantTelegramActionResult) {
    if (result.ok) {
      setActionError(null);
      router.refresh();
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
          <Button
            type="button"
            className="min-h-11"
            disabled={readOnly || isPending}
            onClick={startConnection}
            data-testid="merchant-telegram-connect"
          >
            <Send className="size-4" aria-hidden="true" />
            {copy.connect}
          </Button>
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
          <div className="flex flex-wrap gap-2">
            <Button asChild className="min-h-11">
              <a
                href={state.deepLink}
                target="_blank"
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

      {state.state === "confirm" ? (
        <div className="space-y-3" data-testid="merchant-telegram-confirm">
          <p className="font-medium">{copy.confirmTitle}</p>
          <p className="text-sm text-muted-foreground">{copy.confirmBody}</p>
          <p
            className="break-all rounded-lg border border-border bg-muted/30 p-3 font-mono text-sm"
            data-testid="merchant-telegram-bot-username"
          >
            @{state.botUsername}
          </p>
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
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={readOnly || isPending}
              onClick={startConnection}
            >
              {copy.startOver}
            </Button>
          </div>
        </div>
      ) : null}

      {state.state === "connected" ? (
        <div className="space-y-3" data-testid="merchant-telegram-connected-panel">
          <p className="text-sm text-muted-foreground">{copy.connectedBody}</p>
          <p
            className="break-all rounded-lg border border-border bg-muted/30 p-3 font-mono text-sm"
            data-testid="merchant-telegram-bot-username"
          >
            @{state.botUsername}
          </p>
          <Button asChild className="min-h-11">
            <a
              href={state.openUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="merchant-telegram-open-bot"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {copy.openBot}
            </a>
          </Button>
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
          <Button
            type="button"
            className="min-h-11"
            disabled={readOnly || isPending}
            onClick={startConnection}
            data-testid="merchant-telegram-retry"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {copy.retry}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p
          role="status"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="merchant-telegram-error"
        >
          {actionError}
        </p>
      ) : null}
    </section>
  );
}
