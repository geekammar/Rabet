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

describe("Settings Server Actions — authorization boundary (Requirement 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects initializeStoreSettings when requireAdmin fails, performing zero DB access", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(
      initializeStoreSettings(
        undefined,
        formData({
          displayName: "Store",
          currency: "USD",
          defaultLanguageCode: "en",
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockEnsureLanguage).not.toHaveBeenCalled();
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("rejects updateStoreSettings when requireAdmin fails, performing zero DB access", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(
      updateStoreSettings(undefined, formData({ displayName: "Updated" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRequireSettings).not.toHaveBeenCalled();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("rejects toggleLanguageAction when requireAdmin fails, performing zero DB access", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(toggleLanguageAction("ar", true)).rejects.toThrow("NEXT_REDIRECT");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockSetLanguageEnabled).not.toHaveBeenCalled();
  });
});

describe("initializeStoreSettings Action — Explicit Values & Validation (Requirement 5 & 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  it("rejects when displayName is missing, performing zero DB writes", async () => {
    const res = await initializeStoreSettings(
      undefined,
      formData({
        currency: "USD",
        defaultLanguageCode: "en",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.message).toContain("required");
    expect(mockEnsureLanguage).not.toHaveBeenCalled();
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("rejects when displayName is blank or whitespace-only, performing zero DB writes", async () => {
    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "   ",
        currency: "USD",
        defaultLanguageCode: "en",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.message).toBe("Display name is required");
    expect(mockEnsureLanguage).not.toHaveBeenCalled();
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("rejects when currency is missing, performing zero DB writes", async () => {
    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "My Store",
        defaultLanguageCode: "en",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.message).toContain("required");
    expect(mockEnsureLanguage).not.toHaveBeenCalled();
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("rejects an invalid currency outside the allowlist, performing zero DB writes", async () => {
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
    expect(mockEnsureLanguage).not.toHaveBeenCalled();
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("rejects when defaultLanguageCode is missing, performing zero DB writes", async () => {
    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "My Store",
        currency: "USD",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.message).toContain("required");
    expect(mockEnsureLanguage).not.toHaveBeenCalled();
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("rejects an unsupported default language code, performing zero DB writes", async () => {
    const res = await initializeStoreSettings(
      undefined,
      formData({
        displayName: "My Store",
        currency: "USD",
        defaultLanguageCode: "fr",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.message).toContain("Invalid or unsupported default language");
    expect(mockEnsureLanguage).not.toHaveBeenCalled();
    expect(mockInitializeSettings).not.toHaveBeenCalled();
  });

  it("ensures English language exists and initializes settings with valid values", async () => {
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

  it("safely handles duplicate initialization without crashing or leaking details (Requirement 6)", async () => {
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
        defaultLanguageCode: "en",
      }),
    );

    expect(res.success).toBe(false);
    expect(res.message).not.toContain("super_secret_pw");
    expect(res.message).not.toContain("postgresql://");
    expect(res.message).toContain("server logs");
  });
});

describe("updateStoreSettings Action — Updates, Checkboxes & Missing Fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    mockRequireSettings.mockResolvedValue({
      id: 1,
      displayName: "Existing Store",
      currency: "USD",
      defaultLanguageId: "lang-en-id",
      askForLanguage: true,
      supportCategory: ["General Support"],
    });
  });

  it("persists false when checkbox is unchecked via hidden false input (Requirement 1: true -> false)", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ id: 1 });

    // When an HTML checkbox is unchecked, only the hidden input value="false" is submitted
    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Existing Store",
        askForLanguage: "false",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ askForLanguage: false }),
    );
  });

  it("persists true when checkbox is checked via hidden false + checkbox true (Requirement 2: false -> true)", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ id: 1 });

    // When checked, the browser submits both the hidden input and the checkbox
    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Existing Store",
        askForLanguage: ["false", "true"],
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ askForLanguage: true }),
    );
  });

  it("preserves askForLanguage as undefined during a partial update where it is omitted", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ id: 1 });

    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Only New Name",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: "Only New Name",
        askForLanguage: undefined,
      }),
    );
  });

  it("rejects blank or whitespace-only displayName without modifying database (Requirement 4)", async () => {
    const resEmpty = await updateStoreSettings(
      undefined,
      formData({
        displayName: "",
      }),
    );

    expect(resEmpty.success).toBe(false);
    expect(resEmpty.code).toBe("INVALID_INPUT");
    expect(resEmpty.message).toBe("Display name is required");
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    const resWhitespace = await updateStoreSettings(
      undefined,
      formData({
        displayName: "    ",
      }),
    );

    expect(resWhitespace.success).toBe(false);
    expect(resWhitespace.code).toBe("INVALID_INPUT");
    expect(resWhitespace.message).toBe("Display name is required");
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("allows omitting displayName during a partial update without wiping it (Requirement 3)", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ id: 1 });

    const res = await updateStoreSettings(
      undefined,
      formData({
        supportReplyTime: "within 1 hour",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: undefined,
        supportReplyTime: "within 1 hour",
      }),
    );
  });

  it("leaves support categories unchanged when omitted during a partial update (Requirement 3)", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ id: 1 });

    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Updated Store",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: "Updated Store",
        supportCategory: undefined,
      }),
    );
  });

  it("explicitly clears support categories when empty list is submitted (Requirement 3)", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ id: 1 });

    const res = await updateStoreSettings(
      undefined,
      formData({
        displayName: "Updated Store",
        supportCategoriesJson: "[]",
      }),
    );

    expect(res.success).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: "Updated Store",
        supportCategory: [],
      }),
    );
  });

  it("rejects currency change without confirmation when catalog prices exist (Requirement 8)", async () => {
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
