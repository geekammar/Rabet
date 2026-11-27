import type { MerchantLocale } from "@/components/merchant/language-toggle";

type Copy = {
  title: string;
  intro: string;
  separateNotice: string;
  setupStepsTitle: string;
  setupSteps: string[];
  managedTitle: string;
  managedBody: string;
  managedCreate: string;
  managedWaiting: string;
  managedAwaitingStart: string;
  managedPreparing: string;
  managedOpenManager: string;
  managedOpenBot: string;
  managedCheck: string;
  managedChecking: string;
  managedResume: string;
  managedExpired: string;
  managedExpiredResume: string;
  managedFailed: string;
  advancedTitle: string;
  advancedBody: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHint: string;
  connect: string;
  connecting: string;
  pairingTitle: string;
  pairingBody: string;
  pairingExpires: string;
  openBot: string;
  newPairingLink: string;
  generatingLink: string;
  checkPairing: string;
  checkingPairing: string;
  pairedTitle: string;
  pairedBody: string;
  pairingAmbiguousTitle: string;
  destinationLabel: string;
  testTitle: string;
  testBody: string;
  sendTest: string;
  sendingTest: string;
  testAccepted: string;
  verified: string;
  notVerified: string;
  lastTest: string;
  changeChat: string;
  disconnect: string;
  disconnecting: string;
  disconnectHint: string;
  disconnected: string;
  statusConnected: string;
  statusPairing: string;
  statusPairingFailed: string;
  statusUnpaired: string;
  readOnly: string;
  unsupported: string;
  errors: Record<string, string>;
};

