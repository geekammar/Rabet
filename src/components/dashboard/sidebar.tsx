import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";

export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-16 items-center border-b px-6">
        <Link href="/" aria-label="Rabet home">
          <Logo />
        </Link>
      </div>
      <DashboardNav className="flex-1 overflow-y-auto p-4" />
      <div className="border-t p-4">
        <p className="text-xs text-muted-foreground">
          Phase 1 · UI shell preview
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Not production-secure.
        </p>
      </div>
    </aside>
  );
}
