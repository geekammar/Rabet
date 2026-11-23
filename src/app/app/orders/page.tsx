import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import {
  listMerchantOrders,
  type MerchantOrder,
} from "@/lib/commerce/orders";

export const metadata: Metadata = {
  title: "COD orders",
  description: "Read-only cash-on-delivery orders for the signed-in store.",
};

export const instant = false;

const DATE_FORMAT = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function StatusPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all">{value.replaceAll("_", " ")}</span>
    </span>
  );
}

function OrderCard({ order }: { order: MerchantOrder }) {
  return (
    <article
      className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm"
      data-testid="merchant-order-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="break-all font-heading text-lg font-semibold">
            {order.reference}
          </h2>
          <p className="text-xs text-muted-foreground">
            {DATE_FORMAT.format(order.placedAt)} UTC
          </p>
        </div>
        <p className="text-right font-heading text-lg font-semibold">
          {order.total} {order.currency}
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <StatusPill label="Order" value={order.status} />
        <StatusPill label="Payment" value={order.paymentStatus} />
        <StatusPill label="Fulfillment" value={order.fulfillmentStatus} />
        <StatusPill label="Method" value={order.paymentMethod} />
        {order.reservationStatuses.map((status, index) => (
          <StatusPill
            key={`${status}-${index}`}
            label="Stock"
            value={status}
          />
        ))}
      </div>

      <ul className="space-y-2 border-y border-border py-3 text-sm">
        {order.items.map((item) => (
          <li
            key={`${order.id}-${item.productId}`}
            className="flex flex-wrap items-start justify-between gap-2"
          >
            <span className="min-w-0 break-words">
              {item.name} × {item.quantity}
            </span>
            <span className="shrink-0 font-medium">
              {item.lineTotal} {order.currency}
            </span>
          </li>
        ))}
      </ul>

      <dl className="grid gap-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="font-medium">
            {order.subtotal} {order.currency}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Delivery fee</dt>
          <dd className="font-medium">
            {order.deliveryFee} {order.currency}
          </dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-border pt-1">
          <dt className="font-medium">Total</dt>
          <dd className="font-semibold">
            {order.total} {order.currency}
          </dd>
        </div>
      </dl>

      <div className="space-y-1 rounded-lg bg-muted/60 p-3 text-sm">
        <p className="break-words font-medium">{order.customerName}</p>
        <p className="break-all text-muted-foreground">{order.customerPhone}</p>
        <p className="break-words text-muted-foreground">
          {order.deliveryAddress}
        </p>
      </div>
    </article>
  );
}

export default async function MerchantOrdersPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const orders = await listMerchantOrders(getDb(), access.scope);

  return (
    <main
      dir="ltr"
      lang="en"
      className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-6"
      data-testid="merchant-orders-page"
    >
      <header className="mb-6 space-y-1">
        <p className="text-sm text-muted-foreground">{access.store.name}</p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          COD orders
        </h1>
        <p className="text-sm text-muted-foreground">
          Read-only. Cash is collected on delivery; order, payment and
          fulfillment states are shown separately.
        </p>
      </header>

      {orders.length === 0 ? (
        <section className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          No cash-on-delivery orders yet.
        </section>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
      )}
    </main>
  );
}
