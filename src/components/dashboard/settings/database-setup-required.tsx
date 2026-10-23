"use client";

import { Database, ShieldAlert } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * State A: Displayed when `DATABASE_URL` is not configured in the runtime environment.
 *
 * Informs the administrator cleanly without exposing server details or breaking
 * the page build.
 */
export function DatabaseSetupRequired() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Store-wide configuration and bot preferences."
      />

      <Card className="border-dashed border-warning/50 bg-warning/5">
        <CardHeader className="gap-3">
          <div className="flex size-12 items-center justify-center rounded-xl bg-warning/10 text-warning">
            <Database className="size-6" />
          </div>
          <div>
            <CardTitle className="text-lg">Database Setup Required</CardTitle>
            <CardDescription className="text-sm">
              The application database has not been configured in this environment.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-background/50 p-4 text-sm text-muted-foreground space-y-2">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <ShieldAlert className="size-4 text-warning" />
              <span>Administrator Notice</span>
            </div>
            <p>
              To configure store settings, catalog products, and bot content,
              a PostgreSQL database connection string is required.
            </p>
            <ul className="list-disc pl-5 space-y-1 text-xs">
              <li>
                <strong>Development:</strong> Run{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  npm run db:setup:dev
                </code>{" "}
                to connect an isolated development database.
              </li>
              <li>
                <strong>Production / Preview:</strong> Configure the{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  DATABASE_URL
                </code>{" "}
                environment secret in your deployment settings.
              </li>
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }}
            >
              Refresh Status
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
