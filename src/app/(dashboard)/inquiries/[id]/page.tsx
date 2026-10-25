import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, User, ShieldAlert } from "lucide-react";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  getSellerInquiryThread,
  listInquiryMessagesPaged,
} from "@/lib/data/seller-inbox";
import { InquiryStatusBadge } from "@/components/dashboard/inquiries/inquiry-status-badge";
import { InquiryContextCard } from "@/components/dashboard/inquiries/inquiry-context-card";
import { LifecycleActions } from "@/components/dashboard/inquiries/lifecycle-actions";
import { MessageList } from "@/components/dashboard/inquiries/message-list";
import { ReplyComposer } from "@/components/dashboard/inquiries/reply-composer";

export const metadata: Metadata = {
  title: "Inquiry Thread",
  description: "View and reply to customer inquiry thread.",
};

interface ThreadPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ page?: string }>;
}

export default async function ThreadPage({
  params,
  searchParams,
}: ThreadPageProps) {
  await requireAdmin();

  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const page = Math.max(1, parseInt(resolvedSearchParams.page || "1", 10) || 1);

  let thread;
  let messagesResult;

  try {
    const db = getDb();
    thread = await getSellerInquiryThread(db, id);
    messagesResult = await listInquiryMessagesPaged(db, id, {
      page,
      pageSize: 50,
    });
  } catch {
    notFound();
  }

  const { inquiry, customer, isSupport } = thread;
  const isActive =
    inquiry.status === "open" || inquiry.status === "waiting_on_customer";

  const customerDisplayName =
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
    (customer.telegramUsername
      ? `@${customer.telegramUsername}`
      : `Customer ${customer.telegramId}`);

  return (
    <div className="space-y-6 max-w-4xl min-w-0 w-full overflow-x-hidden">
      {/* Back to Inbox */}
      <div>
        <Link
          href="/inquiries"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors min-h-[36px] py-1"
        >
          <ArrowLeft className="size-3.5" />
          Back to Inquiries
        </Link>
      </div>

      {/* Header Bar */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-base font-bold text-primary">
              {inquiry.reference}
            </h1>
            <InquiryStatusBadge status={inquiry.status} />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <User className="size-3.5" />
              <span dir="auto">{customerDisplayName}</span>
            </span>
            {customer.telegramUsername ? (
              <span>(@{customer.telegramUsername})</span>
            ) : null}
            <span>• Telegram ID: {customer.telegramId}</span>
          </div>
        </div>

        {/* Lifecycle transitions */}
        <LifecycleActions inquiryId={inquiry.id} status={inquiry.status} />
      </div>

      {/* Customer Blocked Warning Banner */}
      {customer.isBlocked ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive">
          <ShieldAlert className="size-4 shrink-0" />
          <span>
            This customer blocked the bot on Telegram. Outgoing messages will be rejected until the customer re-engages.
          </span>
        </div>
      ) : null}

      {/* Frozen Context Card */}
      <InquiryContextCard
        isSupport={isSupport}
        category={inquiry.category}
        productSnapshot={inquiry.productSnapshot}
        selectedOptions={inquiry.selectedOptions}
      />

      {/* Message History */}
      <div className="rounded-xl border bg-card p-4 space-y-4">
        <div className="border-b pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Conversation History
          </h2>
        </div>

        <MessageList
          inquiryId={inquiry.id}
          messages={messagesResult.items}
          isActive={isActive}
        />

        {/* Message pagination if > 50 messages */}
        {messagesResult.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
            <span>
              Messages Page {messagesResult.page} of {messagesResult.totalPages}
            </span>
            <div className="flex items-center gap-2">
              {messagesResult.page > 1 ? (
                <Link
                  href={`/inquiries/${inquiry.id}?page=${messagesResult.page - 1}`}
                  className="rounded border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  Previous
                </Link>
              ) : null}
              {messagesResult.page < messagesResult.totalPages ? (
                <Link
                  href={`/inquiries/${inquiry.id}?page=${messagesResult.page + 1}`}
                  className="rounded border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  Next
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Reply Composer */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Send Reply
        </h2>

        <ReplyComposer
          inquiryId={inquiry.id}
          reference={inquiry.reference}
          isBlocked={customer.isBlocked}
          isActive={isActive}
        />
      </div>
    </div>
  );
}
