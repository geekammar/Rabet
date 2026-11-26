/**
 * Localized copy for the managed buyer storefront and its COD flow.
 *
 * The managed path offers exactly two buyer UI languages. Product and category
 * names are merchant catalog content and are deliberately not chosen by this
 * UI locale; this module only owns interface copy, validation text and the
 * receipt. Nothing here reads a merged customer row: the resolved per-store
 * UI language is passed in by the webhook.
 */

import {
  buyerLocaleFromLanguageCode,
  type BuyerLocale,
} from "@/lib/commerce/buyer-language";

export type ManagedCommerceLocale = BuyerLocale;

export const managedCommerceLocaleFromLanguageCode = buyerLocaleFromLanguageCode;

export type CommerceCopy = {
  home: string;
  back: string;
  previous: string;
  next: string;
  products: string;
  browseCategories: string;
  cart: string;
  languageButton: string;
  languageTitle: string;
  languageArabic: string;
  languageEnglish: string;
  languageSaved: string;
  invalidLanguage: string;
  askSellerOnTelegram: string;
  telegramSupportDraft: (productName: string) => string;
  welcome: (storeName: string) => string;
  empty: string;
  noCategories: string;
  unavailable: string;
  unavailableItem: string;
  cartEmpty: string;
  cartHint: string;
  cartUnavailableNote: string;
  checkout: string;
  remove: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  cashOnDelivery: string;
  vodafoneCash: string;
  payWithVodafoneCash: string;
  transferInstructionsTitle: string;
  transferTo: string;
  transferAccount: string;
  transferInstructions: string;
  transferInstructionsGuidance: string;
  transferReferenceButton: string;
  transferReferencePrompt: string;
  transferReferencePlaceholder: string;
  transferReferenceInvalid: string;
  transferReferenceLabel: string;
  transferSubmittedTitle: string;
  transferAwaitingReview: string;
  transferAlreadySubmitted: string;
  transferVerifiedTitle: string;
  transferVerifiedBody: string;
  transferRejectedTitle: string;
  transferRejectedBody: string;
  transferCancelledTitle: string;
  transferCancelledBody: string;
  transferRecoveryButton: string;
  transferRecoveryTitle: string;
  transferRecoveryHint: string;
  transferRecoveryEmpty: string;
  transferAmountLabel: string;
  reviewTitle: string;
  reviewInstruction: string;
  confirmButton: string;
  backToCart: string;
  sharePhone: string;
  phonePrompt: string;
  invalidPhone: string;
  phoneOwn: string;
  addressPrompt: string;
  invalidAddress: string;
  nameLabel: string;
  phoneLabel: string;
  addressLabel: string;
  paymentLabel: string;
  orderPlaced: (reference: string) => string;
  awaitingCollection: string;
  reservedNote: string;
  outOfStock: string;
  notOrderable: string;
  genericUnavailable: string;
  maxQuantity: string;
  stockIssue: string;
  checkoutNeedsDetails: string;
  addQuantity: (quantity: number) => string;
};

