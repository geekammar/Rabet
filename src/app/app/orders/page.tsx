import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";

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
    "Read-only cash-on-delivery orders for the signed-in store.",
  );
}

export const instant = false;

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  backToStore: string;
  empty: string;
  order: string;
  payment: string;
  fulfillment: string;
  method: string;
  stock: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  customer: string;
  name: string;
  phone: string;
  address: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "طلبات الدفع عند الاستلام",
    subtitle:
      "عرض للقراءة فقط. يُحصّل الدفع عند التسليم، وتظهر حالة الطلب والدفع والتجهيز بشكل منفصل.",
    backToStore: "العودة إلى المتجر",
    empty: "لا توجد طلبات دفع عند الاستلام بعد.",
    order: "الطلب",
    payment: "الدفع",
    fulfillment: "التجهيز",
    method: "الطريقة",
    stock: "المخزون",
    subtotal: "المجموع الفرعي",
    deliveryFee: "رسوم التوصيل",
    total: "الإجمالي",
    customer: "العميل",
    name: "الاسم",
    phone: "الهاتف",
    address: "العنوان",
  },
  en: {
    dir: "ltr",
    title: "COD orders",
    subtitle:
      "Read-only. Cash is collected on delivery; order, payment and fulfillment states are shown separately.",
    backToStore: "Back to store",
    empty: "No cash-on-delivery orders yet.",
    order: "Order",
    payment: "Payment",
    fulfillment: "Fulfillment",
    method: "Method",
    stock: "Stock",
    subtotal: "Subtotal",
    deliveryFee: "Delivery fee",
    total: "Total",
    customer: "Customer",
    name: "Name",
    phone: "Phone",
    address: "Address",
  },
};

const STATUS_COPY: Record<
  MerchantLocale,
  Record<string, string>
> = {
  ar: {
    placed: "تم الطلب",
    cancelled: "ملغي",
    awaiting_collection: "بانتظار التحصيل",
    collected: "تم التحصيل",
    failed: "فشل",
    unfulfilled: "لم يُجهّز",
    handed_to_shipping: "تم التسليم للشحن",
    delivered: "تم التوصيل",
    reserved: "محجوز",
    committed: "مثبت",
    released: "محرر",
    cod: "الدفع عند الاستلام",
  },
  en: {
    placed: "placed",
    cancelled: "cancelled",
    awaiting_collection: "awaiting collection",
    collected: "collected",
    failed: "failed",
    unfulfilled: "unfulfilled",
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
}: {
  label: string;
  value: string;
  locale: MerchantLocale;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all">{statusLabel(value, locale)}</span>
    </span>
  );
}

function OrderCard({
  order,
  copy,
  locale,
  dateFormat,
}: {
  order: MerchantOrder;
  copy: Copy;
  locale: MerchantLocale;
  dateFormat: Intl.DateTimeFormat;
}) {
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
            {dateFormat.format(order.placedAt)} UTC
          </p>
        </div>
        <p className="text-right font-heading text-lg font-semibold">
          {order.total} {order.currency}
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <StatusPill label={copy.order} value={order.status} locale={locale} />
        <StatusPill
          label={copy.payment}
          value={order.paymentStatus}
          locale={locale}
        />
        <StatusPill
          label={copy.fulfillment}
          value={order.fulfillmentStatus}
          locale={locale}
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
            />
          ))}
        </div>
      )}
    </main>
  );
}
