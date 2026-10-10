"use client";

import { useState } from "react";
import { MenuIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { Logo } from "@/components/brand/logo";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          // 44x44 CSS-pixel touch target for the primary mobile control.
          className="size-11 md:hidden"
          aria-label="Open navigation menu"
        >
          <MenuIcon />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        // w-72 (18rem), but never wider than the viewport minus a peek margin,
        // so the drawer stays usable on ~280-320px screens.
        className="w-[min(18rem,100dvw-1.5rem)] gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader className="min-h-16 justify-center border-b px-6 pt-[env(safe-area-inset-top)]">
          <SheetTitle asChild>
            <span>
              <Logo />
            </span>
          </SheetTitle>
          <SheetDescription className="sr-only">
            Dashboard navigation
          </SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <div className="flex-1 overflow-y-auto p-4">
            <DashboardNav onNavigate={() => setOpen(false)} />
          </div>
        </SheetClose>
        <div className="border-t p-4">
          <p className="text-xs text-muted-foreground">
            Phase 1 · UI shell preview
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
