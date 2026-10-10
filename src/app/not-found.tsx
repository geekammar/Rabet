import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <div className="space-y-3">
        <p className="font-mono text-sm font-medium text-muted-foreground">
          404
        </p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          The page you are looking for does not exist or has not been built yet.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild className="h-11">
          <Link href="/">Back home</Link>
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link href="/overview">Open dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
