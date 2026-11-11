import type { PaymentMethodRecord } from "@/lib/data";

export interface GuardedLoaderState {
  methods: PaymentMethodRecord[];
  error: string | null;
  isRefreshing: boolean;
}

export type PaymentMethodFetchResult = {
  success: boolean;
  methods?: PaymentMethodRecord[];
  message?: string;
};

/**
 * Guarded loader that coordinates all payment-method fetching for the product action editor.
 * Guarantees:
 * 1. Stale-response protection: an older pending request cannot overwrite a newer result.
 * 2. Unmount protection: dropped gracefully if component unmounts.
 * 3. Error transparency: retains usable existing data while setting a clear error message.
 * 4. Preserves unsaved action drafts and selected payment method reference.
 */
export class GuardedPaymentMethodsLoader {
  private generation = 0;
  private isMounted = true;

  constructor(
    private fetcher: () => Promise<PaymentMethodFetchResult>,
    private onStateChange: (state: Partial<GuardedLoaderState>) => void,
  ) {}

  unmount() {
    this.isMounted = false;
  }

  async load(options?: { isExplicitRefresh?: boolean }): Promise<{ applied: boolean; reason?: string }> {
    const gen = ++this.generation;
    if (options?.isExplicitRefresh) {
      this.onStateChange({ isRefreshing: true });
    }
    try {
      const res = await this.fetcher();
      if (!this.isMounted || gen !== this.generation) {
        return { applied: false, reason: "stale_or_unmounted" };
      }
      if (res.success && res.methods) {
        this.onStateChange({ methods: res.methods, error: null });
        return { applied: true };
      } else {
        this.onStateChange({ error: res.message || "Failed to load payment methods." });
        return { applied: true, reason: "server_error" };
      }
    } catch {
      if (this.isMounted && gen === this.generation) {
        this.onStateChange({ error: "Failed to load payment methods." });
      }
      return { applied: false, reason: "exception" };
    } finally {
      if (this.isMounted && gen === this.generation) {
        this.onStateChange({ isRefreshing: false });
      }
    }
  }

  get currentGeneration() {
    return this.generation;
  }
}
