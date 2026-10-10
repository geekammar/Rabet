import type { Metadata } from "next";
import { ShoppingCart } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Orders",
  description: "Incoming and completed orders.",
};

export default function OrdersPage() {
  return (
    <SectionPlaceholder
      title="Orders"
      description="Orders placed by customers through the Telegram bot."
      icon={ShoppingCart}
      emptyDescription="Orders will be listed here with their payment and fulfillment status tracked separately. Order management is planned for a later phase."
    />
  );
}
