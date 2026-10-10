import type { Metadata } from "next";
import { Package } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Services",
  description: "The digital services customers can order.",
};

export default function ServicesPage() {
  return (
    <SectionPlaceholder
      title="Services"
      description="The digital services customers can browse and order through the Telegram bot."
      icon={Package}
      emptyDescription="Your service catalog will be listed here. Creating and editing services is planned for a later phase."
    />
  );
}
