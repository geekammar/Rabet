import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { MerchantOrderActions } from "@/components/dashboard/orders/order-actions";
import { getDb } from "@/db/client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import {
  listMerchantOrders,
  type MerchantOrder,
} from "@/lib/commerce/orders";
import type { MerchantLocale } from "@/lib/merchant/locale";
import {
  merchantPageMetadata,
  readMerchantLocale,
} from "@/lib/merchant/locale-server";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata(
    "orders",
    "Accept, prepare or cancel cash-on-delivery orders for the signed-in store.",
  );
}

export const instant = false;

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  backToStore: string;
  timeline: string;
  acceptedAt: string;
  preparingAt: string;
  handedToShippingAt: string;
  deliveredAt: string;
  paymentCollectedAt: string;
  unknownTime: string;
  empty: string;
  status: string;
  payment: string;
  method: string;
  stock: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  customer: string;
  name: string;
  phone: string;
  address: string;
  suspendedTitle: string;
  suspendedBody: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "طلبات الدفع عند الاستلام",
    subtitle:
      "اقبل الطلب وجهّزه، ثم سلّمه للشحن وأكّد التوصيل وسجّل التحصيل. تظهر الحالة الحالية وحالة الدفع بشكل منفصل.",
    backToStore: "العودة إلى المتجر",
    timeline: "المسار الزمني",
    acceptedAt: "القبول",
    preparingAt: "بدء التجهيز",
    handedToShippingAt: "تسليم للشحن",
    deliveredAt: "التوصيل",
    paymentCollectedAt: "تحصيل الدفع",
    unknownTime: "الوقت غير معروف",
    empty: "لا توجد طلبات دفع عند الاستلام بعد.",
    status: "الحالة",
    payment: "الدفع",
    method: "الطريقة",
    stock: "المخزون",
    subtotal: "المجموع الفرعي",
    deliveryFee: "رسوم التوصيل",
    total: "الإجمالي",
    customer: "العميل",
    name: "الاسم",
    phone: "الهاتف",
    address: "العنوان",
    suspendedTitle: "المتجر موقوف مؤقتًا.",
    suspendedBody:
      "يمكنك الاطلاع على الطلبات فقط. القبول والتجهيز والإلغاء غير متاحة حتى يعيد مسؤول المنصة تفعيل المتجر.",
  },
  en: {
    dir: "ltr",
    title: "COD orders",
    subtitle:
      "Accept and prepare the order, hand it to shipping, mark it delivered and record COD collection. The current status and payment are shown separately.",
    backToStore: "Back to store",
    timeline: "Timeline",
    acceptedAt: "Accepted",
    preparingAt: "Preparing",
    handedToShippingAt: "Handed to shipping",
    deliveredAt: "Delivered",
    paymentCollectedAt: "Cash collected",
    unknownTime: "Time unknown",
    empty: "No cash-on-delivery orders yet.",
    status: "Status",
    payment: "Payment",
    method: "Method",
    stock: "Stock",
    subtotal: "Subtotal",
    deliveryFee: "Delivery fee",
    total: "Total",
    customer: "Customer",
    name: "Name",
    phone: "Phone",
    address: "Address",
    suspendedTitle: "This store is suspended.",
    suspendedBody:
      "You can review orders only. Accept, prepare and cancel are unavailable until a platform administrator reactivates the store.",
  },
};

const STATUS_COPY: Record<
  MerchantLocale,
  Record<string, string>
> = {
  ar: {
    placed: "تم الطلب",
    accepted: "مقبول",
    preparing: "قيد التجهيز",
    cancelled: "ملغي",
    awaiting_collection: "بانتظار التحصيل",
    collected: "تم التحصيل",
    failed: "فشل",
    unfulfilled: "بانتظار الشحن",
    handed_to_shipping: "تم التسليم للشحن",
    delivered: "تم التوصيل",
    reserved: "محجوز",
    committed: "مثبت",
    released: "محرر",
    cod: "الدفع عند الاستلام",
  },
  en: {
    placed: "placed",
    accepted: "accepted",
    preparing: "preparing",
    cancelled: "cancelled",
    awaiting_collection: "awaiting collection",
    collected: "collected",
    failed: "failed",
    unfulfilled: "awaiting handoff",
    handed_to_shipping: "handed to shipping",
    delivered: "delivered",
    reserved: "reserved",
    committed: "committed",
    released: "released",
    cod: "cash on delivery",
  },
};

function statusLabel(
  value: string,
  locale: MerchantLocale,
): string {
  return STATUS_COPY[locale][value] ?? value.replaceAll("_", " ");
}

function StatusPill({
  label,
  value,
  locale,
  testId,
}: {
  label: string;
  value: string;
  locale: MerchantLocale;
  testId?: string;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium"
      data-testid={testId}
      data-value={value}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all">{statusLabel(value, locale)}</span>
    </span>
  );
}

/**
 * One operational status for the merchant. Before handoff the merchant
 * progress state is current; after handoff the fulfillment state is current.
 * Payment remains a separate badge.
 */
function currentOrderStatus(order: MerchantOrder): string {
  if (order.status === "cancelled" || order.fulfillmentStatus === "cancelled") {
    return "cancelled";
  }

  if (
    order.fulfillmentStatus === "handed_to_shipping" ||
    order.fulfillmentStatus === "delivered"
  ) {
    return order.fulfillmentStatus;
  }

  return order.status;
}

type TimelineEntry = {
  label: string;
  at: Date | null;
};

