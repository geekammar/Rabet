import type { Metadata } from "next";
import { AlertCircle } from "lucide-react";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  listSellerInquiries,
  type SellerInquiryFilterStatus,
  type SellerInquiryFilterType,
} from "@/lib/data/seller-inbox";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { InboxList } from "@/components/dashboard/inquiries/inbox-list";

export const metadata: Metadata = {
  title: "Inquiries",
  description: "Read and reply to product questions and customer support messages.",
};

interface InquiriesPageProps {
  searchParams?: Promise<{
    status?: string;
    type?: string;
    reference?: string;
    page?: string;
  }>;
}

export default async function InquiriesPage({ searchParams }: InquiriesPageProps) {
  // 1. Authoritative admin boundary check
  await requireAdmin();

  const resolvedParams = searchParams ? await searchParams : {};
  const status = (resolvedParams.status as SellerInquiryFilterStatus) || "active";
  const type = (resolvedParams.type as SellerInquiryFilterType) || "all";
  const reference = resolvedParams.reference || "";
  const page = Math.max(1, parseInt(resolvedParams.page || "1", 10) || 1);

  let data;
  let dbError: string | null = null;

  try {
    const db = getDb();
    data = await listSellerInquiries(db, {
      status,
      type,
      reference,
      page,
      pageSize: 20,
    });
  } catch (error) {
    dbError =
      error instanceof Error ? error.message : "Database is unavailable or unconfigured.";
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inquiries"
        description="Unified inbox for product questions and customer support conversations."
      />

      {dbError ? (
        <EmptyState
          icon={AlertCircle}
          title="Inquiries unavailable"
          description="Could not connect to the database to load customer conversations. Please ensure the database is running."
          className="border-destructive/20 bg-destructive/5 text-destructive"
        />
      ) : data ? (
        <InboxList
          items={data.items}
          totalCount={data.totalCount}
          page={data.page}
          pageSize={data.pageSize}
          totalPages={data.totalPages}
          currentStatus={status}
          currentType={type}
          currentReference={reference}
        />
      ) : null}
    </div>
  );
}
