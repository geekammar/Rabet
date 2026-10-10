import type { Metadata } from "next";
import Link from "next/link";
import { LayoutDashboard } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { navItems } from "@/lib/navigation";

export const metadata: Metadata = {
  title: "Overview",
  description: "A snapshot of store activity in Rabet.",
};

const operations = navItems.filter((item) =>
  ["/services", "/orders", "/customers", "/payments"].includes(item.href),
);

const configuration = navItems.filter((item) =>
  ["/bot-content", "/telegram", "/settings"].includes(item.href),
);

function SectionCard({
  href,
  icon: Icon,
  label,
  description,
}: {
  href: string;
  icon: (typeof navItems)[number]["icon"];
  label: string;
  description: string;
}) {
  return (
    <Link href={href} className="group block rounded-xl focus:outline-none">
      <Card className="h-full transition-colors group-hover:bg-muted/40 group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            >
              <Icon className="size-4.5" />
            </span>
            <CardTitle>{label}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function OverviewPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description="A snapshot of your store activity will be summarized here once services, orders and payments exist."
      />

      <EmptyState
        icon={LayoutDashboard}
        title="No activity yet"
        description="This is Phase 1 of Rabet. The dashboard shell and navigation are in place, but no services, orders, customers or payments have been added. Operational data will appear here in later phases."
      />

      <section aria-labelledby="operations-heading" className="space-y-4">
        <h2
          id="operations-heading"
          className="font-heading text-lg font-semibold tracking-tight"
        >
          Operations
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {operations.map((item) => (
            <SectionCard
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              description={item.description}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="configuration-heading" className="space-y-4">
        <h2
          id="configuration-heading"
          className="font-heading text-lg font-semibold tracking-tight"
        >
          Bot &amp; settings
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {configuration.map((item) => (
            <SectionCard
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              description={item.description}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
