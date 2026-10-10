import type { Metadata } from "next";
import { Settings } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Settings",
  description: "Store-wide configuration.",
};

export default function SettingsPage() {
  return (
    <SectionPlaceholder
      title="Settings"
      description="Store-wide configuration for your Rabet workspace."
      icon={Settings}
      emptyDescription="Store profile, default bot language and notification preferences will be managed here. Settings are planned for a later phase."
    />
  );
}
