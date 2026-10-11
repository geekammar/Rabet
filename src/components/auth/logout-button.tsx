"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";

import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * Sign-out control.
 *
 * Calls the `logout` Server Action, which clears the session cookie
 * server-side via Auth.js `signOut()` and redirects to `/login`. Because the
 * cookie is deleted (not merely ignored), the back button and refresh cannot
 * restore access after signing out.
 *
 * A pending state keeps the button inert while the action runs, so the action
 * cannot be double-triggered.
 */
export function LogoutButton() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      aria-label="Sign out"
      className="min-h-11 px-3 text-muted-foreground hover:text-foreground"
      onClick={() => {
        startTransition(async () => {
          await logout();
        });
      }}
    >
      <LogOut className="size-4" aria-hidden="true" />
      <span>Sign out</span>
    </Button>
  );
}
