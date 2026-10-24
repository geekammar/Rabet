import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockIsConfigured = vi.fn();
const mockReadSettings = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();
const mockHasCatalogPrices = vi.fn();
const mockGetDb = vi.fn(() => ({}));

vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    isConfigured: (...args: unknown[]) => mockIsConfigured(...args),
    readSettings: (...args: unknown[]) => mockReadSettings(...args),
    listLanguages: (...args: unknown[]) => mockListLanguages(...args),
    resolveDefaultLanguage: (...args: unknown[]) => mockResolveDefaultLanguage(...args),
    hasCatalogPrices: (...args: unknown[]) => mockHasCatalogPrices(...args),
  };
});

const SettingsPage = (await import("@/app/(dashboard)/settings/page")).default;

describe("Settings Page — Database Availability States", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalEnv;
  });

  it("renders State A (DatabaseSetupRequired) when DATABASE_URL is not configured", async () => {
    delete process.env.DATABASE_URL;

    const element = await SettingsPage();
    // Element is the React component for DatabaseSetupRequired
    expect(element.type.name).toBe("DatabaseSetupRequired");
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("renders State B (DatabaseUnavailable) when database connection fails", async () => {
    process.env.DATABASE_URL = "postgresql://rabet:secret@localhost:5432/rabet";
    mockIsConfigured.mockRejectedValueOnce(
      new Error("connection timeout to postgresql://rabet:secret@localhost:5432/rabet"),
    );

    const element = await SettingsPage();
    expect(element.type.name).toBe("DatabaseUnavailable");
    // Verify no secret or URL leaks in props
    expect(element.props.message).not.toContain("secret");
    expect(element.props.message).not.toContain("postgresql://");
    expect(element.props.message).toContain("server logs");
  });

  it("renders State C (OnboardingForm) when DB is connected but settings are not initialized", async () => {
    process.env.DATABASE_URL = "postgresql://rabet:secret@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(false);

    const element = await SettingsPage();
    expect(element.type.name).toBe("OnboardingForm");
  });

  it("renders State D (SettingsEditForm) when settings are configured", async () => {
    process.env.DATABASE_URL = "postgresql://rabet:secret@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(true);
    mockReadSettings.mockResolvedValueOnce({
      id: 1,
      displayName: "Rabet Store",
      currency: "USD",
      defaultLanguageId: "lang-en-id",
      askForLanguage: true,
      supportCategory: ["General"],
      supportReplyTime: "1 hour",
    });
    mockListLanguages.mockResolvedValueOnce([
      { id: "lang-en-id", code: "en", label: "English", textDirection: "ltr", isEnabled: true },
    ]);
    mockResolveDefaultLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      textDirection: "ltr",
    });
    mockHasCatalogPrices.mockResolvedValueOnce(false);

    const element = await SettingsPage();
    expect(element.type.name).toBe("SettingsEditForm");
    expect(element.props.settings.displayName).toBe("Rabet Store");
    expect(element.props.settings.currency).toBe("USD");
    expect(element.props.hasCatalogPrices).toBe(false);
  });

  it("asserts requireAdmin before performing any checks", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(SettingsPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockGetDb).not.toHaveBeenCalled();
  });
});
