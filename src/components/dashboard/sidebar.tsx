import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";

export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar pt-[env(safe-area-inset-top)] md:flex">
      <div className="flex min-h-16 items-center border-b px-6">
        <Link
          href="/"
          aria-label="Rabet home"
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logo />
        </Link>
      </div>
      <DashboardNav className="flex-1 overflow-y-auto p-4" />
      <div className="border-t p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
        <p className="text-xs text-muted-foreground">
          Discovery · Dashboard shell
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Product features coming soon.
        </p>
      </div>
    </aside>
  );
}
