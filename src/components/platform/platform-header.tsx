import { platformLogout } from "@/app/actions/platform-auth";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export function PlatformHeader({ adminEmail }: { adminEmail: string }) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <Logo className="text-lg" />
          <span className="hidden text-sm text-muted-foreground sm:inline">
            Platform administration
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden max-w-64 truncate text-sm text-muted-foreground sm:inline">
            {adminEmail}
          </span>
          <form action={platformLogout}>
            <Button type="submit" variant="outline" size="sm" className="min-h-9">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
