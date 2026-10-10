import type { Metadata } from "next";
import { Bot } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Bot Content",
  description: "Editable bot messages and command texts.",
};

export default function BotContentPage() {
  return (
    <SectionPlaceholder
      title="Bot Content"
      description="The editable texts your bot uses to talk to customers."
      icon={Bot}
      emptyDescription="The welcome message, command replies and shared labels will be managed here. English is the default bot language and Arabic support is planned. Content editing arrives in a later phase."
    />
  );
}
