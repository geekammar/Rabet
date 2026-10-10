import type { Metadata } from "next";
import { Users } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Customers",
  description: "People who interact with the bot.",
};

export default function CustomersPage() {
  return (
    <SectionPlaceholder
      title="Customers"
      description="Customers who have interacted with your Telegram bot."
      icon={Users}
      emptyDescription="Customers will be listed here together with their persistent conversation state. Customer profiles are planned for a later phase."
    />
  );
}
