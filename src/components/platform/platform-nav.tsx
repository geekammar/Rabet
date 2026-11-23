import Link from "next/link";

import { Button } from "@/components/ui/button";

export type PlatformSection = "invitations" | "stores";

const ITEMS: { href: string; label: string; section: PlatformSection }[] = [
  { href: "/platform/invitations", label: "Invitations", section: "invitations" },
  { href: "/platform/stores", label: "Stores", section: "stores" },
];

export function PlatformNav({ active }: { active: PlatformSection }) {
  return (
    <nav
      aria-label="Platform administration"
      data-testid="platform-nav"
      className="flex flex-wrap items-center gap-2 border-b border-border pb-3"
    >
      {ITEMS.map((item) => {
        const isActive = item.section === active;

        return (
          <Button
            key={item.section}
            asChild
            variant={isActive ? "default" : "outline"}
            size="sm"
          >
            <Link
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              data-testid={`platform-nav-${item.section}`}
            >
              {item.label}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
