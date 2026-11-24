import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getTransactionDb: vi.fn(() => ({ kind: "transaction-db" })),
  getMerchantAccess: vi.fn(),
  acceptMerchantOrder: vi.fn(),
  prepareMerchantOrder: vi.fn(),
  cancelMerchantOrder: vi.fn(),
  revalidatePath: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/db/transaction-client", () => ({
  getTransactionDb: state.getTransactionDb,
}));

vi.mock("@/lib/auth/merchant-session", () => ({
  getMerchantAccess: state.getMerchantAccess,
}));

vi.mock("@/lib/commerce/orders", () => ({
  acceptMerchantOrder: state.acceptMerchantOrder,
  prepareMerchantOrder: state.prepareMerchantOrder,
  cancelMerchantOrder: state.cancelMerchantOrder,
}));

vi.mock("next/cache", () => ({
  revalidatePath: state.revalidatePath,
  refresh: state.refresh,
}));

const {
  acceptMerchantOrderAction,
  prepareMerchantOrderAction,
  cancelMerchantOrderAction,
} = await import("../merchant-orders");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

const access = {
  userId: "22222222-2222-4222-8222-222222222222",
  email: "merchant@example.test",
  sessionVersion: 0,
  role: "owner" as const,
  store: {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Store A",
    slug: "store-a",
    status: "active" as const,
  },
  scope: { storeId: "33333333-3333-4333-8333-333333333333" },
  readOnly: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("merchant order actions — authorization and enablement", () => {
  it("does not resolve access or touch the database while the merchant app is disabled", async () => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "false");

    await expect(acceptMerchantOrderAction(ORDER_ID)).resolves.toEqual({
      success: false,
      code: "UNAVAILABLE",
    });

    expect(state.getMerchantAccess).not.toHaveBeenCalled();
    expect(state.getTransactionDb).not.toHaveBeenCalled();
    expect(state.acceptMerchantOrder).not.toHaveBeenCalled();
  });

  it("denies every action when the merchant access resolver fails closed", async () => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");
    state.getMerchantAccess.mockResolvedValue(null);

    await expect(acceptMerchantOrderAction(ORDER_ID)).resolves.toEqual({
      success: false,
      code: "DENIED",
    });
    await expect(prepareMerchantOrderAction(ORDER_ID)).resolves.toEqual({
      success: false,
      code: "DENIED",
    });
    await expect(
      cancelMerchantOrderAction({ orderId: ORDER_ID, reason: "Valid reason" }),
    ).resolves.toEqual({ success: false, code: "DENIED" });

    expect(state.getTransactionDb).not.toHaveBeenCalled();
  });

  it("rejects malformed order ids and invalid reasons before the database", async () => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");
    state.getMerchantAccess.mockResolvedValue(access);

    await expect(acceptMerchantOrderAction("not-a-uuid")).resolves.toEqual({
      success: false,
      code: "INVALID_INPUT",
    });
    await expect(
      cancelMerchantOrderAction({ orderId: ORDER_ID, reason: "no" }),
    ).resolves.toEqual({ success: false, code: "INVALID_REASON" });
    await expect(
      cancelMerchantOrderAction({ orderId: ORDER_ID, reason: "   " }),
    ).resolves.toEqual({ success: false, code: "INVALID_REASON" });

    expect(state.getTransactionDb).not.toHaveBeenCalled();
    expect(state.cancelMerchantOrder).not.toHaveBeenCalled();
  });
});

describe("merchant order actions — successful transitions", () => {
  beforeEach(() => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");
    state.getMerchantAccess.mockResolvedValue(access);
  });

  it("accepts the order through the scoped transaction and revalidates the Orders page", async () => {
    state.acceptMerchantOrder.mockResolvedValue({
      status: "accepted",
      orderId: ORDER_ID,
      reference: "ORD-ABC234",
      orderStatus: "accepted",
      fulfillmentStatus: "unfulfilled",
      cancellationReason: null,
      releasedQuantity: 0,
    });

    await expect(acceptMerchantOrderAction(ORDER_ID)).resolves.toEqual({
      success: true,
      code: "ACCEPTED",
      orderId: ORDER_ID,
      status: "accepted",
      fulfillmentStatus: "unfulfilled",
      releasedQuantity: 0,
    });

    expect(state.acceptMerchantOrder).toHaveBeenCalledWith(
      { kind: "transaction-db" },
      access.scope,
      ORDER_ID,
    );
    expect(state.revalidatePath).toHaveBeenCalledWith("/app/orders");
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("prepares the order and reports an idempotent retry truthfully", async () => {
    state.prepareMerchantOrder.mockResolvedValueOnce({
      status: "already_applied",
      orderId: ORDER_ID,
      reference: "ORD-ABC234",
      orderStatus: "preparing",
      fulfillmentStatus: "unfulfilled",
      cancellationReason: null,
      releasedQuantity: 0,
    });

    await expect(prepareMerchantOrderAction(ORDER_ID)).resolves.toEqual({
      success: true,
      code: "ALREADY_APPLIED",
      orderId: ORDER_ID,
      status: "preparing",
      fulfillmentStatus: "unfulfilled",
      releasedQuantity: 0,
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("cancels with the reason and reports the released quantity", async () => {
    state.cancelMerchantOrder.mockResolvedValue({
      status: "cancelled",
      orderId: ORDER_ID,
      reference: "ORD-ABC234",
      orderStatus: "cancelled",
      fulfillmentStatus: "cancelled",
      cancellationReason: "Customer changed mind",
      releasedQuantity: 2,
    });

    await expect(
      cancelMerchantOrderAction({
        orderId: ORDER_ID,
        reason: "  Customer changed mind  ",
      }),
    ).resolves.toEqual({
      success: true,
      code: "CANCELLED",
      orderId: ORDER_ID,
      status: "cancelled",
      fulfillmentStatus: "cancelled",
      releasedQuantity: 2,
    });

    expect(state.cancelMerchantOrder).toHaveBeenCalledWith(
      { kind: "transaction-db" },
      access.scope,
      { orderId: ORDER_ID, reason: "  Customer changed mind  " },
    );
    expect(state.revalidatePath).toHaveBeenCalledWith("/app/orders");
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("maps an invalid transition and does not refresh the page", async () => {
    state.prepareMerchantOrder.mockResolvedValue({
      status: "invalid_transition",
      currentStatus: "placed",
      fulfillmentStatus: "unfulfilled",
    });

    await expect(prepareMerchantOrderAction(ORDER_ID)).resolves.toEqual({
      success: false,
      code: "INVALID_TRANSITION",
      status: "placed",
      fulfillmentStatus: "unfulfilled",
    });
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not leak a database error to the caller", async () => {
    state.cancelMerchantOrder.mockRejectedValue(
      new Error("duplicate key value violates unique constraint secret_table"),
    );

    await expect(
      cancelMerchantOrderAction({ orderId: ORDER_ID, reason: "Valid reason" }),
    ).resolves.toEqual({ success: false, code: "DATABASE_ERROR" });
    expect(state.refresh).not.toHaveBeenCalled();
  });
});
