import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface InquiryStatusBadgeProps {
  status: "open" | "waiting_on_customer" | "resolved" | "closed";
  className?: string;
}

export function InquiryStatusBadge({
  status,
  className,
}: InquiryStatusBadgeProps) {
  switch (status) {
    case "open":
      return (
        <Badge
          variant="outline"
          className={cn(
            "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            className,
          )}
        >
          Open
        </Badge>
      );
    case "waiting_on_customer":
      return (
        <Badge
          variant="outline"
          className={cn(
            "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            className,
          )}
        >
          Waiting on customer
        </Badge>
      );
    case "resolved":
      return (
        <Badge
          variant="outline"
          className={cn(
            "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
            className,
          )}
        >
          Resolved
        </Badge>
      );
    case "closed":
      return (
        <Badge
          variant="outline"
          className={cn(
            "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
            className,
          )}
        >
          Closed
        </Badge>
      );
  }
}
