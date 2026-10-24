import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockReadLanguage = vi.fn();
const mockCreateTemplate = vi.fn();
const mockSaveTranslation = vi.fn();
const mockGetDb = vi.fn(() => ({}));

vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    readLanguage: (...args: unknown[]) => mockReadLanguage(...args),
    createTemplate: (...args: unknown[]) => mockCreateTemplate(...args),
    saveTranslation: (...args: unknown[]) => mockSaveTranslation(...args),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { saveBotContentTranslation } = await import("../bot-content");

describe("saveBotContentTranslation Server Action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  it("performs zero database access when caller is unauthorized", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized: Admin session required"));

    await expect(
      saveBotContentTranslation({
        templateKey: "bot_welcome",
        languageCode: "en",
        body: "Hello {{store_name}}",
      })
    ).rejects.toThrow("Unauthorized: Admin session required");

    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockReadLanguage).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("rejects non-text inputs (such as File objects) before any database write", async () => {
    // Simulating a malformed payload or file object
    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: 12345 as unknown as string,
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("rejects unapproved template keys with zero database writes", async () => {
    const result = await saveBotContentTranslation({
      templateKey: "unapproved_key",
      languageCode: "en",
      body: "Some message text",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(result.message).toContain("not an approved template key");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("rejects invalid language codes with zero database writes", async () => {
    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "english", // Must be 2 chars
      body: "Hello {{store_name}}",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(result.message).toContain("two lowercase letters");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("rejects invalid placeholder syntax with zero database writes", async () => {
    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name (unclosed brace!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("rejects unknown placeholders with zero database writes", async () => {
    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome {{user_name}} to {{store_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(result.message).toContain("Unknown placeholder");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("rejects {{product_name}} in templates other than inquiry_received with zero database writes", async () => {
    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name}} regarding {{product_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(result.message).toContain("Placeholder \"{{product_name}}\" is not allowed");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("rejects unsupported languages before database access", async () => {
    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "fr",
      body: "Bienvenue sur {{store_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_LANGUAGE");
    expect(result.message).toContain("not supported by the Bot Content editor");
    expect(result.message).toContain("en, ar");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockReadLanguage).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("returns LANGUAGE_NOT_FOUND when supported language is not registered in DB, with zero writes", async () => {
    mockReadLanguage.mockResolvedValueOnce(null);

    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "ar",
      body: "مرحبًا بك في {{store_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("LANGUAGE_NOT_FOUND");
    expect(result.message).toContain('Language "ar" is not registered');
    expect(mockGetDb).toHaveBeenCalled();
    expect(mockReadLanguage).toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("handles getDb() initialization failure safely with zero writes", async () => {
    mockGetDb.mockImplementationOnce(() => {
      throw new Error("DATABASE_URL is not configured.");
    });

    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("DATABASE_UNAVAILABLE");
    expect(result.message).toContain("Database is not configured or unavailable");
    expect(mockReadLanguage).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("handles readLanguage() query rejection safely with zero writes", async () => {
    mockReadLanguage.mockRejectedValueOnce(
      new Error("connection reset by peer to postgresql://secret:pass@host:5432/db")
    );

    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("SAVE_FAILED");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("pass");
    expect(result.message).not.toContain("postgresql://");
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("handles createTemplate() failure safely with zero subsequent translation writes", async () => {
    mockReadLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      isEnabled: true,
    });
    mockCreateTemplate.mockRejectedValueOnce(
      new Error("connection closed during metadata write")
    );

    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("SAVE_FAILED");
    expect(mockCreateTemplate).toHaveBeenCalled();
    expect(mockSaveTranslation).not.toHaveBeenCalled();
  });

  it("creates template row and saves translation when inputs are valid", async () => {
    mockReadLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      isEnabled: true,
    });
    mockCreateTemplate.mockResolvedValueOnce({
      id: "template-id-1",
      key: "bot_welcome",
    });
    mockSaveTranslation.mockResolvedValueOnce({
      id: "trans-id-1",
      templateId: "template-id-1",
      languageId: "lang-en-id",
      body: "Welcome to {{store_name}}!",
    });

    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name}}!",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("saved successfully");
    expect(mockCreateTemplate).toHaveBeenCalledWith(expect.anything(), {
      key: "bot_welcome",
      description: expect.any(String),
    });
    expect(mockSaveTranslation).toHaveBeenCalledWith(expect.anything(), {
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name}}!",
    });
  });

  it("accepts FormData submissions correctly", async () => {
    mockReadLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      isEnabled: true,
    });
    mockCreateTemplate.mockResolvedValueOnce({ id: "tmpl-id", key: "support_welcome" });
    mockSaveTranslation.mockResolvedValueOnce({ id: "trans-id" });

    const formData = new FormData();
    formData.append("templateKey", "support_welcome");
    formData.append("languageCode", "en");
    formData.append("body", "Support welcome message");

    const result = await saveBotContentTranslation(formData);
    expect(result.success).toBe(true);
    expect(mockSaveTranslation).toHaveBeenCalledWith(expect.anything(), {
      templateKey: "support_welcome",
      languageCode: "en",
      body: "Support welcome message",
    });
  });

  it("does not report success when saveTranslation fails, and redacts database errors", async () => {
    mockReadLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      isEnabled: true,
    });
    mockCreateTemplate.mockResolvedValueOnce({ id: "tmpl-id", key: "bot_welcome" });
    mockSaveTranslation.mockRejectedValueOnce(
      new Error("connection terminated unexpectedly to postgresql://secret@host:5432")
    );

    const result = await saveBotContentTranslation({
      templateKey: "bot_welcome",
      languageCode: "en",
      body: "Welcome to {{store_name}}!",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("SAVE_FAILED");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("postgresql://");
    expect(result.message).toContain("server logs");
  });
});
