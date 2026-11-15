import {
  Bot,
  CreditCard,
  FolderTree,
  Layers,
  LayoutDashboard,
  MessageSquareText,
  PackageSearch,
  Send,
  Settings,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
};

/**
 * Single source of truth for dashboard navigation.
 * Consumed by desktop sidebar, mobile drawer, and overview quick-links.
 */
export const navItems: NavItem[] = [
  {
    label: "Overview",
    href: "/overview",
    icon: LayoutDashboard,
    description: "A summary of catalog and conversation activity.",
  },
  {
    label: "Products",
    href: "/products",
    icon: PackageSearch,
    description: "Add, edit and search products directly.",
  },
  {
    label: "Categories",
    href: "/categories",
    icon: FolderTree,
    description: "Create and manage root and child categories.",
  },
  {
    label: "Storefront",
    href: "/storefront",
    icon: Store,
    description: "Choose the customer menu entries and their order.",
  },
  {
    label: "Advanced Catalog",
    href: "/catalog",
    icon: Layers,
    description: "Full category tree and configurable product buttons.",
  },
  {
    label: "Payment Methods",
    href: "/payment-methods",
    icon: CreditCard,
    description: "Central payment methods, instructions, and customer preview.",
  },
  {
    label: "Inquiries",
    href: "/inquiries",
    icon: MessageSquareText,
    description: "Product questions and customer support conversations.",
  },
  {
    label: "Customers",
    href: "/customers",
    icon: Users,
    description: "People who interact with the Telegram bot.",
  },
  {
    label: "Bot Content",
    href: "/bot-content",
    icon: Bot,
    description: "Editable bot messages and language content.",
  },
  {
    label: "Telegram",
    href: "/telegram",
    icon: Send,
    description: "Bot connection and webhook settings.",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Catalog and bot configuration.",
  },
];
