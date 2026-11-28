"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Languages, Loader2, Package, Send, Wallet } from "lucide-react";

import {
  saveMerchantStoreLanguageAction,
  saveMerchantTelegramSupportAction,
  saveMerchantVodafoneCashAction,
} from "@/app/actions/merchant-settings";

import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { MerchantInstallHelp } from "@/components/merchant/merchant-install-help";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import {
  MerchantNeedsAttention,
  type MerchantNeedsAttentionOrder,
} from "@/components/merchant/merchant-needs-attention";
import { MerchantCommerceSettings } from "@/components/merchant/merchant-commerce-settings";
import { MerchantNotificationBot } from "@/components/merchant/merchant-notification-bot";
import { MerchantTelegramConnection } from "@/components/merchant/merchant-telegram-connection";
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { Button } from "@/components/ui/button";
import type { StoreStatus } from "@/db/schema/tenant";
import type { MerchantNotificationBotState } from "@/lib/data/merchant-notification-bot";
import type { NotificationManagedAttemptState } from "@/lib/telegram/manager-provisioning";
import type { MerchantCommerceSetting } from "@/lib/merchant/store-commerce";
import type { VodafoneCashSetting } from "@/lib/merchant/store-vodafone-cash";
import type { MerchantTelegramConnectionState } from "@/lib/telegram/manager-provisioning";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  accountLabel: string;
  setupStatusLabel: string;
  status: Record<StoreStatus, string>;
  productsTitle: string;
  productsBody: string;
  manageProducts: string;
  ordersTitle: string;
  ordersBody: string;
  viewOrders: string;
  logout: string;
  languageLabel: string;
  storeLanguageTitle: string;
  storeLanguageBody: string;
  storeLanguageArabic: string;
  storeLanguageEnglish: string;
  saveLanguage: string;
  savingLanguage: string;
  languageSaved: string;
  languageError: string;
  supportTitle: string;
  supportBody: string;
  supportLabel: string;
  supportPlaceholder: string;
  supportHint: string;
  supportExampleTitle: string;
  supportExample: string;
  supportSave: string;
  supportSaving: string;
  supportSaved: string;
  supportRemoved: string;
  supportInvalid: string;
  supportError: string;
  vodafoneTitle: string;
  vodafoneBody: string;
  vodafoneEnabledLabel: string;
  vodafoneEnabledHint: string;
  vodafoneNumberLabel: string;
  vodafoneNumberPlaceholder: string;
  vodafoneAccountLabel: string;
  vodafoneAccountPlaceholder: string;
  vodafoneInstructionsArLabel: string;
  vodafoneInstructionsEnLabel: string;
  vodafoneInstructionsHint: string;
  vodafoneSave: string;
  vodafoneSaving: string;
  vodafoneSaved: string;
  vodafoneInvalid: string;
  vodafoneError: string;
  vodafoneNotConfigured: string;
  suspendedTitle: string;
  suspendedBody: string;
  pendingBody: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "إعداد المتجر",
    subtitle: "هذه هي الخطوة الأولى في رحلة إعداد متجرك.",
    storeLabel: "المتجر",
    accountLabel: "حساب التاجر",
    setupStatusLabel: "حالة الإعداد",
    status: {
      onboarding: "قيد الإعداد",
      active: "نشط",
      suspended: "موقوف",
    },
    productsTitle: "المنتجات",
    productsBody: "راجع منتجات متجرك وحدّث سعر كل منتج.",
    manageProducts: "إدارة المنتجات",
    ordersTitle: "طلبات الدفع عند الاستلام",
    ordersBody: "راجع طلبات الدفع عند الاستلام الخاصة بمتجرك.",
    viewOrders: "عرض الطلبات",
    logout: "تسجيل الخروج",
    languageLabel: "لغة الصفحة",
    storeLanguageTitle: "لغة العملاء الافتراضية",
    storeLanguageBody:
      "اختر اللغة التي يبدأ بها المتسوقون في متجرك. يمكن للعميل تغييرها بنفسه، ويبقى اختياره مرتبطًا بهذا المتجر فقط.",
    storeLanguageArabic: "العربية",
    storeLanguageEnglish: "English",
    saveLanguage: "حفظ اللغة",
    savingLanguage: "جارٍ الحفظ...",
    languageSaved: "تم حفظ لغة المتجر.",
    languageError: "تعذّر حفظ اللغة. حاول مرة أخرى.",
    supportTitle: "حساب دعم تيليجرام",
    supportBody:
      "أضف حسابًا واحدًا ليتمكن العملاء من فتح محادثة مباشرة معك من صفحة المنتج.",
    supportLabel: "اسم مستخدم حساب الدعم",
    supportPlaceholder: "@store_support أو https://t.me/store_support",
    supportHint:
      "أدخل @username أو رابط https://t.me/username. اتركه فارغًا لإزالة الحساب.",
    supportExampleTitle: "مثال رسالة المسودة",
    supportExample: "مرحبًا، عندي سؤال عن {productName}: ",
    supportSave: "حفظ حساب الدعم",
    supportSaving: "جارٍ الحفظ...",
    supportSaved: "تم حفظ حساب الدعم.",
    supportRemoved: "تمت إزالة حساب الدعم.",
    supportInvalid:
      "أدخل @username صالحًا أو رابط https://t.me/username.",
    supportError: "تعذّر حفظ حساب الدعم. حاول مرة أخرى.",
    vodafoneTitle: "فودافون كاش — تحويل يدوي",
    vodafoneBody:
      "اسمح للعملاء بالتحويل إلى محفظتك ثم راجع كل تحويل من صفحة الطلبات قبل تأكيد الدفع. لا يتم تأكيد أي طلب تلقائيًا.",
    vodafoneEnabledLabel: "إظهار فودافون كاش عند إتمام الطلب",
    vodafoneEnabledHint:
      "لن يظهر الخيار للعملاء إلا بعد حفظ الرقم واسم المستلم وتعليمات التحويل.",
    vodafoneNumberLabel: "رقم محفظة فودافون كاش",
    vodafoneNumberPlaceholder: "01xxxxxxxxx",
    vodafoneAccountLabel: "اسم مستلم التحويل",
    vodafoneAccountPlaceholder: "الاسم الظاهر في المحفظة",
    vodafoneInstructionsArLabel: "تعليمات التحويل بالعربية",
    vodafoneInstructionsEnLabel: "تعليمات التحويل بالإنجليزية",
    vodafoneInstructionsHint:
      "اكتب تعليمات واضحة على الأقل بلغة واحدة. ستظهر تعليمات لغة العميل إن توفرت، وإلا ستُستخدم اللغة الأخرى.",
    vodafoneSave: "حفظ إعدادات فودافون كاش",
    vodafoneSaving: "جارٍ الحفظ…",
    vodafoneSaved: "تم حفظ إعدادات فودافون كاش.",
    vodafoneInvalid:
      "راجع الرقم واسم المستلم والتعليمات. عند التفعيل يجب إدخال رقم واسم مستلم وتعليمات بلغة واحدة على الأقل.",
    vodafoneError: "تعذّر حفظ إعدادات فودافون كاش. حاول مرة أخرى.",
    vodafoneNotConfigured:
      "إعدادات الدفع للمتجر غير مكتملة. فعّل إعدادات التجارة أولًا.",
    suspendedTitle: "المتجر موقوف مؤقتًا.",
    suspendedBody:
      "يمكنك الاطلاع على حالة المتجر فقط. التعديلات غير متاحة حتى يعيد مسؤول المنصة تفعيل المتجر.",
    pendingBody:
      "اربط بوت المتجر أدناه ليتمكن العملاء من تصفح منتجاتك على تيليجرام. ستبقى بقية خطوات الإعداد مراحل لاحقة.",
  },
  en: {
    dir: "ltr",
    title: "Store setup",
    subtitle: "This is the first step in setting up your store.",
    storeLabel: "Store",
    accountLabel: "Merchant account",
    setupStatusLabel: "Setup status",
    status: {
      onboarding: "Onboarding",
      active: "Active",
      suspended: "Suspended",
    },
    productsTitle: "Products",
    productsBody: "Review your store products and update each product price.",
    manageProducts: "Manage products",
    ordersTitle: "COD orders",
    ordersBody: "Review cash-on-delivery orders for your store.",
    viewOrders: "View orders",
    logout: "Sign out",
    languageLabel: "Page language",
    storeLanguageTitle: "Default customer language",
    storeLanguageBody:
      "Choose the language buyers start with in your store. A buyer can change it, and that choice stays scoped to this store.",
    storeLanguageArabic: "العربية",
    storeLanguageEnglish: "English",
    saveLanguage: "Save language",
    savingLanguage: "Saving...",
    languageSaved: "Store language saved.",
    languageError: "The language could not be saved. Try again.",
    supportTitle: "Telegram support account",
    supportBody:
      "Add one account so buyers can open a direct chat with you from a product page.",
    supportLabel: "Support account username",
    supportPlaceholder: "@store_support or https://t.me/store_support",
    supportHint:
      "Enter @username or an https://t.me/username link. Leave it empty to remove the account.",
    supportExampleTitle: "Example draft message",
    supportExample: "Hi, I have a question about {productName}: ",
    supportSave: "Save support account",
    supportSaving: "Saving...",
    supportSaved: "Support account saved.",
    supportRemoved: "Support account removed.",
    supportInvalid: "Enter a valid @username or https://t.me/username link.",
    supportError: "The support account could not be saved. Try again.",
    vodafoneTitle: "Vodafone Cash — manual transfer",
    vodafoneBody:
      "Let buyers transfer to your wallet, then review each transfer in Orders before confirming payment. Nothing is marked paid automatically.",
    vodafoneEnabledLabel: "Show Vodafone Cash at checkout",
    vodafoneEnabledHint:
      "Buyers see this option only after you save a wallet number, an account name and transfer instructions.",
    vodafoneNumberLabel: "Vodafone Cash wallet number",
    vodafoneNumberPlaceholder: "01xxxxxxxxx",
    vodafoneAccountLabel: "Transfer recipient name",
    vodafoneAccountPlaceholder: "The name shown on the wallet",
    vodafoneInstructionsArLabel: "Transfer instructions in Arabic",
    vodafoneInstructionsEnLabel: "Transfer instructions in English",
    vodafoneInstructionsHint:
      "Write clear instructions in at least one language. Buyers see their UI language when available, otherwise the other language.",
    vodafoneSave: "Save Vodafone Cash settings",
    vodafoneSaving: "Saving…",
    vodafoneSaved: "Vodafone Cash settings saved.",
    vodafoneInvalid:
      "Check the number, account name and instructions. When enabled, a number, account name and at least one instruction language are required.",
    vodafoneError: "The Vodafone Cash settings could not be saved. Try again.",
    vodafoneNotConfigured:
      "Store commerce settings are incomplete. Configure commerce before enabling this method.",
    suspendedTitle: "This store is suspended.",
    suspendedBody:
      "You can review the store status only. Editing is unavailable until a platform administrator reactivates the store.",
    pendingBody:
      "Connect your store bot below so customers can browse your products on Telegram. The remaining setup steps arrive in later phases.",
  },
};

