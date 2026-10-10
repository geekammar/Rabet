import type { Metadata } from "next";
import { Send } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Telegram",
  description: "Bot connection and webhook settings.",
};

export default function TelegramPage() {
  return (
    <SectionPlaceholder
      title="Telegram"
      description="Connection between Rabet and your Telegram bot."
      icon={Send}
      emptyDescription="Bot credentials, webhook registration and the live connection status will be managed here. Telegram integration is planned for a later phase."
    />
  );
}
