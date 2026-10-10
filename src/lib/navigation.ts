import {
  Bot,
  CreditCard,
  LayoutDashboard,
  Package,
  Send,
  Settings,
  ShoppingCart,
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
 * Consumed by the desktop sidebar, the mobile navigation drawer and the
 * overview quick-links so the three can never drift apart.
 */
export const navItems: NavItem[] = [
  {
    label: "Overview",
    href: "/overview",
    icon: LayoutDashboard,
    description: "A summary of store activity.",
  },
  {
    label: "Services",
    href: "/services",
    icon: Package,
    description: "The digital services customers can order.",
  },
  {
    label: "Orders",
    href: "/orders",
    icon: ShoppingCart,
    description: "Incoming and completed orders.",
  },
  {
    label: "Customers",
    href: "/customers",
    icon: Users,
    description: "People who interact with the bot.",
  },
  {
    label: "Payments",
    href: "/payments",
    icon: CreditCard,
    description: "Payment records and balances.",
  },
  {
    label: "Bot Content",
    href: "/bot-content",
    icon: Bot,
    description: "Editable bot messages and command texts.",
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
    description: "Store-wide configuration.",
  },
];