const STATUS_CLASS: Record<StoreStatus, string> = {
  onboarding:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200",
  active:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200",
  suspended: "border-destructive/30 bg-destructive/5 text-destructive",
};

export function MerchantSetup({
  storeName,
  email,
  status,
  readOnly,
  initialLocale,
  telegramConnection,
  isAndroidTelegramLaunch,
  telegramLaunchOrigin,
  codOrdersEnabled,
  needsAttentionOrders,
  needsAttentionTotal,
  needsAttentionTransfers = [],
  needsAttentionTransferTotal = 0,
  vodafoneCashSetting,
  commerceSetting,
  storeDefaultLanguageCode,
  telegramSupportUsername,
  notificationBot,
}: {
  storeName: string;
  email: string;
  status: StoreStatus;
  readOnly: boolean;
  initialLocale: MerchantLocale;
  telegramConnection: MerchantTelegramConnectionState;
  isAndroidTelegramLaunch: boolean;
  telegramLaunchOrigin: string | null;
  codOrdersEnabled: boolean;
  needsAttentionOrders: MerchantNeedsAttentionOrder[];
  needsAttentionTotal: number;
  needsAttentionTransfers?: MerchantNeedsAttentionOrder[];
  needsAttentionTransferTotal?: number;
  vodafoneCashSetting: VodafoneCashSetting | null;
  commerceSetting: MerchantCommerceSetting | null;
  storeDefaultLanguageCode: "ar" | "en";
  telegramSupportUsername: string | null;
  notificationBot: {
    supported: boolean;
    state: MerchantNotificationBotState | null;
    managed: NotificationManagedAttemptState | null;
  };
}) {
  const [locale, setLocale] = useMerchantLocale(initialLocale, "setup");
  const copy = COPY[locale];
  const statusLabel = copy.status[status];
  const secondaryStatusLabel = COPY[locale === "ar" ? "en" : "ar"].status[status];
  const router = useRouter();
  const [storeLanguage, setStoreLanguage] = useState<"ar" | "en">(
    storeDefaultLanguageCode,
  );
  const [languageMessage, setLanguageMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [isSavingLanguage, startSavingLanguage] = useTransition();
  const [supportUsername, setSupportUsername] = useState(
    telegramSupportUsername ?? "",
  );
  const [supportMessage, setSupportMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [isSavingSupport, startSavingSupport] = useTransition();
  const [vodafoneEnabled, setVodafoneEnabled] = useState(
    vodafoneCashSetting?.enabled ?? false,
  );
  const [vodafoneNumber, setVodafoneNumber] = useState(
    vodafoneCashSetting?.number ?? "",
  );
  const [vodafoneAccountName, setVodafoneAccountName] = useState(
    vodafoneCashSetting?.accountName ?? "",
  );
  const [vodafoneInstructionsAr, setVodafoneInstructionsAr] = useState(
    vodafoneCashSetting?.instructionsAr ?? "",
  );
  const [vodafoneInstructionsEn, setVodafoneInstructionsEn] = useState(
    vodafoneCashSetting?.instructionsEn ?? "",
  );
  const [vodafoneMessage, setVodafoneMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [isSavingVodafone, startSavingVodafone] = useTransition();

  function saveStoreLanguage() {
    setLanguageMessage(null);
    startSavingLanguage(async () => {
      const result = await saveMerchantStoreLanguageAction({
        code: storeLanguage,
      });

      if (result.ok) {
        setLanguageMessage({ ok: true, text: copy.languageSaved });
        router.refresh();
      } else {
        setLanguageMessage({ ok: false, text: copy.languageError });
      }
    });
  }

  function saveVodafoneCash(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVodafoneMessage(null);

    startSavingVodafone(async () => {
      const result = await saveMerchantVodafoneCashAction({
        enabled: vodafoneEnabled,
        number: vodafoneNumber,
        accountName: vodafoneAccountName,
        instructionsAr: vodafoneInstructionsAr,
        instructionsEn: vodafoneInstructionsEn,
      });

      if (result.ok) {
        setVodafoneMessage({ ok: true, text: copy.vodafoneSaved });
        router.refresh();
        return;
      }

      setVodafoneMessage({
        ok: false,
        text:
          result.error === "COMMERCE_NOT_CONFIGURED"
            ? copy.vodafoneNotConfigured
            : result.error === "INVALID_CONFIG"
              ? copy.vodafoneInvalid
              : copy.vodafoneError,
      });
    });
  }

  function saveTelegramSupport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSupportMessage(null);

    startSavingSupport(async () => {
      const result = await saveMerchantTelegramSupportAction({
        username: supportUsername,
      });

      if (result.ok) {
        setSupportUsername(result.username ?? "");
        setSupportMessage({
          ok: true,
          text: result.username ? copy.supportSaved : copy.supportRemoved,
        });
        router.refresh();
        return;
      }

      setSupportMessage({
        ok: false,
        text:
          result.error === "INVALID_USERNAME"
            ? copy.supportInvalid
            : copy.supportError,
      });
    });
  }

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-setup-page"
    >
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Logo className="text-lg" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <MerchantLanguageToggle
              locale={locale}
              onChange={setLocale}
              label={copy.languageLabel}
            />
            <MerchantLogoutButton label={copy.logout} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8">
        <div className="space-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {copy.title}
          </h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>

        <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                {copy.storeLabel}
              </p>
              <h2
                className="break-words font-heading text-xl font-semibold"
                data-testid="merchant-store-name"
              >
                {storeName}
              </h2>
            </div>
            <span
              className={`inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-medium ${STATUS_CLASS[status]}`}
              data-testid="merchant-store-status"
            >
              {statusLabel}
              <span className="sr-only"> — {secondaryStatusLabel}</span>
            </span>
          </div>

          <dl className="grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">{copy.accountLabel}</dt>
              <dd className="break-all font-medium">{email}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">
                {copy.setupStatusLabel}
              </dt>
              <dd className="font-medium">
                {statusLabel}{" "}
                <span className="text-muted-foreground">
                  ({secondaryStatusLabel})
                </span>
              </dd>
            </div>
          </dl>
        </section>

        {codOrdersEnabled ||
        needsAttentionTotal > 0 ||
        needsAttentionTransferTotal > 0 ? (
          <MerchantNeedsAttention
            locale={locale}
            orders={needsAttentionOrders}
            totalPending={needsAttentionTotal}
            transferOrders={needsAttentionTransfers}
            totalTransfersPending={needsAttentionTransferTotal}
          />
        ) : null}

        <MerchantTelegramConnection
          state={telegramConnection}
          storeStatus={status}
          locale={locale}
          readOnly={readOnly}
          isAndroidTelegramLaunch={isAndroidTelegramLaunch}
          telegramLaunchOrigin={telegramLaunchOrigin}
        />

        <MerchantNotificationBot
          state={notificationBot.state}
          supported={notificationBot.supported}
          managed={notificationBot.managed}
          locale={locale}
          readOnly={readOnly}
          isAndroidTelegramLaunch={isAndroidTelegramLaunch}
          telegramLaunchOrigin={telegramLaunchOrigin}
        />

        <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Languages className="size-5" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="font-heading text-lg font-semibold">
                {copy.storeLanguageTitle}
              </h2>
              <p className="text-sm text-muted-foreground">
                {copy.storeLanguageBody}
              </p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["ar", copy.storeLanguageArabic],
                ["en", copy.storeLanguageEnglish],
              ] as const
            ).map(([code, label]) => (
              <label
                key={code}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
                  storeLanguage === code
                    ? "border-primary bg-primary/5"
                    : "border-input bg-background"
                } ${readOnly ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <input
                  type="radio"
                  name="store-default-language"
                  value={code}
                  checked={storeLanguage === code}
                  disabled={readOnly || isSavingLanguage}
                  onChange={() => {
                    setStoreLanguage(code);
                    setLanguageMessage(null);
                  }}
                  className="size-4 accent-primary"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {languageMessage ? (
            <p
              role="status"
              className={`text-sm font-medium ${
                languageMessage.ok
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-destructive"
              }`}
            >
              {languageMessage.text}
            </p>
          ) : null}

          <Button
            type="button"
            onClick={saveStoreLanguage}
            disabled={readOnly || isSavingLanguage}
            className="min-h-11 gap-2"
          >
            {isSavingLanguage ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Languages className="size-4" aria-hidden="true" />
            )}
            {isSavingLanguage ? copy.savingLanguage : copy.saveLanguage}
          </Button>
        </section>

        <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Send className="size-5" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="font-heading text-lg font-semibold">
                {copy.supportTitle}
              </h2>
              <p className="text-sm text-muted-foreground">
                {copy.supportBody}
              </p>
            </div>
          </div>

          <form onSubmit={saveTelegramSupport} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <label
                htmlFor="merchant-telegram-support"
                className="text-sm font-medium text-foreground"
              >
                {copy.supportLabel}
              </label>
              <input
                id="merchant-telegram-support"
                name="telegramSupportUsername"
                type="text"
                dir="ltr"
                inputMode="text"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                maxLength={80}
                value={supportUsername}
                onChange={(event) => {
                  setSupportUsername(event.target.value);
                  if (supportMessage) setSupportMessage(null);
                }}
                disabled={readOnly || isSavingSupport}
                placeholder={copy.supportPlaceholder}
                aria-describedby="merchant-telegram-support-hint"
                data-testid="merchant-telegram-support-input"
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-sm"
              />
              <p
                id="merchant-telegram-support-hint"
                className="text-xs text-muted-foreground"
              >
                {copy.supportHint}
              </p>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium text-foreground">
                {copy.supportExampleTitle}
              </p>
              <p dir="auto" className="mt-1 break-words text-muted-foreground">
                {copy.supportExample}
              </p>
            </div>

            {supportMessage ? (
              <p
                role="status"
                className={`text-sm font-medium ${
                  supportMessage.ok
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-destructive"
                }`}
              >
                {supportMessage.text}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={readOnly || isSavingSupport}
              className="min-h-11 w-full gap-2 sm:w-auto"
            >
              {isSavingSupport ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="size-4" aria-hidden="true" />
              )}
              {isSavingSupport ? copy.supportSaving : copy.supportSave}
            </Button>
          </form>
        </section>

        <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Wallet className="size-5" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="font-heading text-lg font-semibold">
                {copy.vodafoneTitle}
              </h2>
              <p className="text-sm text-muted-foreground">
                {copy.vodafoneBody}
              </p>
            </div>
          </div>

          <form onSubmit={saveVodafoneCash} className="space-y-3" noValidate>
            <label className="flex items-start gap-3 rounded-lg border border-input bg-background p-3 text-sm">
              <input
                type="checkbox"
                checked={vodafoneEnabled}
                onChange={(event) => {
                  setVodafoneEnabled(event.target.checked);
                  if (vodafoneMessage) setVodafoneMessage(null);
                }}
                disabled={readOnly || isSavingVodafone}
                className="mt-0.5 size-4 accent-primary"
                data-testid="merchant-vodafone-enabled"
              />
              <span className="space-y-1">
                <span className="block font-medium">
                  {copy.vodafoneEnabledLabel}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {copy.vodafoneEnabledHint}
                </span>
              </span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="merchant-vodafone-number"
                  className="text-sm font-medium"
                >
                  {copy.vodafoneNumberLabel}
                </label>
                <input
                  id="merchant-vodafone-number"
                  type="tel"
                  dir="ltr"
                  inputMode="tel"
                  autoComplete="off"
                  maxLength={32}
                  value={vodafoneNumber}
                  onChange={(event) => {
                    setVodafoneNumber(event.target.value);
                    if (vodafoneMessage) setVodafoneMessage(null);
                  }}
                  disabled={readOnly || isSavingVodafone}
                  placeholder={copy.vodafoneNumberPlaceholder}
                  data-testid="merchant-vodafone-number"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="merchant-vodafone-account"
                  className="text-sm font-medium"
                >
                  {copy.vodafoneAccountLabel}
                </label>
                <input
                  id="merchant-vodafone-account"
                  type="text"
                  maxLength={120}
                  value={vodafoneAccountName}
                  onChange={(event) => {
                    setVodafoneAccountName(event.target.value);
                    if (vodafoneMessage) setVodafoneMessage(null);
                  }}
                  disabled={readOnly || isSavingVodafone}
                  placeholder={copy.vodafoneAccountPlaceholder}
                  data-testid="merchant-vodafone-account"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-sm"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="merchant-vodafone-instructions-ar"
                  className="text-sm font-medium"
                >
                  {copy.vodafoneInstructionsArLabel}
                </label>
                <textarea
                  id="merchant-vodafone-instructions-ar"
                  dir="rtl"
                  rows={4}
                  maxLength={1000}
                  value={vodafoneInstructionsAr}
                  onChange={(event) => {
                    setVodafoneInstructionsAr(event.target.value);
                    if (vodafoneMessage) setVodafoneMessage(null);
                  }}
                  disabled={readOnly || isSavingVodafone}
                  data-testid="merchant-vodafone-instructions-ar"
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-base shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="merchant-vodafone-instructions-en"
                  className="text-sm font-medium"
                >
                  {copy.vodafoneInstructionsEnLabel}
                </label>
                <textarea
                  id="merchant-vodafone-instructions-en"
                  dir="ltr"
                  rows={4}
                  maxLength={1000}
                  value={vodafoneInstructionsEn}
                  onChange={(event) => {
                    setVodafoneInstructionsEn(event.target.value);
                    if (vodafoneMessage) setVodafoneMessage(null);
                  }}
                  disabled={readOnly || isSavingVodafone}
                  data-testid="merchant-vodafone-instructions-en"
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-base shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-sm"
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {copy.vodafoneInstructionsHint}
            </p>

            {vodafoneMessage ? (
              <p
                role="status"
                className={`text-sm font-medium ${
                  vodafoneMessage.ok
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-destructive"
                }`}
              >
                {vodafoneMessage.text}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={readOnly || isSavingVodafone}
              className="min-h-11 w-full gap-2 sm:w-auto"
              data-testid="merchant-vodafone-save"
            >
              {isSavingVodafone ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Wallet className="size-4" aria-hidden="true" />
              )}
              {isSavingVodafone ? copy.vodafoneSaving : copy.vodafoneSave}
            </Button>
          </form>
        </section>

        <MerchantCommerceSettings
          locale={locale}
          readOnly={readOnly}
          codOrdersEnabled={codOrdersEnabled}
          setting={commerceSetting}
        />

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h2 className="font-heading text-lg font-semibold">
                {copy.productsTitle}
              </h2>
              <p className="text-sm text-muted-foreground">
                {copy.productsBody}
              </p>
            </div>
            <Button asChild className="min-h-11">
              <Link href="/app/products" data-testid="merchant-products-link">
                <Package className="size-4" aria-hidden="true" />
                {copy.manageProducts}
              </Link>
            </Button>
          </div>
        </section>

        {codOrdersEnabled || vodafoneCashSetting?.enabled ? (
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <h2 className="font-heading text-lg font-semibold">
                  {copy.ordersTitle}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {copy.ordersBody}
                </p>
              </div>
              <Button asChild variant="outline" className="min-h-11">
                <Link
                  href="/app/orders"
                  data-testid="merchant-orders-link"
                >
                  {copy.viewOrders}
                </Link>
              </Button>
            </div>
          </section>
        ) : null}

        {readOnly ? (
          <div
            role="status"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            data-testid="merchant-suspended-notice"
          >
            <p className="font-semibold">{copy.suspendedTitle}</p>
            <p className="mt-1">{copy.suspendedBody}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            {copy.pendingBody}
          </div>
        )}
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/app/setup/storefront">
            {locale === "ar" ? "هوية واجهة المتجر" : "Storefront identity"}
          </Link>
        </Button>
        {!readOnly && telegramConnection.state === "connected" ? (
          <MerchantInstallHelp locale={locale} />
        ) : null}
      </main>
    </div>
  );
}