const COPY: Record<ManagedCommerceLocale, CommerceCopy> = {
  en: {
    home: "Home",
    back: "Back",
    previous: "Previous",
    next: "Next",
    products: "Products",
    browseCategories: "Browse categories",
    cart: "Cart",
    languageButton: "اللغة / Language",
    languageTitle: "Choose your language",
    languageArabic: "العربية",
    languageEnglish: "English",
    languageSaved: "Language updated.",
    invalidLanguage:
      "That language is not available. Choose Arabic or English.",
    askSellerOnTelegram: "Ask the seller on Telegram",
    telegramSupportDraft: (productName) =>
      `Hi, I have a question about ${productName}: `,
    welcome: (storeName) => `Welcome to ${storeName}.`,
    empty: "No products are available in this store yet.",
    noCategories: "No categories are available in this store yet.",
    unavailable: "This item is not available in this store.",
    unavailableItem: "Unavailable item",
    cartEmpty: "Your cart is empty.",
    cartHint: "Send /start to browse the store.",
    cartUnavailableNote:
      "Some items are unavailable or exceed current stock.",
    checkout: "Checkout",
    remove: "Remove",
    subtotal: "Subtotal",
    deliveryFee: "Delivery fee",
    total: "Total",
    cashOnDelivery: "Cash on delivery",
    vodafoneCash: "Vodafone Cash",
    payWithVodafoneCash: "Transfer with Vodafone Cash",
    transferInstructionsTitle: "Vodafone Cash transfer",
    transferTo: "Transfer to",
    transferAccount: "Recipient name",
    transferInstructions: "Transfer instructions",
    transferInstructionsGuidance:
      "Tap “I have transferred — submit reference” below, then reply to the next message with the reference from your receipt.",
    transferReferenceButton: "I have transferred — submit reference",
    transferReferencePrompt:
      "Reply to this message with the transfer reference from your Vodafone Cash receipt.",
    transferReferencePlaceholder: "Transfer reference",
    transferReferenceInvalid:
      "That reference is invalid. Reply to the prompt with the reference exactly as shown in your receipt (3–80 characters).",
    transferReferenceLabel: "Reference",
    transferSubmittedTitle: "Transfer reference received",
    transferAwaitingReview:
      "Awaiting merchant verification. The order is not marked paid until the merchant checks the wallet and verifies the transfer.",
    transferAlreadySubmitted:
      "A transfer reference is already recorded for this order and is awaiting merchant review.",
    transferVerifiedTitle: "Transfer verified",
    transferVerifiedBody:
      "The merchant verified this transfer. The order is paid; stock remains reserved until shipping.",
    transferRejectedTitle: "Transfer rejected",
    transferRejectedBody:
      "The merchant rejected this transfer claim. The order was cancelled and the stock reservation was released.",
    transferCancelledTitle: "Order cancelled",
    transferCancelledBody:
      "This transfer order was cancelled. No further transfer reference is needed.",
    transferRecoveryButton: "Vodafone transfers",
    transferRecoveryTitle: "Outstanding Vodafone Cash transfers",
    transferRecoveryHint: "Choose the order reference to reopen its instructions.",
    transferRecoveryEmpty: "There are no outstanding Vodafone Cash transfers for this chat.",
    transferAmountLabel: "Exact amount",
    reviewTitle: "Review your order",
    reviewInstruction:
      "Confirm only if these details, prices and the delivery fee are correct.",
    confirmButton: "Confirm order — cash on delivery",
    backToCart: "Back to cart",
    sharePhone: "Share phone",
    phonePrompt: "Send your phone number or tap Share phone.",
    invalidPhone:
      "That phone number is invalid. Send 7–15 digits or tap Share phone.",
    phoneOwn: "Share your own phone number or type it as text.",
    addressPrompt: "Send the delivery address as one text message.",
    invalidAddress:
      "That address is invalid. Send the delivery address as 5–300 characters.",
    nameLabel: "Name",
    phoneLabel: "Phone",
    addressLabel: "Address",
    paymentLabel: "Payment",
    orderPlaced: (reference) => `Order ${reference} placed.`,
    awaitingCollection: "Payment: cash on delivery — awaiting collection.",
    reservedNote: "The store has reserved the items for this order.",
    outOfStock: "This product is out of stock.",
    notOrderable: "This product cannot be ordered online.",
    genericUnavailable: "This cart is not available.",
    maxQuantity: "Maximum quantity is 99.",
    stockIssue:
      "One or more items are unavailable or exceed current stock. Review the cart and try again.",
    checkoutNeedsDetails:
      "Checkout needs your phone number and delivery address before confirmation.",
    addQuantity: (quantity) => `Add ${quantity}`,
  },
  ar: {
    home: "الرئيسية",
    back: "رجوع",
    previous: "السابق",
    next: "التالي",
    products: "المنتجات",
    browseCategories: "تصفح الأقسام",
    cart: "السلة",
    languageButton: "اللغة / Language",
    languageTitle: "اختر اللغة",
    languageArabic: "العربية",
    languageEnglish: "English",
    languageSaved: "تم تحديث اللغة.",
    invalidLanguage: "هذه اللغة غير متاحة. اختر العربية أو الإنجليزية.",
    askSellerOnTelegram: "اسأل البائع على Telegram",
    telegramSupportDraft: (productName) =>
      `مرحبًا، عندي سؤال عن ${productName}: `,
    welcome: (storeName) => `مرحبًا بك في ${storeName}.`,
    empty: "لا توجد منتجات متاحة في هذا المتجر بعد.",
    noCategories: "لا توجد أقسام متاحة في هذا المتجر بعد.",
    unavailable: "هذا العنصر غير متاح في هذا المتجر.",
    unavailableItem: "عنصر غير متاح",
    cartEmpty: "سلتك فارغة.",
    cartHint: "أرسل /start لتصفح المتجر.",
    cartUnavailableNote:
      "بعض العناصر غير متاحة أو تتجاوز المخزون الحالي.",
    checkout: "إتمام الطلب",
    remove: "إزالة",
    subtotal: "المجموع الفرعي",
    deliveryFee: "رسوم التوصيل",
    total: "الإجمالي",
    cashOnDelivery: "الدفع عند الاستلام",
    vodafoneCash: "فودافون كاش",
    payWithVodafoneCash: "التحويل عبر فودافون كاش",
    transferInstructionsTitle: "تحويل فودافون كاش",
    transferTo: "حوّل إلى",
    transferAccount: "اسم المستلم",
    transferInstructions: "تعليمات التحويل",
    transferInstructionsGuidance:
      "اضغط «لقد حوّلت — إرسال المرجع» بالأسفل، ثم أرسل ردًا على الرسالة التالية يحتوي المرجع الموجود في الإيصال.",
    transferReferenceButton: "لقد حوّلت — إرسال المرجع",
    transferReferencePrompt:
      "أرسل ردًا على هذه الرسالة يحتوي مرجع التحويل الموجود في إيصال فودافون كاش.",
    transferReferencePlaceholder: "مرجع التحويل",
    transferReferenceInvalid:
      "المرجع غير صالح. أرسل ردًا على الرسالة يحتوي المرجع كما يظهر في الإيصال (٣–٨٠ حرفًا).",
    transferReferenceLabel: "المرجع",
    transferSubmittedTitle: "تم استلام مرجع التحويل",
    transferAwaitingReview:
      "بانتظار مراجعة التاجر. لا يُعد الطلب مدفوعًا حتى يتحقق التاجر من المحفظة ويؤكد التحويل.",
    transferAlreadySubmitted:
      "يوجد مرجع تحويل مسجل لهذا الطلب وهو بانتظار مراجعة التاجر.",
    transferVerifiedTitle: "تم التحقق من التحويل",
    transferVerifiedBody:
      "تحقق التاجر من هذا التحويل. الطلب مدفوع، ويبقى المخزون محجوزًا حتى الشحن.",
    transferRejectedTitle: "تم رفض التحويل",
    transferRejectedBody:
      "رفض التاجر ادعاء التحويل. أُلغي الطلب وحُرر حجز المخزون.",
    transferCancelledTitle: "تم إلغاء الطلب",
    transferCancelledBody:
      "أُلغي طلب التحويل هذا. لا حاجة إلى إرسال مرجع تحويل آخر.",
    transferRecoveryButton: "تحويلات فودافون كاش",
    transferRecoveryTitle: "تحويلات فودافون كاش المعلقة",
    transferRecoveryHint: "اختر مرجع الطلب لإعادة فتح تعليماته.",
    transferRecoveryEmpty: "لا توجد تحويلات فودافون كاش معلقة لهذه المحادثة.",
    transferAmountLabel: "المبلغ بالضبط",
    reviewTitle: "راجع طلبك",
    reviewInstruction:
      "أكّد فقط إذا كانت هذه التفاصيل والأسعار ورسوم التوصيل صحيحة.",
    confirmButton: "تأكيد الطلب — الدفع عند الاستلام",
    backToCart: "العودة إلى السلة",
    sharePhone: "مشاركة الهاتف",
    phonePrompt: "أرسل رقم هاتفك أو اضغط مشاركة الهاتف.",
    invalidPhone:
      "رقم الهاتف غير صالح. أرسل ٧–١٥ رقمًا أو اضغط مشاركة الهاتف.",
    phoneOwn: "شارك رقم هاتفك أو اكتبه كرسالة نصية.",
    addressPrompt: "أرسل عنوان التوصيل في رسالة نصية واحدة.",
    invalidAddress:
      "العنوان غير صالح. أرسل عنوان التوصيل من ٥ إلى ٣٠٠ حرف.",
    nameLabel: "الاسم",
    phoneLabel: "الهاتف",
    addressLabel: "العنوان",
    paymentLabel: "الدفع",
    orderPlaced: (reference) => `تم تسجيل الطلب ${reference}.`,
    awaitingCollection: "الدفع عند الاستلام — بانتظار التحصيل.",
    reservedNote: "تم حجز المنتجات لهذا الطلب.",
    outOfStock: "هذا المنتج غير متوفر حاليًا.",
    notOrderable: "لا يمكن طلب هذا المنتج عبر المتجر.",
    genericUnavailable: "هذه السلة غير متاحة.",
    maxQuantity: "الحد الأقصى للكمية هو ٩٩.",
    stockIssue:
      "عنصر واحد أو أكثر غير متاح أو يتجاوز المخزون الحالي. راجع السلة وحاول مرة أخرى.",
    checkoutNeedsDetails:
      "يحتاج إتمام الطلب إلى رقم الهاتف وعنوان التوصيل قبل التأكيد.",
    addQuantity: (quantity) => `أضف ${quantity}`,
  },
};

export function managedCommerceCopy(
  locale: ManagedCommerceLocale,
): CommerceCopy {
  return COPY[locale];
}
