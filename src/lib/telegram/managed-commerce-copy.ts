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
