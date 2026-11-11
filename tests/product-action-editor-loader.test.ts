import { describe, expect, it, vi } from "vitest";

import {
  GuardedPaymentMethodsLoader,
  type GuardedLoaderState,
  type PaymentMethodFetchResult,
} from "@/lib/product-actions/payment-methods-loader";
import type { PaymentMethodRecord } from "@/lib/data";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("GuardedPaymentMethodsLoader — Preview Freshness & Controlled Response Ordering", () => {
  const methodA: PaymentMethodRecord = {
    id: "00000000-0000-0000-0000-000000000001",
    adminLabel: "Method A (Old)",
    isActive: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    translations: {
      en: {
        id: "trans-a-en",
        paymentMethodId: "00000000-0000-0000-0000-000000000001",
        languageId: "lang-en",
        languageCode: "en",
        title: "Title A (Old)",
        instructions: "Instructions A",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
  };

  const methodB: PaymentMethodRecord = {
    id: "00000000-0000-0000-0000-000000000002",
    adminLabel: "Method B (Newer)",
    isActive: true,
    sortOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    translations: {
      en: {
        id: "trans-b-en",
        paymentMethodId: "00000000-0000-0000-0000-000000000002",
        languageId: "lang-en",
        languageCode: "en",
        title: "Title B (Newer)",
        instructions: "Instructions B",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
  };

  it("retains newer request B when older request A resolves later (controlled response ordering)", async () => {
    const deferredA = createDeferred<PaymentMethodFetchResult>();
    const deferredB = createDeferred<PaymentMethodFetchResult>();

    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return deferredA.promise;
      return deferredB.promise;
    });

    const state: GuardedLoaderState = {
      methods: [],
      error: null,
      isRefreshing: false,
    };

    const loader = new GuardedPaymentMethodsLoader(fetcher, (patch) => {
      Object.assign(state, patch);
    });

    // 1. Start request A (generation 1)
    const loadPromiseA = loader.load({ isExplicitRefresh: true });
    expect(state.isRefreshing).toBe(true);

    // 2. Start newer request B (generation 2)
    const loadPromiseB = loader.load({ isExplicitRefresh: true });
    expect(loader.currentGeneration).toBe(2);

    // 3. Resolve newer request B first
    deferredB.resolve({
      success: true,
      methods: [methodB],
    });
    const resultB = await loadPromiseB;
    expect(resultB.applied).toBe(true);
    expect(state.methods).toEqual([methodB]);
    expect(state.error).toBeNull();
    expect(state.isRefreshing).toBe(false);

    // 4. Resolve older request A later
    deferredA.resolve({
      success: true,
      methods: [methodA],
    });
    const resultA = await loadPromiseA;

    // Stale response protection dropped A
    expect(resultA.applied).toBe(false);
    expect(resultA.reason).toBe("stale_or_unmounted");

    // The state MUST retain B's methods! A did not overwrite B.
    expect(state.methods).toEqual([methodB]);
    expect(state.methods[0].adminLabel).toBe("Method B (Newer)");
  });

  it("drops response gracefully when unmounted before request resolves", async () => {
    const deferred = createDeferred<PaymentMethodFetchResult>();
    const fetcher = vi.fn().mockReturnValue(deferred.promise);

    const state: GuardedLoaderState = {
      methods: [methodA],
      error: null,
      isRefreshing: false,
    };

    const loader = new GuardedPaymentMethodsLoader(fetcher, (patch) => {
      Object.assign(state, patch);
    });

    const loadPromise = loader.load();
    loader.unmount();

    deferred.resolve({
      success: true,
      methods: [methodB],
    });
    const result = await loadPromise;

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("stale_or_unmounted");
    // State remains unchanged
    expect(state.methods).toEqual([methodA]);
  });

  it("displays refresh failure clearly while retaining usable existing data", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      success: false,
      message: "Network timeout while fetching payment methods.",
    });

    const state: GuardedLoaderState = {
      methods: [methodA],
      error: null,
      isRefreshing: false,
    };

    const loader = new GuardedPaymentMethodsLoader(fetcher, (patch) => {
      Object.assign(state, patch);
    });

    const result = await loader.load({ isExplicitRefresh: true });
    expect(result.applied).toBe(true);

    // Retains existing methods without clearing them
    expect(state.methods).toEqual([methodA]);
    // Sets clear error message
    expect(state.error).toBe("Network timeout while fetching payment methods.");
    expect(state.isRefreshing).toBe(false);
  });
});
