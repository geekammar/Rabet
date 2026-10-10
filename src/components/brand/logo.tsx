import { Link2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Rabet brand mark.
 *
 * "Rabet" (رابط) means "the linker" — the icon represents the connection
 * between the Telegram bot and the merchant's dashboard.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
      >
        <Link2 className="size-4" />
      </span>
      <span className="font-heading text-base font-semibold tracking-tight">
        Rabet
      </span>
    </span>
  );
}
