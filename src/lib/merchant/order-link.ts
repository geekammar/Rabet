const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMerchantOrderId(value: unknown): string | null {
  return typeof value === "string" && value.length === 36 && ORDER_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

export function merchantPostLoginPath(value: unknown): string {
  const orderId = parseMerchantOrderId(value);
  return orderId
    ? `/app/orders?order=${orderId}#merchant-order-${orderId}`
    : "/app/setup";
}
