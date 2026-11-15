import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CreditCard,
  Database,
  FolderPlus,
  FolderTree,
  MessageSquareText,
  Package,
  PackagePlus,
  Send,
  Store,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OverviewCounts, OverviewData } from "@/lib/dashboard/overview";
import { cn } from "@/lib/utils";

const quickActions: Array<{
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
  testId: string;
}> = [
  {
    label: "Add product",
    href: "/products",
    icon: PackagePlus,
    description: "Open the product list to create a new item.",
    testId: "add-product",
  },
  {
    label: "Add category",
    href: "/categories",
    icon: FolderPlus,
    description: "Create a top-level or child category.",
    testId: "add-category",
  },
  {
    label: "View inquiries",
    href: "/inquiries",
    icon: MessageSquareText,
    description: "Read and reply to customer conversations.",
    testId: "view-inquiries",
  },
  {
    label: "Configure storefront",
    href: "/storefront",
    icon: Store,
    description: "Choose the customer menu entries and their order.",
    testId: "configure-storefront",
  },
  {
    label: "Manage payment methods",
    href: "/payment-methods",
    icon: CreditCard,
    description: "Edit customer instructions. No live checkout is enabled.",
    testId: "manage-payment-methods",
  },
  {
    label: "Telegram diagnostics",
    href: "/telegram",
    icon: Send,
    description: "See what is managed here and what is configured outside Rabet.",
    testId: "telegram-diagnostics",
  },
];

function OverviewNotice({
  icon: Icon,
  title,
  description,
  tone,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone: "warning" | "danger" | "info";
  children?: React.ReactNode;
}) {
  return (
    <Card
      className={cn(
        "border-dashed",
        tone === "warning" && "border-amber-500/40 bg-amber-500/5",
        tone === "danger" && "border-destructive/30 bg-destructive/5",
        tone === "info" && "border-primary/30 bg-primary/5",
      )}
      data-testid={`overview-notice-${tone}`}
    >
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-xl",
            tone === "warning" && "bg-amber-500/10 text-amber-700",
            tone === "danger" && "bg-destructive/10 text-destructive",
            tone === "info" && "bg-primary/10 text-primary",
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-heading text-base font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
          {children ? <div className="pt-1">{children}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function StatCard({
  label,
  value,
  detail,
  href,
  icon: Icon,
  testId,
}: {
  label: string;
  value: number;
  detail: string;
  href: string;
  icon: LucideIcon;
  testId: string;
}) {
  return (
    <Link
      href={href}
      className="group block min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      data-testid={testId}
      data-count={value}
    >
      <Card className="h-full transition-colors group-hover:bg-muted/40">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
            </div>
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            >
              <Icon className="size-5" />
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{detail}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

function OverviewStats({ counts }: { counts: OverviewCounts }) {
  const inquiryDetail =
    counts.activeInquiries === 0
      ? "No customer conversations are open or waiting."
      : counts.activeInquiries === 1
        ? "1 conversation is open or waiting on a customer."
        : `${counts.activeInquiries} conversations are open or waiting on a customer.`;

  const paymentDetail = counts.paymentMethodsAvailable
    ? "Prototype instructions only. No live payment processing."
    : "Configuration becomes available after the pending database upgrade.";

  return (
    <section aria-labelledby="store-counts-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2
            id="store-counts-heading"
            className="font-heading text-lg font-semibold tracking-tight"
          >
            Store at a glance
          </h2>
          <p className="text-sm text-muted-foreground">
            Counts come directly from your saved store data.
          </p>
        </div>
        <Badge variant="outline" className="font-normal text-muted-foreground">
          Payment methods are configuration only
        </Badge>
      </div>

      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="overview-stats"
      >
        <StatCard
          label="Products"
          value={counts.products}
          detail="Saved products in your store."
          href="/products"
          icon={Package}
          testId="overview-stat-products"
        />
        <StatCard
          label="Categories"
          value={counts.categories}
          detail="Root and child categories."
          href="/categories"
          icon={FolderTree}
          testId="overview-stat-categories"
        />
        <StatCard
          label="Active inquiries"
          value={counts.activeInquiries}
          detail={inquiryDetail}
          href="/inquiries"
          icon={MessageSquareText}
          testId="overview-stat-inquiries"
        />
        <StatCard
          label="Payment methods"
          value={counts.paymentMethods}
          detail={paymentDetail}
          href="/payment-methods"
          icon={CreditCard}
          testId="overview-stat-payment-methods"
        />
      </div>
    </section>
  );
}

function QuickActions() {
  return (
    <section aria-labelledby="quick-actions-heading" className="space-y-4">
      <div className="space-y-1">
        <h2
          id="quick-actions-heading"
          className="font-heading text-lg font-semibold tracking-tight"
        >
          Quick actions
        </h2>
        <p className="text-sm text-muted-foreground">
          Common daily tasks, without hunting through the menu.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {quickActions.map((action) => {
          const Icon = action.icon;

          return (
            <Link
              key={action.href}
              href={action.href}
              data-testid={`overview-quick-action-${action.testId}`}
              className="group flex min-h-11 min-w-0 items-center gap-3 rounded-xl border bg-card p-3.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
              >
                <Icon className="size-4.5" />
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-sm font-medium">{action.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {action.description}
                </span>
              </span>
              <ArrowRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function OverviewDashboard({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-8" data-testid="overview-dashboard">
      <PageHeader
        title="Overview"
        description={
          data.kind === "ready"
            ? `Your store at a glance: current totals for ${data.storeName}, plus the tasks you do most often.`
            : "Your merchant home for products, customer conversations, and store setup."
        }
      />

      {data.kind === "ready" ? <OverviewStats counts={data.counts} /> : null}

      {data.kind === "database_setup_required" ? (
        <OverviewNotice
          icon={Database}
          title="Database setup required"
          description="Connect the application database before product, category, inquiry, and payment counts can appear."
          tone="warning"
        >
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/settings">Open settings</Link>
          </Button>
        </OverviewNotice>
      ) : null}

      {data.kind === "database_unavailable" ? (
        <OverviewNotice
          icon={AlertTriangle}
          title="Store data is temporarily unavailable"
          description={data.message}
          tone="danger"
        >
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/settings">Check store settings</Link>
          </Button>
        </OverviewNotice>
      ) : null}

      {data.kind === "store_setup_required" ? (
        <OverviewNotice
          icon={Store}
          title="Finish setting up your store"
          description="Add your store name, currency, and language in Settings. Product, inquiry, and payment tools become available after that."
          tone="info"
        >
          <Button asChild className="min-h-11">
            <Link href="/settings">Complete store setup</Link>
          </Button>
        </OverviewNotice>
      ) : null}

      <QuickActions />
    </div>
  );
}
