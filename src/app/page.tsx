import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, ListTree, MessageSquareText, Store } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Rabet — Digital product catalog for Telegram",
  description:
    "Rabet is a Telegram digital-product catalog with configurable menus and a dashboard for seller inquiries.",
};

const REPOSITORY_URL = "https://github.com/geekammar/Rabet";

const features = [
  {
    icon: Store,
    title: "Digital product catalog",
    description:
      "Planned: let customers browse products, categories and displayed prices inside Telegram.",
  },
  {
    icon: ListTree,
    title: "Configurable button trees",
    description:
      "Planned: build multi-level product menus with actions and messages from the dashboard.",
  },
  {
    icon: MessageSquareText,
    title: "Seller conversations",
    description:
      "Planned: customers ask about products, and the seller responds through Rabet.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex min-h-16 w-full max-w-5xl items-center justify-between px-4 pt-[env(safe-area-inset-top)] sm:px-6 lg:px-8">
        <Logo />
        <Button asChild size="sm" variant="outline" className="h-11">
          <Link href="/overview">Open dashboard</Link>
        </Button>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="mx-auto w-full max-w-3xl px-4 py-20 text-center sm:px-6 lg:py-28">
          <span className="inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-amber-500"
            />
            Catalog & inquiries · Discovery
          </span>
          <h1 className="mt-6 font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Showcase digital products in Telegram
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
            Rabet (رابط) is building a configurable product catalog with
            nested Telegram menus and a seller inbox for customer inquiries.
            No payment checkout is included in the discovery MVP.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="h-11">
              <Link href="/overview">
                Open dashboard
                <ArrowRightIcon />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-11">
              <Link href={REPOSITORY_URL} target="_blank" rel="noreferrer">
                View on GitHub
              </Link>
            </Button>
          </div>
        </section>

        <section className="mx-auto w-full max-w-5xl px-4 pb-20 sm:px-6 lg:pb-28">
          <div className="grid gap-4 sm:grid-cols-3">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <Card key={feature.title} className="h-full">
                  <CardHeader>
                    <span
                      aria-hidden="true"
                      className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground"
                    >
                      <Icon className="size-5" />
                    </span>
                    <CardTitle className="mt-4">{feature.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {feature.description}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-3 px-4 py-6 pb-[max(env(safe-area-inset-bottom),1.5rem)] text-sm text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
          <p>Rabet · Discovery &amp; Development</p>
          <nav aria-label="Footer">
            <Link
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              GitHub
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
