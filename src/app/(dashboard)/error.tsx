"use client";

import { Button } from "@/components/ui/button";

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed bg-muted/30 px-6 py-16 text-center">
      <div className="space-y-2">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          An unexpected error occurred while loading this page. You can try
          loading it again.
        </p>
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