export const MERCHANT_NOTIFICATION_BOT_COPY: Record<MerchantLocale, Copy> = {
  ar: {
    title: "بوت إشعارات المتجر",
    intro:
      "اربط بوت تيليجرام خاصًا ليصلك إشعار عند وصول طلب أو استفسار جديد لمتجرك.",
    separateNotice:
      "هذا البوت منفصل تمامًا عن بوت المتجر الذي يستخدمه العملاء. لا تغيّر بوت العملاء من هنا.",
    setupStepsTitle: "خطوات الربط",
    setupSteps: [
      "أنشئ بوتًا جديدًا من @BotFather في تيليجرام.",
      "انسخ رمز البوت (Token) والصقه أدناه.",
      "افتح البوت من حسابك واضغط Start أو أرسل رمز الربط.",
      "أكّد محادثة الاستلام من هذه الصفحة.",
      "أرسل إشعارًا تجريبيًا للتأكد من وصول الرسائل.",
    ],
    managedTitle: "إنشاء بوت الإشعارات تلقائيًا",
    managedBody:
      "أنشئ بوت الإشعارات من تيليجرام دون نسخ أي رمز. سنربطه بمتجرك بعد تأكيدك في تيليجرام.",
    managedCreate: "إنشاء بوت الإشعارات",
    managedWaiting: "بانتظار فتح مدير البوت في تيليجرام",
    managedAwaitingStart: "تم إنشاء البوت. افتحه واضغط Start لإثبات ملكيته.",
    managedPreparing: "تيليجرام يعالج إنشاء البوت الآن.",
    managedOpenManager: "فتح مدير البوت",
    managedOpenBot: "افتح البوت واضغط Start",
    managedCheck: "تحقق من حالة الربط",
    managedChecking: "جارٍ التحقق…",
    managedResume: "استئناف التحقق من نفس البوت",
    managedExpired: "انتهت صلاحية محاولة الربط.",
    managedExpiredResume:
      "انتهت مهلة التحقق، لكن البوت نفسه ما زال محفوظًا. استأنف التحقق للحصول على رابط Start جديد دون إنشاء بوت آخر.",
    managedFailed: "تعذّر إكمال الربط. ابدأ محاولة جديدة.",
    advancedTitle: "خيار متقدم: الربط برمز البوت",
    advancedBody:
      "إذا كان لديك بوت إشعارات جاهز، يمكنك لصق رمزه يدويًا. هذا الخيار للتجار المتقدمين.",
    tokenLabel: "رمز البوت (Bot token)",
    tokenPlaceholder: "123456789:AA…",
    tokenHint:
      "يُحفظ الرمز مشفّرًا ولا يظهر مرة أخرى في الصفحة أو السجلات. استخدم بوتًا مخصصًا للإشعارات.",
    connect: "ربط بوت الإشعارات",
    connecting: "جارٍ التحقق من الرمز…",
    pairingTitle: "تأكيد محادثة الاستلام",
    pairingBody:
      "افتح البوت من حسابك في تيليجرام واضغط Start، أو أرسل رمز الربط للبوت. بعدها اضغط «تحقق من الربط».",
    pairingExpires: "رابط الربط قصير الأجل وينتهي قريبًا.",
    openBot: "فتح البوت في تيليجرام",
    newPairingLink: "إنشاء رابط ربط جديد",
    generatingLink: "جارٍ إنشاء الرابط…",
    checkPairing: "تحقق من الربط",
    checkingPairing: "جارٍ التحقق من الرسائل…",
    pairedTitle: "محادثة الاستلام جاهزة",
    pairingAmbiguousTitle: "تعذّر تأكيد محادثة الاستلام",
    pairedBody:
      "أرسل إشعارًا تجريبيًا الآن للتأكد من أن تيليجرام يسلّم رسائل هذا البوت إلى المحادثة الصحيحة.",
    destinationLabel: "المحادثة المرتبطة",
    testTitle: "الإشعار التجريبي",
    testBody:
      "يُرسل هذا الإشعار خارج مسار الطلبات والدفع، ولا يغيّر أي حالة طلب أو دفع.",
    sendTest: "إرسال إشعار تجريبي",
    sendingTest: "جارٍ الإرسال…",
    testAccepted: "قبلت تيليجرام الإشعار التجريبي.",
    verified: "تم التحقق من الإرسال",
    notVerified: "لم يتم التحقق بعد",
    lastTest: "آخر إشعار ناجح",
    changeChat: "تغيير محادثة الاستلام",
    disconnect: "فصل البوت",
    disconnecting: "جارٍ الفصل…",
    disconnectHint: "سيتم حذف رمز البوت ومحادثة الاستلام من متجرك.",
    disconnected: "تم فصل بوت الإشعارات وحذف رمزه.",
    statusConnected: "مرتبط",
    statusPairing: "بانتظار تأكيد المحادثة",
    statusPairingFailed: "تحتاج جلسة الربط إلى رابط جديد",
    statusUnpaired: "غير مرتبط",
    readOnly:
      "المتجر موقوف مؤقتًا؛ لا يمكن تعديل إعدادات الإشعارات الآن.",
    unsupported:
      "إعدادات إشعارات المتجر تحتاج ترقية قاعدة البيانات. لم يتأثر بوت العملاء.",
    errors: {
      UNAVAILABLE: "خدمة إشعارات المتجر غير متاحة الآن.",
      DENIED: "لا يمكن تعديل إشعارات هذا المتجر بحسابك أو حالة متجرك الحالية.",
      TOKEN_REQUIRED: "أدخل رمز البوت أولًا.",
      INVALID_TOKEN:
        "رمز البوت غير صالح. انسخ الرمز كاملًا من @BotFather وتأكد أنه بوت.",
      BOT_ALREADY_CONNECTED:
        "هذا البوت مرتبط بمتجر آخر. استخدم بوتًا مختلفًا لإشعارات هذا المتجر.",
      TELEGRAM_UNAVAILABLE:
        "تعذّر الوصول إلى تيليجرام الآن. أعد المحاولة بعد قليل.",
      PAIRING_PENDING:
        "ما زلنا نفحص رسائل البوت، أو لم يصل رمز الربط بعد. افتح البوت واضغط Start من حسابك ثم أعد التحقق.",
      PAIRING_EXPIRED:
        "انتهت صلاحية رابط الربط. أنشئ رابطًا جديدًا ثم أعد المحاولة.",
      PAIRING_AMBIGUOUS:
        "وصل رمز الربط من أكثر من محادثة. أنشئ رابطًا جديدًا وحاول مرة أخرى.",
      PAIRING_REQUIRED: "أكمل تأكيد محادثة الاستلام أولًا.",
      PAIRING_UNAVAILABLE:
        "تعذّر قراءة رسائل البوت من تيليجرام. أعد المحاولة.",
      PAIRING_WEBHOOK_ACTIVE:
        "هذا البوت مرتبط بـ Webhook آخر، لذلك لا يمكن قراءة رسائله. استخدم بوتًا مخصصًا للإشعارات بدون Webhook.",
      NOT_CONNECTED: "لم يتم ربط بوت إشعارات بهذا المتجر بعد.",
      TEST_BLOCKED:
        "لم تُسلّم الرسالة. افتح البوت واضغط Start، وتأكد من أنك لم تحظر البوت.",
      TEST_CHAT_NOT_FOUND:
        "محادثة الاستلام غير موجودة. غيّر محادثة الاستلام ثم أعد الإرسال.",
      TEST_RATE_LIMITED:
        "تيليجرام يحدّ من الإرسال الآن. انتظر قليلًا ثم أعد المحاولة.",
      TEST_NETWORK: "تعذّر الاتصال بتيليجرام. تحقق من الشبكة وأعد المحاولة.",
      TELEGRAM_REJECTED:
        "رفضت تيليجرام الإشعار التجريبي. تحقق من البوت والمحادثة ثم أعد المحاولة.",
      CONFIGURATION_CHANGED:
        "تغيّرت إعدادات الإشعارات أثناء الإرسال. أعد المحاولة.",
      BOT_START_PENDING:
        "لم نستلم Start من البوت بعد. افتح البوت واضغط Start ثم أعد التحقق.",
      BOT_START_LINK_REQUIRED:
        "وصل Start عادي، لكنه لا يثبت أنك فتحت رابط التحقق. استخدم زر فتح البوت من هذه الصفحة أو من رسالة المدير، ثم اضغط Start وأعد التحقق.",
      EXPIRED: "انتهت صلاحية المحاولة. ابدأ محاولة جديدة.",
      CONFLICT:
        "تعذّر إكمال الربط لأن البوت أو المحاولة مرتبطة بحالة أخرى.",
      SUPERSEDED:
        "تغيّرت إعدادات الإشعارات أثناء التحقق من تيليجرام. راجع الإعدادات الحالية وابدأ من جديد إذا لزم.",
      RETRYABLE: "تيليجرام غير متاح الآن. أعد المحاولة.",
      REVIEW:
        "هذا البوت مرتبط بـ Webhook أو حالة تحتاج مراجعة. استخدم الخيار المتقدم أو بوتًا آخر.",
      NOT_FOUND: "لا توجد محاولة ربط نشطة. ابدأ محاولة جديدة.",
      OPERATION_FAILED: "تعذّر إكمال العملية. أعد المحاولة.",
    },
  },
  en: {
    title: "Store notification bot",
    intro:
      "Connect a dedicated Telegram bot so you receive an alert when a new order or inquiry arrives for your store.",
    separateNotice:
      "This bot is completely separate from the customer-facing store bot. Do not change the customer bot here.",
    setupStepsTitle: "Setup steps",
    setupSteps: [
      "Create a new bot with @BotFather on Telegram.",
      "Copy the bot token and paste it below.",
      "Open the bot from your own account and press Start or send the pairing code.",
      "Confirm the receiving chat on this page.",
      "Send a test notification to confirm delivery.",
    ],
    managedTitle: "Create the notification bot automatically",
    managedBody:
      "Create the bot from Telegram without copying a token. We link it to your store after you confirm in Telegram.",
    managedCreate: "Create notification bot",
    managedWaiting: "Waiting for you to open the manager bot in Telegram",
    managedAwaitingStart: "The bot was created. Open it and press Start to prove ownership.",
    managedPreparing: "Telegram is preparing the bot now.",
    managedOpenManager: "Open manager bot",
    managedOpenBot: "Open bot and press Start",
    managedCheck: "Check connection status",
    managedChecking: "Checking…",
    managedResume: "Resume verification for the same bot",
    managedExpired: "The verification window ended.",
    managedExpiredResume:
      "The verification window ended, but the same bot proposal is still stored. Resume verification for a fresh Start link without creating another bot.",
    managedFailed: "The connection could not be completed. Start a new attempt.",
    advancedTitle: "Advanced: connect with a bot token",
    advancedBody:
      "If you already have a notification bot, you can paste its token manually. This is for advanced merchants.",
    tokenLabel: "Bot token",
    tokenPlaceholder: "123456789:AA…",
    tokenHint:
      "The token is stored encrypted and never shown on the page or in logs again. Use a bot dedicated to notifications.",
    connect: "Connect notification bot",
    connecting: "Verifying token…",
    pairingTitle: "Confirm the receiving chat",
    pairingBody:
      "Open the bot from your own Telegram account and press Start, or send the pairing code to the bot. Then press “Check pairing”.",
    pairingExpires: "The pairing link is short-lived and expires soon.",
    openBot: "Open bot in Telegram",
    newPairingLink: "Generate a new pairing link",
    generatingLink: "Generating link…",
    checkPairing: "Check pairing",
    checkingPairing: "Checking messages…",
    pairedTitle: "Receiving chat is ready",
    pairingAmbiguousTitle: "Chat confirmation failed",
    pairedBody:
      "Send a test notification now to confirm Telegram delivers this bot's messages to the correct chat.",
    destinationLabel: "Connected chat",
    testTitle: "Test notification",
    testBody:
      "This test runs outside checkout, order and payment flows and does not change any order or payment state.",
    sendTest: "Send test notification",
    sendingTest: "Sending…",
    testAccepted: "Telegram accepted the test notification.",
    verified: "Delivery verified",
    notVerified: "Not verified yet",
    lastTest: "Last successful test",
    changeChat: "Change receiving chat",
    disconnect: "Disconnect bot",
    disconnecting: "Disconnecting…",
    disconnectHint:
      "The bot token and receiving chat will be deleted from your store.",
    disconnected: "Notification bot disconnected and its token removed.",
    statusConnected: "Connected",
    statusPairing: "Waiting for chat confirmation",
    statusPairingFailed: "Pairing needs a fresh link",
    statusUnpaired: "Not connected",
    readOnly:
      "This store is suspended; notification settings cannot be changed right now.",
    unsupported:
      "Merchant notification settings require a database upgrade. The customer bot is unaffected.",
    errors: {
      UNAVAILABLE: "Merchant notification setup is unavailable right now.",
      DENIED:
        "You cannot change this store's notifications with the current account or store state.",
      TOKEN_REQUIRED: "Enter the bot token first.",
      INVALID_TOKEN:
        "The bot token is invalid. Copy the full token from @BotFather and make sure it is a bot.",
      BOT_ALREADY_CONNECTED:
        "This bot is already connected to another store. Use a different bot for this store's notifications.",
      TELEGRAM_UNAVAILABLE:
        "Telegram could not be reached right now. Try again shortly.",
      PAIRING_PENDING:
        "We are still checking the bot's messages, or the Start message has not arrived yet. Open the bot, press Start from your account, then check again.",
      PAIRING_EXPIRED:
        "The pairing link expired. Generate a new link and try again.",
      PAIRING_AMBIGUOUS:
        "The pairing code arrived from more than one chat. Generate a new link and try again.",
      PAIRING_REQUIRED: "Confirm the receiving chat first.",
      PAIRING_UNAVAILABLE:
        "Could not read the bot's messages from Telegram. Try again.",
      PAIRING_WEBHOOK_ACTIVE:
        "This bot already has another webhook, so its messages cannot be read here. Use a dedicated notification bot with no webhook.",
      NOT_CONNECTED: "No notification bot is connected to this store yet.",
      TEST_BLOCKED:
        "The message was not delivered. Open the bot, press Start, and make sure you have not blocked it.",
      TEST_CHAT_NOT_FOUND:
        "The receiving chat was not found. Change the receiving chat and send again.",
      TEST_RATE_LIMITED:
        "Telegram is rate limiting sends right now. Wait a moment and try again.",
      TEST_NETWORK:
        "Could not reach Telegram. Check your connection and try again.",
      TELEGRAM_REJECTED:
        "Telegram rejected the test notification. Check the bot and chat, then try again.",
      CONFIGURATION_CHANGED:
        "Notification settings changed while sending. Try again.",
      BOT_START_PENDING:
        "We have not received Start from the bot yet. Open the bot, press Start, then check again.",
      BOT_START_LINK_REQUIRED:
        "We received a plain Start, but it does not prove that you opened the verification link. Use the Open bot button on this page or in the Manager message, press Start, then check again.",
      EXPIRED: "The attempt expired. Start a new attempt.",
      CONFLICT:
        "The connection could not be completed because the bot or attempt is in another state.",
      SUPERSEDED:
        "Notification settings changed while Telegram was verifying. Review the current settings and start again if needed.",
      RETRYABLE: "Telegram is unavailable right now. Try again.",
      REVIEW:
        "This bot has a webhook or needs operator review. Use the advanced option or another bot.",
      NOT_FOUND: "There is no active connection attempt. Start a new one.",
      OPERATION_FAILED: "The operation could not be completed. Try again.",
    },
  },
};
