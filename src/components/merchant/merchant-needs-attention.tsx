import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { MerchantLocale } from "@/lib/merchant/locale";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  body: string;
  waiting: (count: number) => string;
  emptyTitle: string;
  emptyBody: string;
  review: string;
  viewAll: string;
  reference: string;
  total: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "يحتاج تدخلك",
    body: "طلبات الدفع عند الاستلام التي لم تُقبل بعد تظهر هنا حتى تراجعها.",
    waiting: (count) => `بانتظار القبول: ${count}`,
    emptyTitle: "لا توجد طلبات بانتظار القبول.",
    emptyBody: "كل طلبات الدفع عند الاستلام تمت مراجعتها.",
    review: "مراجعة الطلب",
    viewAll: "عرض كل الطلبات",
    reference: "مرجع الطلب",
    total: "الإجمالي",
  },
  en: {
    dir: "ltr",
    title: "Needs Attention",
    body: "Cash-on-delivery orders that have not been accepted yet appear here for review.",
    waiting: (count) => `${count} awaiting acceptance`,
    emptyTitle: "No orders are waiting for acceptance.",
    emptyBody: "All cash-on-delivery orders have been reviewed.",
    review: "Review order",
    viewAll: "View all orders",
    reference: "Order reference",
    total: "Total",
  },
};

export type MerchantNeedsAttentionOrder = {
  id: string;
  reference: string;
  total: string;
  currency: string;
};

export function MerchantNeedsAttention({
  locale,
  orders,
}: {
  locale: MerchantLocale;
  orders: MerchantNeedsAttentionOrder[];
}) {
  const copy = COPY[locale];

  return (
    <section
      dir={copy.dir}
      lang={locale}
      aria-labelledby="merchant-needs-attention-title"
      className="space-y-4 rounded-xl border border-amber-300 bg-amber-50/60 p-5 shadow-sm dark:border-amber-900/50 dark:bg-amber-950/20"
      data-testid="merchant-needs-attention"
      data-pending-count={orders.length}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300">
          <AlertCircle className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              id="merchant-needs-attention-title"
              className="font-heading text-lg font-semibold"
            >
              {copy.title}
            </h2>
            <span
              className="inline-flex min-h-7 items-center rounded-full border border-amber-300 bg-background px-2.5 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:text-amber-200"
              data-testid="merchant-needs-attention-count"
            >
              {copy.waiting(orders.length)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
        </div>
      </div>

      {orders.length === 0 ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-border bg-background p-3 text-sm"
          data-testid="merchant-needs-attention-empty"
        >
          <CheckCircle2
            className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{copy.emptyTitle}</p>
            <p className="text-xs text-muted-foreground">{copy.emptyBody}</p>
          </div>
        </div>
      ) : (
        <ul
          className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background"
          data-testid="merchant-needs-attention-list"
        >
          {orders.map((order) => (
            <li key={order.id} data-testid="merchant-needs-attention-order">
              <Link
                href={`/app/orders#merchant-order-${order.id}`}
                className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                data-testid="merchant-needs-attention-link"
                data-order-id={order.id}
              >
                <span className="min-w-0 space-y-0.5">
                  <span className="block break-all font-medium" dir="ltr">
                    <span className="sr-only">{copy.reference}: </span>
                    {order.reference}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {copy.review}
                    <ArrowRight
                      className="size-3.5 rtl:rotate-180"
                      aria-hidden="true"
                    />
                  </span>
                </span>
                <span
                  className="shrink-0 font-heading text-sm font-semibold tabular-nums"
                  dir="ltr"
                >
                  <span className="sr-only">{copy.total}: </span>
                  {order.total} {order.currency}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
          <Link
            href="/app/orders"
            data-testid="merchant-needs-attention-view-all"
          >
            {copy.viewAll}
          </Link>
        </Button>
      </div>
    </section>
  );
}