function buildTimeline(order: MerchantOrder, copy: Copy): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  if (order.acceptedAt) {
    entries.push({ label: copy.acceptedAt, at: order.acceptedAt });
  }

  if (order.preparingAt) {
    entries.push({ label: copy.preparingAt, at: order.preparingAt });
  }

  if (
    order.fulfillmentStatus === "handed_to_shipping" ||
    order.fulfillmentStatus === "delivered"
  ) {
    entries.push({
      label: copy.handedToShippingAt,
      at: order.handedToShippingAt,
    });
  }

  if (order.fulfillmentStatus === "delivered") {
    entries.push({ label: copy.deliveredAt, at: order.deliveredAt });
  }

  if (order.paymentStatus === "collected") {
    entries.push({
      label: copy.paymentCollectedAt,
      at: order.paymentCollectedAt,
    });
  }

  return entries;
}

function OrderCard({
  order,
  copy,
  locale,
  dateFormat,
  readOnly,
}: {
  order: MerchantOrder;
  copy: Copy;
  locale: MerchantLocale;
  dateFormat: Intl.DateTimeFormat;
  readOnly: boolean;
}) {
  const timeline = buildTimeline(order, copy);
  const displayStatus = currentOrderStatus(order);

  return (
    <article
      id={`merchant-order-${order.id}`}
      className="scroll-mt-4 space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm"
      data-testid="merchant-order-card"
      data-current-status={displayStatus}
      data-payment-status={order.paymentStatus}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="break-all font-heading text-lg font-semibold">
            {order.reference}
          </h2>
          <p className="text-xs text-muted-foreground">
            {dateFormat.format(order.placedAt)} UTC
          </p>
        </div>
        <p className="text-right font-heading text-lg font-semibold">
          {order.total} {order.currency}
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <StatusPill
          label={copy.status}
          value={displayStatus}
          locale={locale}
          testId="merchant-order-status"
        />
        <StatusPill
          label={copy.payment}
          value={order.paymentStatus}
          locale={locale}
          testId="merchant-order-payment"
        />
        <StatusPill
          label={copy.method}
          value={order.paymentMethod}
          locale={locale}
        />
        {order.reservationStatuses.map((status, index) => (
          <StatusPill
            key={`${status}-${index}`}
            label={copy.stock}
            value={status}
            locale={locale}
          />
        ))}
      </div>

      <MerchantOrderActions
        orderId={order.id}
        status={order.status}
        fulfillmentStatus={order.fulfillmentStatus}
        paymentStatus={order.paymentStatus}
        orderReference={order.reference}
        cancellationReason={order.cancellationReason}
        total={order.total}
        currency={order.currency}
        locale={locale}
        readOnly={readOnly}
      />

      {timeline.length > 0 ? (
        <dl
          className="space-y-1 rounded-lg border border-border p-3 text-xs"
          data-testid="merchant-order-timeline"
        >
          <p className="font-medium text-muted-foreground">{copy.timeline}</p>
          {timeline.map((entry) => (
            <div
              key={entry.label}
              className="flex flex-wrap justify-between gap-2"
              data-testid="merchant-order-timeline-entry"
              data-known={entry.at ? "true" : "false"}
            >
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="font-medium">
                {entry.at
                  ? `${dateFormat.format(entry.at)} UTC`
                  : copy.unknownTime}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

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
          <dt className="text-muted-foreground">{copy.subtotal}</dt>
          <dd className="font-medium">
            {order.subtotal} {order.currency}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{copy.deliveryFee}</dt>
          <dd className="font-medium">
            {order.deliveryFee} {order.currency}
          </dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-border pt-1">
          <dt className="font-medium">{copy.total}</dt>
          <dd className="font-semibold">
            {order.total} {order.currency}
          </dd>
        </div>
      </dl>

      <div className="space-y-1 rounded-lg bg-muted/60 p-3 text-sm">
        <p className="text-muted-foreground">{copy.customer}</p>
        <p className="break-words font-medium">{order.customerName}</p>
        <p className="break-all text-muted-foreground">
          <span className="font-medium">{copy.phone}: </span>
          {order.customerPhone}
        </p>
        <p className="break-words text-muted-foreground">
          <span className="font-medium">{copy.address}: </span>
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
  const [orders, locale] = await Promise.all([
    listMerchantOrders(getDb(), access.scope),
    readMerchantLocale(),
  ]);
  const copy = COPY[locale];
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

  return (
    <main
      dir={copy.dir}
      lang={locale}
      className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-6"
      data-testid="merchant-orders-page"
    >
      <header className="mb-6 space-y-1">
        <p className="text-sm text-muted-foreground">{access.store.name}</p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {copy.title}
        </h1>
        <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        <p className="pt-2">
          <Link
            href="/app/setup"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            data-testid="merchant-orders-back"
          >
            {copy.backToStore}
          </Link>
        </p>
      </header>

      {access.readOnly ? (
        <div
          role="status"
          className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          data-testid="merchant-orders-suspended-notice"
        >
          <p className="font-semibold">{copy.suspendedTitle}</p>
          <p className="mt-1">{copy.suspendedBody}</p>
        </div>
      ) : null}

      {orders.length === 0 ? (
        <section className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          {copy.empty}
        </section>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              copy={copy}
              locale={locale}
              dateFormat={dateFormat}
              readOnly={access.readOnly}
            />
          ))}
        </div>
      )}
    </main>
  );
}
