import { beforeEach, describe, expect, it, vi } from "vitest";

import { RabetDataError } from "@/lib/data/errors";

// Mock next/cache
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock auth session
const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

// Mock DB client and data access layer
const mockEnsureLanguage = vi.fn();
const mockInitializeSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockRequireSettings = vi.fn();
const mockSetLanguageEnabled = vi.fn();
const mockHasCatalogPrices = vi.fn();
const mockGetDb = vi.fn(() => ({}));

vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    ensureLanguage: (...args: unknown[]) => mockEnsureLanguage(...args),
    initializeSettings: (...args: unknown[]) => mockInitializeSettings(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    requireSettings: (...args: unknown[]) => mockRequireSettings(...args),
    setLanguageEnabled: (...args: unknown[]) => mockSetLanguageEnabled(...args),
    hasCatalogPrices: (...args: unknown[]) => mockHasCatalogPrices(...args),
  };
});

const {
  initializeStoreSettings,
  updateStoreSettings,
  toggleLanguageAction,
} = await import("@/app/actions/settings");
const { revalidatePath } = await import("next/cache");

function formData(entries: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        fd.append(key, item);
      }
    } else {
      fd.append(key, value);
    }
  }
  return fd;
}

describe("Settings Server Actions — authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects initializeStoreSettings when requireAdmin fails", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(
      initializeStoreSettings(undefined, formData({ displayName: "Store" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("rejects updateStoreSettings when requireAdmin fails", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(
      updateStoreSettings(undefined, formData({ displayName: "Updated" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("rejects toggleLanguageAction when requireAdmin fails", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(toggleLanguageAction("ar", true)).rejects.toThrow("NEXT_REDIRECT");
    expect(mockSetLanguageEnabled).not.toHaveBeenCalled();
  });
});

describe("initializeStoreSettings Action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  it("rejects an invalid currency outside the allowlist", async () => {
    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "My Store",
        currency: "EUR",
        defaultLanguageCode: "en",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.message).toContain("Allowed options: SAR, USD, AED, EGP");
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("ensures English language exists and initializes settings with USD", async () => {
    mockEnsureLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      isEnabled: true,
    });
    mockInitializeSettings.mockResolvedValueOnce({
      id: 1,
      displayName: "My Store",
      currency: "USD",
      defaultLanguageId: "lang-en-id",
    });

    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "My Store",
        currency: "USD",
        defaultLanguageCode: "en",
        askForLanguage: "true",
        supportCategory: ["General Question", "Order Support"],
        supportReplyTime: "Within 24 hours",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockEnsureLanguage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "en", label: "English", isEnabled: true }),
    );
    expect(mockInitializeSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: "My Store",
        currency: "USD",
        defaultLanguageCode: "en",
        askForLanguage: true,
        supportCategory: ["General Question", "Order Support"],
        supportReplyTime: "Within 24 hours",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("ensures Arabic is created when Arabic is selected as initial default language", async () => {
    mockEnsureLanguage.mockResolvedValue({
      id: "lang-ar-id",
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    });
    mockInitializeSettings.mockResolvedValueOnce({
      id: 1,
      displayName: "متجر رابط",
      currency: "SAR",
      defaultLanguageId: "lang-ar-id",
    });

    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "متجر رابط",
        currency: "SAR",
        defaultLanguageCode: "ar",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockEnsureLanguage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "en" }),
    );
    expect(mockEnsureLanguage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "ar", textDirection: "rtl" }),
    );
  });

  it("safely handles duplicate initialization without crashing or leaking details", async () => {
    mockInitializeSettings.mockRejectedValueOnce(
      new RabetDataError(
        "SETTINGS_ALREADY_INITIALIZED",
        "Bot settings are already initialized.",
      ),
    );

    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "Repeat Init",
        currency: "USD",
        defaultLanguageCode: "en",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("SETTINGS_ALREADY_INITIALIZED");
    expect(res.message).toContain("already initialized");
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("does not leak database credentials when an unexpected error occurs", async () => {
    mockInitializeSettings.mockRejectedValueOnce(
      new Error("connection error at postgresql://user:super_secret_pw@host:5432/db"),
    );

    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "Leak Test",
        currency: "USD",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.message).not.toContain("super_secret_pw");
    expect(res.message).not.toContain("postgresql://");
    expect(res.message).toContain("server logs");
  });
});

describe("updateStoreSettings Action — Currency Safeguards & Updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    mockRequireSettings.mockResolvedValue({
      id: 1,
      displayName: "Existing Store",
      currency: "USD",
      defaultLanguageId: "lang-en-id",
    });
  });

  it("rejects currency change without confirmation when catalog prices exist", async () => {
    mockHasCatalogPrices.mockResolvedValueOnce(true);

    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Existing Store",
        currency: "SAR",
        confirmCurrencyChange: "false",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("CONFIRMATION_REQUIRED");
    expect(res.message).toContain("does not convert existing product prices");
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("allows currency change when confirmed even if catalog prices exist", async () => {
    mockHasCatalogPrices.mockResolvedValueOnce(true);
    mockUpdateSettings.mockResolvedValueOnce({
      id: 1,
      displayName: "Existing Store",
      currency: "SAR",
    });

    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Existing Store",
        currency: "SAR",
        confirmCurrencyChange: "true",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currency: "SAR" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("allows currency change without confirmation prompt if no catalog prices exist", async () => {
    mockHasCatalogPrices.mockResolvedValueOnce(false);
    mockUpdateSettings.mockResolvedValueOnce({
      id: 1,
      displayName: "Existing Store",
      currency: "AED",
    });

    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Existing Store",
        currency: "AED",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalled();
  });

  it("updates support categories and reply time correctly", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ id: 1 });

    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Updated Store",
        supportCategory: ["Sales Inquiry", "Technical Support"],
        supportReplyTime: "Under 2 hours",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        supportCategory: ["Sales Inquiry", "Technical Support"],
        supportReplyTime: "Under 2 hours",
      }),
    );
  });
});

describe("toggleLanguageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  it("ensures Arabic is registered and sets it enabled when enabling Arabic", async () => {
    mockEnsureLanguage.mockResolvedValueOnce({
      id: "ar-id",
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    });
    mockSetLanguageEnabled.mockResolvedValueOnce({ id: "ar-id", isEnabled: true });

    const res = await toggleLanguageAction("ar", true);

    expect(res.success).toBe(true);
    expect(mockEnsureLanguage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "ar", textDirection: "rtl", isEnabled: true }),
    );
    expect(mockSetLanguageEnabled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "ar", isEnabled: true }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("safely handles DEFAULT_LANGUAGE_REQUIRED when attempting to disable active default", async () => {
    mockSetLanguageEnabled.mockRejectedValueOnce(
      new RabetDataError(
        "DEFAULT_LANGUAGE_REQUIRED",
        'The language "en" is the configured default and cannot be disabled.',
      ),
    );

    const res = await toggleLanguageAction("en", false);

    expect(res.success).toBe(false);
    expect(res.code).toBe("DEFAULT_LANGUAGE_REQUIRED");
    expect(res.message).toContain("cannot be disabled");
  });
});
