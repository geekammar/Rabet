/**
 * ===========================================================================
 * Global Bot Content Template Registry — Client-safe (DATA_MODEL.md §2, §7).
 * ===========================================================================
 *
 * Defines the canonical seven global message templates approved for the Rabet
 * Telegram bot MVP. Keys are fixed, stable identifiers and cannot be created,
 * renamed, or deleted in this editor.
 *
 * Approved template keys:
 * 1. `bot_welcome`: Main welcome greeting when customer first starts the bot.
 * 2. `support_welcome`: Introduction shown when entering customer support.
 * 3. `support_received`: Acknowledgment sent when customer submits support inquiry.
 * 4. `inquiry_received`: Acknowledgment sent when customer inquires about a product.
 * 5. `conversation_resolved`: Notice sent when inquiry/conversation is resolved.
 * 6. `option_unavailable`: Notice sent when selected action or menu option is unavailable.
 * 7. `empty_menu`: Notice sent when catalog category or menu has no items.
 */

export type TemplateKey =
  | "bot_welcome"
  | "support_welcome"
  | "support_received"
  | "inquiry_received"
  | "conversation_resolved"
  | "option_unavailable"
  | "empty_menu";

export type TemplateGroup =
  | "Welcome"
  | "Support"
  | "Inquiries"
  | "Navigation";

export type PlaceholderKey = "store_name" | "product_name";

export interface TemplateDefinition {
  readonly key: TemplateKey;
  readonly title: string;
  readonly purpose: string;
  readonly group: TemplateGroup;
  readonly allowedPlaceholders: readonly PlaceholderKey[];
  readonly suggestedText: {
    readonly en: string;
    readonly ar: string;
  };
}

export const APPROVED_TEMPLATE_KEYS: readonly TemplateKey[] = [
  "bot_welcome",
  "support_welcome",
  "support_received",
  "inquiry_received",
  "conversation_resolved",
  "option_unavailable",
  "empty_menu",
] as const;

export const TEMPLATE_GROUPS: readonly TemplateGroup[] = [
  "Welcome",
  "Support",
  "Inquiries",
  "Navigation",
] as const;

export const TEMPLATE_REGISTRY: readonly TemplateDefinition[] = [
  {
    key: "bot_welcome",
    title: "Main Welcome",
    purpose: "Greeting sent when a customer first starts or opens the bot.",
    group: "Welcome",
    allowedPlaceholders: ["store_name"],
    suggestedText: {
      en: "Welcome to {{store_name}}! Browse our catalog or reach out to us if you need help.",
      ar: "مرحبًا بك في {{store_name}}! تصفح منتجاتنا أو تواصل معنا إذا كنت بحاجة للمساعدة.",
    },
  },
  {
    key: "support_welcome",
    title: "Support Introduction",
    purpose: "Introduction shown when a customer opens customer support.",
    group: "Support",
    allowedPlaceholders: ["store_name"],
    suggestedText: {
      en: "You are now chatting with {{store_name}} support. How can we assist you today?",
      ar: "أنت الآن في محادثة مع فريق دعم {{store_name}}. كيف يمكننا مساعدتك اليوم؟",
    },
  },
  {
    key: "support_received",
    title: "Support Inquiry Acknowledgment",
    purpose: "Acknowledgment sent after a customer submits a support question.",
    group: "Support",
    allowedPlaceholders: ["store_name"],
    suggestedText: {
      en: "Thank you for contacting {{store_name}}. We have received your message and will reply soon.",
      ar: "شكرًا لتواصلك مع {{store_name}}. لقد استلمنا رسالتك وسنرد عليك قريبًا.",
    },
  },
  {
    key: "inquiry_received",
    title: "Product Inquiry Acknowledgment",
    purpose: "Acknowledgment sent after a customer inquires about a product.",
    group: "Inquiries",
    allowedPlaceholders: ["store_name", "product_name"],
    suggestedText: {
      en: "Thank you for your inquiry about {{product_name}} at {{store_name}}. We will get back to you shortly.",
      ar: "شكرًا لاستفسارك عن {{product_name}} في {{store_name}}. سنتواصل معك قريبًا.",
    },
  },
  {
    key: "conversation_resolved",
    title: "Conversation Resolution Notice",
    purpose: "Notice sent to the customer when their conversation has been resolved or closed.",
    group: "Support",
    allowedPlaceholders: ["store_name"],
    suggestedText: {
      en: "Your conversation with {{store_name}} has been marked as resolved. Feel free to contact us anytime if you need more help.",
      ar: "تم إغلاق المحادثة مع {{store_name}}. يمكنك التواصل معنا مجددًا في أي وقت إذا احتجت لمساعدة إضافية.",
    },
  },
  {
    key: "option_unavailable",
    title: "Unavailable Action Notice",
    purpose: "Notice shown when a selected menu option or action is currently unavailable.",
    group: "Navigation",
    allowedPlaceholders: ["store_name"],
    suggestedText: {
      en: "This option is currently unavailable. Please choose another option from the menu.",
      ar: "هذا الخيار غير متوفر حاليًا. يرجى اختيار خيار آخر من القائمة.",
    },
  },
  {
    key: "empty_menu",
    title: "Empty Catalog Notice",
    purpose: "Notice shown when a catalog category or menu has no items to display.",
    group: "Navigation",
    allowedPlaceholders: ["store_name"],
    suggestedText: {
      en: "There are currently no items available in this section. Please check back later!",
      ar: "لا توجد عناصر متاحة حاليًا في هذا القسم. يرجى معاودة التحقق لاحقًا!",
    },
  },
] as const;

export function isApprovedTemplateKey(key: string): key is TemplateKey {
  return (APPROVED_TEMPLATE_KEYS as readonly string[]).includes(key);
}

export function getTemplateDefinition(key: string): TemplateDefinition | undefined {
  return TEMPLATE_REGISTRY.find((t) => t.key === key);
}
