import {
  Bot,
  LayoutDashboard,
  MessageSquareText,
  Package,
  Send,
  Settings,
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
    label: "Catalog",
    href: "/catalog",
    icon: Package,
    description: "Digital products, categories, prices, and configurable buttons.",
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
