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
const mockUpdateCatalogCategory = vi.fn();
const mockSaveCatalogCategoryTranslation = vi.fn();
const mockCreateCatalogProduct = vi.fn();
const mockUpdateCatalogProduct = vi.fn();
const mockSaveCatalogProductTranslation = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    createCatalogCategory: (...args: unknown[]) => mockCreateCatalogCategory(...args),
    updateCatalogCategory: (...args: unknown[]) => mockUpdateCatalogCategory(...args),
    saveCatalogCategoryTranslation: (...args: unknown[]) =>
      mockSaveCatalogCategoryTranslation(...args),
    createCatalogProduct: (...args: unknown[]) => mockCreateCatalogProduct(...args),
    updateCatalogProduct: (...args: unknown[]) => mockUpdateCatalogProduct(...args),
    saveCatalogProductTranslation: (...args: unknown[]) =>
      mockSaveCatalogProductTranslation(...args),
    listLanguages: (...args: unknown[]) => mockListLanguages(...args),
    resolveDefaultLanguage: (...args: unknown[]) => mockResolveDefaultLanguage(...args),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const {
  createCategoryAction,
  updateCategoryAction,
  createProductAction,
  updateProductAction,
} = await import("../catalog");

describe("Catalog Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    mockListLanguages.mockResolvedValue([
      { id: "lang-en-id", code: "en", label: "English", isEnabled: true },
      { id: "lang-ar-id", code: "ar", label: "العربية", isEnabled: false },
    ]);
    mockResolveDefaultLanguage.mockResolvedValue({
      id: "lang-en-id",
      code: "en",
      label: "English",
      isEnabled: true,
    });
  });

  describe("createCategoryAction", () => {
    it("calls requireAdmin first and aborts with zero DB access when unauthorized", async () => {
      mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized admin access"));

      await expect(
        createCategoryAction({
          slug: "electronics",
          name: "Electronics",
        }),
      ).rejects.toThrow("Unauthorized admin access");

      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockCreateCatalogCategory).not.toHaveBeenCalled();
    });

    it("rejects invalid slugs before any database write", async () => {
      const res = await createCategoryAction({
        slug: "invalid slug with spaces!",
        name: "Electronics",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.slug).toBeDefined();
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockCreateCatalogCategory).not.toHaveBeenCalled();
    });

    it("rejects empty names before any database write", async () => {
      const res = await createCategoryAction({
        slug: "electronics",
        name: "   ",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.name).toBeDefined();
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockCreateCatalogCategory).not.toHaveBeenCalled();
    });

    it("creates a category with valid input", async () => {
      mockCreateCatalogCategory.mockResolvedValueOnce({ categoryId: "cat-123" });

      const res = await createCategoryAction({
        slug: "electronics",
        name: "Electronics",
        description: "Gadgets and devices",
      });

      expect(res.success).toBe(true);
      expect(res.categoryId).toBe("cat-123");
      expect(mockCreateCatalogCategory).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          parentId: null,
          slug: "electronics",
          translations: [
            {
              languageId: "lang-en-id",
              name: "Electronics",
              description: "Gadgets and devices",
            },
          ],
        }),
      );
    });
  });

  describe("createProductAction", () => {
    const validCatId = "11111111-1111-1111-1111-111111111111";

    it("calls requireAdmin first and aborts with zero DB access when unauthorized", async () => {
      mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized admin access"));

      await expect(
        createProductAction({
          categoryId: validCatId,
          slug: "phone",
          price: "10.00",
          name: "Phone",
        }),
      ).rejects.toThrow("Unauthorized admin access");

      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockCreateCatalogProduct).not.toHaveBeenCalled();
    });

    it("rejects negative price without any database write", async () => {
      const res = await createProductAction({
        categoryId: validCatId,
        slug: "phone",
        price: "-15.00",
        name: "Phone",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.price).toMatch(/cannot be negative/i);
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockCreateCatalogProduct).not.toHaveBeenCalled();
    });

    it("rejects exponential notation price without any database write", async () => {
      const res = await createProductAction({
        categoryId: validCatId,
        slug: "phone",
        price: "1e4",
        name: "Phone",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.price).toMatch(/scientific or exponent/i);
      expect(mockGetDb).not.toHaveBeenCalled();
    });

    it("rejects excessive decimal places (> 2) without any database write", async () => {
      const res = await createProductAction({
        categoryId: validCatId,
        slug: "phone",
        price: "19.999",
        name: "Phone",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.price).toMatch(/more than 2 decimal places/i);
      expect(mockGetDb).not.toHaveBeenCalled();
    });

    it("creates product with normalized price string", async () => {
      mockCreateCatalogProduct.mockResolvedValueOnce({ productId: "prod-123" });

      const res = await createProductAction({
        categoryId: validCatId,
        slug: "smart-phone",
        price: "99.9",
        name: "Smart Phone",
        description: "A great phone",
        details: "Specs: 128GB",
      });

      expect(res.success).toBe(true);
      expect(res.productId).toBe("prod-123");
      expect(mockCreateCatalogProduct).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          categoryId: validCatId,
          slug: "smart-phone",
          price: "99.90",
          translations: [
            {
              languageId: "lang-en-id",
              name: "Smart Phone",
              description: "A great phone",
              details: "Specs: 128GB",
            },
          ],
        }),
      );
    });
  });

  describe("updateCategoryAction", () => {
    const validCatId = "22222222-2222-2222-2222-222222222222";

    it("updates category and saves translation for the specified language", async () => {
      const res = await updateCategoryAction({
        categoryId: validCatId,
        slug: "electronics-updated",
        isActive: true,
        languageCode: "ar",
        name: "إلكترونيات",
        description: "أجهزة",
      });

      expect(res.success).toBe(true);
      expect(mockUpdateCatalogCategory).toHaveBeenCalledWith(
        expect.anything(),
        validCatId,
        {
          slug: "electronics-updated",
          isActive: true,
        },
      );
      expect(mockSaveCatalogCategoryTranslation).toHaveBeenCalledWith(
        expect.anything(),
        {
          categoryId: validCatId,
          languageId: "lang-ar-id",
          name: "إلكترونيات",
          description: "أجهزة",
        },
      );
    });
  });

  describe("updateProductAction", () => {
    const validProdId = "33333333-3333-3333-3333-333333333333";

    it("updates product base and translation", async () => {
      const res = await updateProductAction({
        productId: validProdId,
        slug: "phone-pro",
        price: "199.50",
        isActive: false,
        languageCode: "en",
        name: "Phone Pro",
        description: "Short desc",
        details: "Long details",
      });

      expect(res.success).toBe(true);
      expect(mockUpdateCatalogProduct).toHaveBeenCalledWith(
        expect.anything(),
        validProdId,
        {
          slug: "phone-pro",
          price: "199.50",
          isActive: false,
        },
      );
      expect(mockSaveCatalogProductTranslation).toHaveBeenCalledWith(
        expect.anything(),
        {
          productId: validProdId,
          languageId: "lang-en-id",
          name: "Phone Pro",
          description: "Short desc",
          details: "Long details",
        },
      );
    });
  });
});
