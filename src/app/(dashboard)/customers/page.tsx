import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquareText, Users } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Customers",
  description: "People who contact your store through Telegram.",
};

export default function CustomersPage() {
  return (
    <div className="space-y-8" data-testid="customers-page">
      <PageHeader
        title="Customers"
        description="People who contact your store through Telegram."
      />

      <EmptyState
        icon={Users}
        title="Customer profiles are not available yet"
        description="Customer conversations and replies are available now in Inquiries. A dedicated customer directory is not implemented."
      >
        <Button asChild className="min-h-11 gap-2">
          <Link href="/inquiries">
            <MessageSquareText className="size-4" />
            <span>View inquiries</span>
          </Link>
        </Button>
      </EmptyState>
    </div>
  );
}
