import {
  Bot,
  CreditCard,
  FolderTree,
  LayoutDashboard,
  MessageSquareText,
  Package,
  Send,
  Settings,
  SlidersHorizontal,
  Store,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
};

export type NavGroupId =
  | "home"
  | "store-management"
  | "store-setup"
  | "advanced-tools";

export type NavGroup = {
  id: NavGroupId;
  label: string;
  items: NavItem[];
  collapsible: boolean;
  defaultOpen: boolean;
};

/**
 * Single source of truth for dashboard navigation.
 * Consumed by the desktop sidebar and the mobile drawer.
 */
export const navGroups: NavGroup[] = [
  {
    id: "home",
    label: "Home",
    collapsible: false,
    defaultOpen: true,
    items: [
      {
        label: "Overview",
        href: "/overview",
        icon: LayoutDashboard,
        description: "Store counts and the tasks a merchant does most often.",
      },
    ],
  },
  {
    id: "store-management",
    label: "Store Management",
    collapsible: false,
    defaultOpen: true,
    items: [
      {
        label: "Products",
        href: "/products",
        icon: Package,
        description: "Create and edit products, prices, and availability.",
      },
      {
        label: "Categories",
        href: "/categories",
        icon: FolderTree,
        description: "Organize products into root and child categories.",
      },
      {
        label: "Inquiries",
        href: "/inquiries",
        icon: MessageSquareText,
        description: "Read and reply to customer questions and support conversations.",
      },
      {
        label: "Payment Methods",
        href: "/payment-methods",
        icon: CreditCard,
        description: "Configure payment instructions and preview them. Not live checkout.",
      },
    ],
  },
  {
    id: "store-setup",
    label: "Store Setup",
    collapsible: false,
    defaultOpen: true,
    items: [
      {
        label: "Storefront",
        href: "/storefront",
        icon: Store,
        description: "Choose the customer menu entries and their order.",
      },
      {
        label: "Bot Content",
        href: "/bot-content",
        icon: Bot,
        description: "Edit the messages and translations customers receive.",
      },
      {
        label: "Settings",
        href: "/settings",
        icon: Settings,
        description: "Store identity, languages, support, and seller notifications.",
      },
    ],
  },
  {
    id: "advanced-tools",
    label: "Advanced Tools",
    collapsible: true,
    defaultOpen: false,
    items: [
      {
        label: "Advanced Catalog",
        href: "/catalog",
        icon: SlidersHorizontal,
        description: "Full category tree and product-button editor.",
      },
      {
        label: "Telegram / Diagnostics",
        href: "/telegram",
        icon: Send,
        description: "Bot connection guidance and seller notification diagnostics.",
      },
    ],
  },
];

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items);

export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function getNavGroupForPath(pathname: string): NavGroup | undefined {
  return navGroups.find((group) =>
    group.items.some((item) => isNavItemActive(pathname, item.href)),
  );
}

export function getNavGroupOpenState(
  pathname: string,
): Record<NavGroupId, boolean> {
  return Object.fromEntries(
    navGroups.map((group) => [
      group.id,
      group.defaultOpen ||
        group.items.some((item) => isNavItemActive(pathname, item.href)),
    ]),
  ) as Record<NavGroupId, boolean>;
}
