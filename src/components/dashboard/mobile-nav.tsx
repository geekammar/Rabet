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
          className="md:hidden"
          aria-label="Open navigation menu"
        >
          <MenuIcon />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0">
        <SheetHeader className="h-16 justify-center border-b px-6">
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
