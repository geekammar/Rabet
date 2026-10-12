import Link from "next/link";

import { LogoutButton } from "@/components/auth/logout-button";
import { Badge } from "@/components/ui/badge";
import { MobileNav } from "@/components/dashboard/mobile-nav";

export function Header() {
  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center gap-3 border-b bg-background/80 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-md md:px-6">
      <MobileNav />
      <Link
        href="/"
        className="rounded-md font-heading text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      >
        Rabet
      </Link>
      <div className="ml-auto flex items-center gap-2">
        <Badge variant="outline" className="font-normal text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-amber-500"
          />
          Discovery · Admin
        </Badge>
        <LogoutButton />
      </div>
    </header>
  );
}
