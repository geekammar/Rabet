import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bot, MessageSquareText, Send, Store } from "lucide-react";

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

export const metadata: Metadata = {
  title: "Telegram / Diagnostics",
  description: "What is managed in Rabet and what is configured outside the dashboard.",
};

const setupLinks = [
  {
    href: "/storefront",
    label: "Storefront",
    description: "Choose the customer menu entries and preview their order.",
    icon: Store,
  },
  {
    href: "/bot-content",
    label: "Bot Content",
    description: "Edit the welcome message and other customer-facing text.",
    icon: MessageSquareText,
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Run seller notification connection tests and review delivery diagnostics.",
    icon: Bot,
  },
];

export default function TelegramPage() {
  return (
    <div className="space-y-8" data-testid="telegram-diagnostics">
      <PageHeader
        title="Telegram / Diagnostics"
        description="The customer bot is configured outside this dashboard. Use these links for the parts you can manage safely here."
      />

      <Card className="border-primary/20 bg-primary/5">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Customer bot connection</CardTitle>
            <Badge variant="outline" className="font-normal">
              Managed by the operator
            </Badge>
          </div>
          <CardDescription>
            The customer-facing Telegram bot uses a server environment token and
            a registered webhook. Rabet does not display, edit, or verify those
            credentials or webhook details on this page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Bot credentials, webhook registration, and disconnecting the bot
            remain operator tasks. They are intentionally not editable from the
            merchant dashboard.
          </p>
          <p>
            Seller notification connection tests and delivery diagnostics are
            available in Settings. A successfully verified notification bot
            username is shown there; its token and webhook secret never are.
          </p>
        </CardContent>
      </Card>

      <section aria-labelledby="telegram-manage-heading" className="space-y-4">
        <h2
          id="telegram-manage-heading"
          className="font-heading text-lg font-semibold tracking-tight"
        >
          Manage what is available here
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {setupLinks.map((link) => {
            const Icon = link.icon;

            return (
              <Link
                key={link.href}
                href={link.href}
                className="group flex min-h-11 min-w-0 items-center gap-3 rounded-xl border bg-card p-3.5 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                >
                  <Icon className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-sm font-medium">{link.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {link.description}
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="size-4 text-muted-foreground" aria-hidden="true" />
            Not managed in this dashboard
          </CardTitle>
          <CardDescription>
            These tasks still require the operator and are not presented as
            merchant controls.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Viewing or changing the bot token.</li>
            <li>Registering, rotating, or inspecting webhook details.</li>
            <li>Disconnecting or replacing the customer bot.</li>
          </ul>
        </CardContent>
      </Card>

      <div>
        <Button asChild variant="outline" className="min-h-11 gap-2">
          <Link href="/settings">
            <Bot className="size-4" />
            <span>Open seller notification diagnostics</span>
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
