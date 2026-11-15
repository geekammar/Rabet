import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockGetDb = vi.fn(() => ({}));
vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

const mockCreateCatalogCategory = vi.fn();
const mockCreateCatalogProduct = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    createCatalogCategory: (...args: unknown[]) => mockCreateCatalogCategory(...args),
    createCatalogProduct: (...args: unknown[]) => mockCreateCatalogProduct(...args),
    listLanguages: (...args: unknown[]) => mockListLanguages(...args),
    resolveDefaultLanguage: (...args: unknown[]) => mockResolveDefaultLanguage(...args),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { createCategoryAction, createProductAction } = await import("../catalog");

const EN = { id: "lang-en-id", code: "en", label: "English", isEnabled: true };
const AR = {
  id: "lang-ar-id",
  code: "ar",
  label: "العربية",
  isEnabled: true,
  textDirection: "rtl",
};
const productCategoryId = "11111111-1111-1111-1111-111111111111";

describe("simplified catalog multilingual create actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    mockListLanguages.mockResolvedValue([EN, AR]);
  });

  it("creates a category with Arabic default and English enabled from both tabs", async () => {
    mockResolveDefaultLanguage.mockResolvedValue({
      id: AR.id,
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
    });
    mockCreateCatalogCategory.mockResolvedValue({
      categoryId: "cat-ar-en",
      category: { id: "cat-ar-en", slug: "ar-en", translations: {} },
    });

    const result = await createCategoryAction({
      slug: "ar-en",
      translations: [
        { languageCode: "ar", name: "إلكترونيات", description: "أجهزة" },
        { languageCode: "en", name: "Electronics", description: "Devices" },
      ],
    });

    expect(result.success).toBe(true);
    expect(mockCreateCatalogCategory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        translations: [
          {
            languageId: AR.id,
            name: "إلكترونيات",
            description: "أجهزة",
          },
          {
            languageId: EN.id,
            name: "Electronics",
            description: "Devices",
          },
        ],
      }),
    );
  });

  it("creates a product with English default and Arabic enabled from both tabs", async () => {
    mockResolveDefaultLanguage.mockResolvedValue({
      id: EN.id,
      code: "en",
      label: "English",
      textDirection: "ltr",
    });
    mockCreateCatalogProduct.mockResolvedValue({
      productId: "prod-en-ar",
      product: { id: "prod-en-ar", slug: "en-ar", translations: {} },
    });

    const result = await createProductAction({
      categoryId: productCategoryId,
      slug: "en-ar",
      price: "10.00",
      translations: [
        { languageCode: "en", name: "Phone", description: "A phone", details: "Details" },
        { languageCode: "ar", name: "هاتف", description: "هاتف ذكي", details: "تفاصيل" },
      ],
    });

    expect(result.success).toBe(true);
    expect(mockCreateCatalogProduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        translations: [
          {
            languageId: EN.id,
            name: "Phone",
            description: "A phone",
            details: "Details",
          },
          {
            languageId: AR.id,
            name: "هاتف",
            description: "هاتف ذكي",
            details: "تفاصيل",
          },
        ],
      }),
    );
  });

  it("does not create blank non-default translations", async () => {
    mockResolveDefaultLanguage.mockResolvedValue({
      id: EN.id,
      code: "en",
      label: "English",
      textDirection: "ltr",
    });
    mockCreateCatalogCategory.mockResolvedValue({
      categoryId: "cat-en-only",
      category: { id: "cat-en-only", slug: "en-only", translations: {} },
    });

    const result = await createCategoryAction({
      slug: "en-only",
      translations: [
        { languageCode: "en", name: "Only English", description: "" },
        { languageCode: "ar", name: "", description: "" },
      ],
    });

    expect(result.success).toBe(true);
    expect(
      mockCreateCatalogCategory.mock.calls[0][1].translations,
    ).toEqual([
      { languageId: EN.id, name: "Only English", description: null },
    ]);
  });

  it("returns field errors for both language drafts without writing", async () => {
    mockResolveDefaultLanguage.mockResolvedValue({
      id: EN.id,
      code: "en",
      label: "English",
      textDirection: "ltr",
    });

    const result = await createProductAction({
      categoryId: productCategoryId,
      slug: "invalid-multilingual",
      price: "10.00",
      translations: [
        { languageCode: "en", name: "", description: "English description only" },
        { languageCode: "ar", name: "", description: "وصف عربي فقط" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(result.errors?.["translations.en.name"]).toBeDefined();
    expect(result.errors?.["translations.ar.name"]).toBeDefined();
    expect(mockCreateCatalogProduct).not.toHaveBeenCalled();
  });
});
