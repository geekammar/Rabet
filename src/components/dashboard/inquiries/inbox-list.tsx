"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  HelpCircle,
  Inbox,
  Package,
  RefreshCw,
  Search,
  User,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { InquiryStatusBadge } from "./inquiry-status-badge";
import type { SellerInquiryItem } from "@/lib/data/seller-inbox";

interface InboxListProps {
  items: SellerInquiryItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  currentStatus: string;
  currentType: string;
  currentReference: string;
}

export function InboxList({
  items,
  totalCount,
  page,
  totalPages,
  currentStatus,
  currentType,
  currentReference,
}: InboxListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function updateQuery(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, val] of Object.entries(updates)) {
      if (val === null || val === "" || (key === "page" && val === "1")) {
        params.delete(key);
      } else {
        params.set(key, val);
      }
    }
    startTransition(() => {
      router.push(`/inquiries?${params.toString()}`);
    });
  }

  function handleRefresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const ref = (formData.get("reference") as string) ?? "";
    updateQuery({ reference: ref.trim() || null, page: "1" });
  }

  return (
    <div className="space-y-4 w-full min-w-0 max-w-full">
      {/* Controls Bar: Filters, Search, Refresh */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Status & Type Filter Pills */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status filters */}
          <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-1 text-xs">
            {[
              { id: "active", label: "Active" },
              { id: "open", label: "Open" },
              { id: "waiting_on_customer", label: "Waiting" },
              { id: "resolved", label: "Resolved" },
              { id: "closed", label: "Closed" },
              { id: "all", label: "All" },
            ].map((tab) => {
              const isSelected =
                currentStatus === tab.id || (!currentStatus && tab.id === "active");
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => updateQuery({ status: tab.id, page: "1" })}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors touch-manipulation min-h-[32px] ${
                    isSelected
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Type filters */}
          <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1 text-xs">
            {[
              { id: "all", label: "All Types" },
              { id: "product", label: "Products" },
              { id: "support", label: "Support" },
            ].map((tab) => {
              const isSelected =
                currentType === tab.id || (!currentType && tab.id === "all");
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => updateQuery({ type: tab.id, page: "1" })}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors touch-manipulation min-h-[32px] ${
                    isSelected
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Search & Refresh */}
        <div className="flex items-center gap-2">
          <form
            onSubmit={handleSearchSubmit}
            className="relative flex-1 sm:w-56"
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              name="reference"
              defaultValue={currentReference}
              placeholder="Search reference..."
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </form>

          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isPending}
            className="size-9 p-0 touch-manipulation"
            title="Refresh conversations"
          >
            <RefreshCw
              className={`size-3.5 ${isPending ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </div>

      {/* Inquiry List */}
      {items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No conversations found"
          description={
            currentReference
              ? `No inquiries found matching reference "${currentReference}".`
              : "No inquiries or support requests match the selected filters."
          }
        >
          {currentReference || currentStatus !== "active" || currentType !== "all" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                updateQuery({ status: "active", type: "all", reference: null, page: "1" })
              }
            >
              Reset Filters
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <div className="divide-y rounded-xl border bg-card overflow-hidden">
          {items.map((item) => {
            const customerName =
              [item.customer.firstName, item.customer.lastName]
                .filter(Boolean)
                .join(" ") ||
              (item.customer.telegramUsername
                ? `@${item.customer.telegramUsername}`
                : `User ${item.customer.telegramId}`);

            const timeLabel = new Date(
              item.lastReplyAt || item.openedAt,
            ).toLocaleDateString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });

            return (
              <Link
                key={item.id}
                href={`/inquiries/${item.id}`}
                className="group flex flex-col gap-2 p-4 transition-colors hover:bg-muted/40 focus:outline-none focus-visible:bg-muted/50"
              >
                {/* Row 1: Header (Reference, Badges, Time) */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-primary">
                      {item.reference}
                    </span>
                    <InquiryStatusBadge status={item.status} />
                    {item.isSupport ? (
                      <Badge
                        variant="secondary"
                        className="gap-1 text-[11px] font-normal"
                      >
                        <HelpCircle className="size-3" />
                        {item.category || "Support"}
                      </Badge>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="gap-1 text-[11px] font-normal"
                      >
                        <Package className="size-3" />
                        Product
                      </Badge>
                    )}
                    {item.customer.isBlocked ? (
                      <Badge
                        variant="destructive"
                        className="text-[10px] px-1.5 py-0"
                      >
                        Blocked
                      </Badge>
                    ) : null}
                  </div>

                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {timeLabel}
                  </span>
                </div>

                {/* Row 2: Customer Identity */}
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <User className="size-3.5 shrink-0" />
                  <span className="font-medium text-foreground truncate max-w-[200px] sm:max-w-none" dir="auto">
                    {customerName}
                  </span>
                  {item.customer.telegramUsername ? (
                    <span className="text-muted-foreground/70 hidden sm:inline">
                      (@{item.customer.telegramUsername})
                    </span>
                  ) : null}
                </div>

                {/* Row 3: Message preview */}
                {item.lastMessage ? (
                  <p
                    className="line-clamp-2 text-xs text-muted-foreground break-words"
                    dir="auto"
                  >
                    <span className="font-medium text-foreground">
                      {item.lastMessage.author === "admin" ? "You: " : "Customer: "}
                    </span>
                    {item.lastMessage.body}
                  </p>
                ) : (
                  <p className="text-xs italic text-muted-foreground/70">
                    No messages yet.
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      )}

      {/* Pagination Bar */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
          <span>
            Page {page} of {totalPages} ({totalCount} total)
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isPending}
              onClick={() => updateQuery({ page: String(page - 1) })}
              className="min-h-[36px] px-3 touch-manipulation"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isPending}
              onClick={() => updateQuery({ page: String(page + 1) })}
              className="min-h-[36px] px-3 touch-manipulation"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
