"use client";

import { useTransition } from "react";
import { LogOut, Loader2 } from "lucide-react";

import { merchantLogout } from "@/app/actions/merchant-auth";
import { Button } from "@/components/ui/button";

export function MerchantLogoutButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      className="min-h-11"
      data-testid="merchant-logout"
      onClick={() => {
        startTransition(async () => {
          await merchantLogout();
        });
      }}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <LogOut className="size-4" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}
