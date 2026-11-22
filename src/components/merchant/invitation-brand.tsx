import { Link2 } from "lucide-react";

import type { MerchantLocale } from "@/components/merchant/language-toggle";
import { INVITATION_BRAND } from "@/lib/merchant-invitation/branding";
import { cn } from "@/lib/utils";

/**
 * Page-scoped Nokmel brand mark for the invitation journey.
 *
 * The shared dashboard logo remains "Rabet"; this override keeps the
 * rebrand limited to the merchant-facing invitation page.
 */
export function InvitationBrand({
  locale,
  className,
}: {
  locale: MerchantLocale;
  className?: string;
}) {
  const name = INVITATION_BRAND[locale];

  return (
    <span
      role="img"
      aria-label={name}
      data-testid="invite-brand"
      className={cn("flex items-center gap-2.5", className)}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
      >
        <Link2 className="size-4" />
      </span>
      <span
        aria-hidden="true"
        className="font-heading text-base font-semibold tracking-tight"
      >
        {name}
      </span>
    </span>
  );
}
