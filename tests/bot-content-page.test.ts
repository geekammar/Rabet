import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  connection: vi.fn().mockResolvedValue(undefined),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockIsConfigured = vi.fn();
const mockReadSettings = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();
const mockListTemplates = vi.fn();
const mockReadTranslations = vi.fn();
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
    listTemplates: (...args: unknown[]) => mockListTemplates(...args),
    readTranslations: (...args: unknown[]) => mockReadTranslations(...args),
  };
});

const BotContentPage = (await import("@/app/(dashboard)/bot-content/page")).default;

describe("Bot Content Page — Database Availability States", () => {
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

    const element = await BotContentPage();
    expect(element.type.name).toBe("DatabaseSetupRequired");
    expect(element.props.title).toBe("Bot Content");
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("renders State B (DatabaseUnavailable) when database connection fails", async () => {
    process.env.DATABASE_URL = "postgresql://rabet:secret@localhost:5432/rabet";
    mockIsConfigured.mockRejectedValueOnce(
      new Error("connection timeout to postgresql://rabet:secret@localhost:5432/rabet"),
    );

    const element = await BotContentPage();
    expect(element.type.name).toBe("DatabaseUnavailable");
    expect(element.props.title).toBe("Bot Content");
    expect(element.props.message).not.toContain("secret");
    expect(element.props.message).not.toContain("postgresql://");
    expect(element.props.message).toContain("server logs");
  });

  it("renders State C (BotContentStoreSetupRequired) when DB is connected but store is not initialized", async () => {
    process.env.DATABASE_URL = "postgresql://rabet:secret@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(false);

    const element = await BotContentPage();
    expect(element.type.name).toBe("BotContentStoreSetupRequired");
  });

  it("renders State D (BotContentEditor) when store is configured, without any database writes", async () => {
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
      { id: "lang-ar-id", code: "ar", label: "العربية", textDirection: "rtl", isEnabled: false },
    ]);
    mockResolveDefaultLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      textDirection: "ltr",
    });
    mockListTemplates.mockResolvedValueOnce([
      { id: "tmpl-welcome", key: "bot_welcome", description: "Main Welcome" },
    ]);
    mockReadTranslations.mockResolvedValueOnce([
      {
        id: "trans-1",
        languageId: "lang-en-id",
        languageCode: "en",
        textDirection: "ltr",
        body: "Hello from {{store_name}}",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const element = await BotContentPage();
    expect(element.type.name).toBe("BotContentEditor");
    expect(element.props.templatesData.length).toBe(7);

    // Verify bot_welcome received its translation
    const welcomeData = element.props.templatesData.find((t: { key: string }) => t.key === "bot_welcome");
    expect(welcomeData.translations.en.body).toBe("Hello from {{store_name}}");

    // Verify uninitialized templates (e.g. empty_menu) have empty translations
    const emptyMenuData = element.props.templatesData.find((t: { key: string }) => t.key === "empty_menu");
    expect(emptyMenuData.translations).toEqual({});
  });
});
