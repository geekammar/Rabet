import type { Metadata } from "next";
import { CreditCard } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Payments",
  description: "Payment records and balances.",
};

export default function PaymentsPage() {
  return (
    <SectionPlaceholder
      title="Payments"
      description="Payments received for orders placed through the bot."
      icon={CreditCard}
      emptyDescription="Payment records will appear here. Rabet is in Discovery & Development, so no payment integration is active yet. Digital goods and services sold inside Telegram must be paid with Telegram Stars. Personal payment links such as Binance are being evaluated only for separately permitted contexts — because such links can expire, they will not be assumed valid indefinitely. Payment tracking is planned for a later phase."
    />
  );
}
