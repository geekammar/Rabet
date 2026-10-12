import type { Metadata } from "next";
import { MessageSquareText } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Inquiries",
  description: "Product inquiries and support conversations.",
};

export default function InquiriesPage() {
  return (
    <SectionPlaceholder
      title="Inquiries"
      description="Read and reply to product questions and customer support messages."
      icon={MessageSquareText}
      emptyDescription="The seller inbox is planned for a later phase. No inquiries or messages have been received yet."
    />
  );
}
