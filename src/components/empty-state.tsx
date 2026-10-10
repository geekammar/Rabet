import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Slot for actions (links, buttons). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed bg-muted/30 px-6 py-14 text-center",
        className,
      )}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border"
        >
          <Icon className="size-6" />
        </span>
      ) : null}
      <div className="space-y-2">
        <h2 className="font-heading text-base font-medium">{title}</h2>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
