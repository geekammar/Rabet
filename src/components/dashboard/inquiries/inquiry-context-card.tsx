import { FolderTree, HelpCircle, Package, Snowflake, Tag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface FrozenProductSnapshot {
  name?: string;
  price?: string;
  currency?: string;
  categoryPath?: string[];
  type?: string;
}

interface InquiryContextCardProps {
  isSupport: boolean;
  category?: string | null;
  productSnapshot: unknown;
  selectedOptions?: unknown;
}

export function InquiryContextCard({
  isSupport,
  category,
  productSnapshot,
  selectedOptions,
}: InquiryContextCardProps) {
  const snapshot = (productSnapshot ?? {}) as FrozenProductSnapshot;
  const options = Array.isArray(selectedOptions)
    ? (selectedOptions as string[])
    : [];

  return (
    <Card className="border-border/60 bg-muted/20">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          {isSupport ? (
            <HelpCircle className="size-4 text-primary" />
          ) : (
            <Package className="size-4 text-primary" />
          )}
          <CardTitle className="text-sm font-medium">
            {isSupport ? "Support Context" : "Product Context"}
          </CardTitle>
        </div>
        <Badge
          variant="outline"
          className="gap-1 border-muted-foreground/30 text-[11px] text-muted-foreground"
          title="This context was frozen at conversation creation and never mutates when catalog items change"
        >
          <Snowflake className="size-3" />
          Frozen context
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 pt-0 text-sm">
        {isSupport ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Tag className="size-3.5" />
              <span>Category:</span>
              <span className="font-medium text-foreground">
                {category || "General Support"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Customer initiated this support request directly through Telegram.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-foreground" dir="auto">
                {snapshot.name ?? "Product Inquiry"}
              </span>
              {snapshot.price ? (
                <span className="font-mono text-sm font-semibold text-primary">
                  {snapshot.price} {snapshot.currency ?? "SAR"}
                </span>
              ) : null}
            </div>

            {snapshot.categoryPath && snapshot.categoryPath.length > 0 ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FolderTree className="size-3.5 shrink-0" />
                <span className="truncate" dir="auto">
                  {snapshot.categoryPath.join(" › ")}
                </span>
              </div>
            ) : null}

            {options.length > 0 ? (
              <div className="space-y-1 rounded-md bg-background/60 p-2 text-xs">
                <span className="font-medium text-muted-foreground">
                  Selected Button Path:
                </span>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {options.map((opt, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground"
                      dir="auto"
                    >
                      {opt}
                      {idx < options.length - 1 ? (
                        <span className="text-muted-foreground">›</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
