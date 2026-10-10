import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, Coins, LayoutDashboard, Store } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Rabet — Sell digital services through Telegram",
  description:
    "Rabet is a lightweight Telegram-based digital services management system with a web dashboard for services, orders, customers and payments.",
};

const REPOSITORY_URL = "https://github.com/geekammar/Rabet";

const features = [
  {
    icon: Store,
    title: "Storefront inside Telegram",
    description:
      "Customers browse your services and place orders without ever leaving the chat.",
  },
  {
    icon: LayoutDashboard,
    title: "One dashboard for everything",
    description:
      "Manage services, orders, customers and payments from a single clean web interface.",
  },
  {
    icon: Coins,
    title: "Paid with Telegram Stars",
    description:
      "Digital goods sold inside Telegram are settled with Telegram Stars, as required by Telegram.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Logo />
        <Button asChild size="sm" variant="outline">
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
            Phase 1 · Foundation &amp; UI shell
          </span>
          <h1 className="mt-6 font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Sell digital services through Telegram
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
            Rabet (رابط) connects a Telegram bot to a simple web dashboard, so
            you can publish services, track orders and manage customers in one
            place.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/overview">
                Open dashboard
                <ArrowRightIcon />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
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
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
          <p>Rabet · Phase 1 — Discovery &amp; Development</p>
          <nav aria-label="Footer">
            <Link
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline-offset-4 hover:underline"
            >
              GitHub
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
