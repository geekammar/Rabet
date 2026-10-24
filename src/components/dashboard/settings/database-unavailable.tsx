"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

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
 * State B: Displayed when the database is configured but temporarily unavailable or failing queries.
 */
export function DatabaseUnavailable({
  message,
}: {
  message?: string;
}) {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Store-wide configuration and bot preferences."
      />

      <Card className="border-destructive/30 bg-destructive/5">
        <CardHeader className="gap-3">
          <div className="flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <AlertTriangle className="size-6" />
          </div>
          <div>
            <CardTitle className="text-lg">Database Temporarily Unavailable</CardTitle>
            <CardDescription className="text-sm">
              The application could not establish a connection to the database.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {message ||
              "The database is currently unreachable. This may be due to a transient network issue or scheduled maintenance."}
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button
              variant="outline"
              className="min-h-11 gap-2"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="size-4" />
              <span>Retry Connection</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
