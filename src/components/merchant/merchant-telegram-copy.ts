import type { MerchantLocale } from "@/components/merchant/language-toggle";

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

export const MERCHANT_TELEGRAM_COPY: Record<MerchantLocale, Copy> = {
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
      activation_commit_failed: "تعذر إتمام التفعيل. أعد المحاولة.",
      activation_lease_lost: "تغيرت محاولة الربط. حدّث الحالة ثم أعد المحاولة.",
      activation_conflict: "هناك تفعيل آخر قيد التنفيذ. أعد المحاولة.",
      activation_superseded: "تم استبدال محاولة التفعيل. ابدأ محاولة جديدة.",
      webhook_inspection_failed: "تعذر فحص ويبهوك البوت. أعد المحاولة.",
      secret_unavailable: "تعذر تجهيز بيانات البوت. أعد المحاولة.",
      foreign_webhook: "هذا البوت مرتبط بويبهوك آخر لا يملكه هذا المتجر.",
      webhook_outcome_unknown:
        "لم نتمكن من تأكيد نتيجة تسجيل ويبهوك البوت. البوت قيد المراجعة ولا يمكن إعادة المحاولة أو إنشاء بوت آخر الآن. تواصل مع الدعم.",
      RETRYABLE: "لم يكتمل تفعيل تيليجرام. أعد المحاولة.",
      REVIEW:
        "البوت قيد المراجعة الأمنية. لا تبدأ من جديد أو تنشئ بوتًا آخر. تواصل مع الدعم.",
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
      activation_commit_failed: "Activation could not be completed. Try again.",
      activation_lease_lost: "The activation changed. Refresh and try again.",
      activation_conflict: "Another activation is in progress. Try again.",
      activation_superseded: "This activation was superseded. Start a new attempt.",
      webhook_inspection_failed: "The bot webhook could not be inspected. Try again.",
      secret_unavailable: "The bot credentials could not be prepared. Try again.",
      foreign_webhook: "This bot already has a webhook that is not owned by this store.",
      webhook_outcome_unknown:
        "We could not confirm whether the bot webhook was registered. The bot is under review; do not retry or create another bot. Contact support.",
      RETRYABLE: "Telegram activation did not complete. Try again.",
      REVIEW:
        "This bot is under security review. Do not start over or create another bot. Contact support.",
      unavailable: "The connection state is unavailable right now. Try again.",
      failed: "The bot connection was not completed. Try again.",
    },
  },
};


export type { Copy as MerchantTelegramCopy };
