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
      emptyDescription="Payment records will appear here. Digital goods sold inside Telegram must be paid with Telegram Stars, so no other payment provider will be integrated. Payment tracking is planned for a later phase."
    />
  );
}
