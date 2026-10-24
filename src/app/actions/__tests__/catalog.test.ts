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
const mockEditCatalogCategory = vi.fn();
const mockCreateCatalogProduct = vi.fn();
const mockEditCatalogProduct = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    createCatalogCategory: (...args: unknown[]) => mockCreateCatalogCategory(...args),
    editCatalogCategory: (...args: unknown[]) => mockEditCatalogCategory(...args),
    createCatalogProduct: (...args: unknown[]) => mockCreateCatalogProduct(...args),
    editCatalogProduct: (...args: unknown[]) => mockEditCatalogProduct(...args),
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

    it("rejects supplying Arabic when Arabic is not a registered language", async () => {
      mockListLanguages.mockResolvedValueOnce([
        { id: "lang-en-id", code: "en", label: "English", isEnabled: true },
      ]);

      const res = await createCategoryAction({
        slug: "electronics",
        name: "Electronics",
        arabicName: "إلكترونيات",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("NOT_FOUND");
      expect(res.errors?.arabicName).toMatch(/not registered/i);
      expect(mockCreateCatalogCategory).not.toHaveBeenCalled();
    });

    it("creates a category with valid input and returns authoritative record", async () => {
      const mockSavedCategory = {
        id: "cat-123",
        parentId: null,
        slug: "electronics",
        sortOrder: 0,
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {
          en: {
            id: "t-1",
            languageId: "lang-en-id",
            name: "Electronics",
            description: "Gadgets and devices",
          },
        },
      };
      mockCreateCatalogCategory.mockResolvedValueOnce({
        categoryId: "cat-123",
        category: mockSavedCategory,
      });

      const res = await createCategoryAction({
        slug: "electronics",
        name: "Electronics",
        description: "Gadgets and devices",
      });

      expect(res.success).toBe(true);
      expect(res.categoryId).toBe("cat-123");
      expect(res.category).toEqual(mockSavedCategory);
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

    it("creates a category with Arabic default language and no duplicate translation", async () => {
      mockResolveDefaultLanguage.mockResolvedValueOnce({
        id: "lang-ar-id",
        code: "ar",
        label: "العربية",
        isEnabled: true,
      });

      mockCreateCatalogCategory.mockResolvedValueOnce({
        categoryId: "cat-ar-1",
        category: {
          id: "cat-ar-1",
          slug: "ar-category",
          translations: {
            ar: { id: "t-ar-1", languageId: "lang-ar-id", name: "إلكترونيات" },
          },
        },
      });

      const res = await createCategoryAction({
        slug: "ar-category",
        name: "إلكترونيات",
        description: "وصف الفئة",
      });

      expect(res.success).toBe(true);
      expect(mockCreateCatalogCategory).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          slug: "ar-category",
          translations: [
            {
              languageId: "lang-ar-id",
              name: "إلكترونيات",
              description: "وصف الفئة",
            },
          ],
        }),
      );
    });

    it("rejects redundant arabicName when store default is already Arabic", async () => {
      mockResolveDefaultLanguage.mockResolvedValueOnce({
        id: "lang-ar-id",
        code: "ar",
        label: "العربية",
        isEnabled: true,
      });

      const res = await createCategoryAction({
        slug: "ar-category",
        name: "إلكترونيات",
        arabicName: "إلكترونيات مكررة",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.arabicName).toMatch(/already Arabic/i);
      expect(mockCreateCatalogCategory).not.toHaveBeenCalled();
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

    it("rejects numeric JavaScript numbers to preserve exact decimal intent", async () => {
      const res = await createProductAction({
        categoryId: validCatId,
        slug: "phone",
        price: 19.99,
        name: "Phone",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.price).toMatch(/must be a string/i);
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

    it("creates product with normalized price string and returns authoritative record", async () => {
      const mockSavedProduct = {
        id: "prod-123",
        categoryId: validCatId,
        slug: "smart-phone",
        price: "99.90",
        isActive: false,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {
          en: {
            id: "pt-1",
            languageId: "lang-en-id",
            name: "Smart Phone",
            description: "A great phone",
            details: "Specs: 128GB",
          },
        },
      };
      mockCreateCatalogProduct.mockResolvedValueOnce({
        productId: "prod-123",
        product: mockSavedProduct,
      });

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
      expect(res.product).toEqual(mockSavedProduct);
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

    it("creates product with Arabic default language and no duplicate translation", async () => {
      mockResolveDefaultLanguage.mockResolvedValueOnce({
        id: "lang-ar-id",
        code: "ar",
        label: "العربية",
        isEnabled: true,
      });

      mockCreateCatalogProduct.mockResolvedValueOnce({
        productId: "prod-ar-1",
        product: {
          id: "prod-ar-1",
          categoryId: validCatId,
          slug: "ar-prod",
          price: "50.00",
          translations: {
            ar: { id: "pt-ar-1", languageId: "lang-ar-id", name: "منتج عربي" },
          },
        },
      });

      const res = await createProductAction({
        categoryId: validCatId,
        slug: "ar-prod",
        price: "50.00",
        name: "منتج عربي",
        description: "وصف المنتج",
        details: "تفاصيل المنتج",
      });

      expect(res.success).toBe(true);
      expect(mockCreateCatalogProduct).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          categoryId: validCatId,
          slug: "ar-prod",
          price: "50.00",
          translations: [
            {
              languageId: "lang-ar-id",
              name: "منتج عربي",
              description: "وصف المنتج",
              details: "تفاصيل المنتج",
            },
          ],
        }),
      );
    });

    it("rejects redundant arabicName for product when store default is already Arabic", async () => {
      mockResolveDefaultLanguage.mockResolvedValueOnce({
        id: "lang-ar-id",
        code: "ar",
        label: "العربية",
        isEnabled: true,
      });

      const res = await createProductAction({
        categoryId: validCatId,
        slug: "ar-prod",
        price: "50.00",
        name: "منتج عربي",
        arabicName: "اسم مكرر",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.arabicName).toMatch(/already Arabic/i);
      expect(mockCreateCatalogProduct).not.toHaveBeenCalled();
    });
  });

  describe("updateCategoryAction", () => {
    const validCatId = "22222222-2222-2222-2222-222222222222";

    it("rejects blank/whitespace name when translation is submitted", async () => {
      const res = await updateCategoryAction({
        categoryId: validCatId,
        slug: "electronics",
        isActive: true,
        languageCode: "en",
        name: "   ",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.name).toMatch(/required/i);
      expect(mockEditCatalogCategory).not.toHaveBeenCalled();
    });

    it("rejects malformed boolean isActive values strictly", async () => {
      const res = await updateCategoryAction({
        categoryId: validCatId,
        slug: "electronics",
        isActive: "maybe",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.isActive).toMatch(/valid boolean/i);
      expect(mockEditCatalogCategory).not.toHaveBeenCalled();
    });

    it("rejects unsupported language code before writing", async () => {
      const res = await updateCategoryAction({
        categoryId: validCatId,
        slug: "electronics",
        isActive: true,
        languageCode: "fr",
        name: "Electronique",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.languageCode).toMatch(/not supported/i);
      expect(mockEditCatalogCategory).not.toHaveBeenCalled();
    });

    it("updates category and translation atomically in a single batch call", async () => {
      const mockSavedCategory = {
        id: validCatId,
        parentId: null,
        slug: "electronics-updated",
        sortOrder: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {
          ar: {
            id: "t-ar",
            languageId: "lang-ar-id",
            name: "إلكترونيات",
            description: "أجهزة",
          },
        },
      };
      mockEditCatalogCategory.mockResolvedValueOnce({ category: mockSavedCategory });

      const res = await updateCategoryAction({
        categoryId: validCatId,
        slug: "electronics-updated",
        isActive: true,
        languageCode: "ar",
        name: "إلكترونيات",
        description: "أجهزة",
      });

      expect(res.success).toBe(true);
      expect(res.category).toEqual(mockSavedCategory);
      expect(mockEditCatalogCategory).toHaveBeenCalledWith(
        expect.anything(),
        {
          categoryId: validCatId,
          slug: "electronics-updated",
          isActive: true,
          translation: {
            languageId: "lang-ar-id",
            name: "إلكترونيات",
            description: "أجهزة",
          },
        },
      );
    });

    it("supports base-only updates when translation fields are omitted", async () => {
      const mockSavedCategory = {
        id: validCatId,
        parentId: null,
        slug: "electronics-newslug",
        sortOrder: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {},
      };
      mockEditCatalogCategory.mockResolvedValueOnce({ category: mockSavedCategory });

      const res = await updateCategoryAction({
        categoryId: validCatId,
        slug: "electronics-newslug",
        isActive: true,
      });

      expect(res.success).toBe(true);
      expect(mockEditCatalogCategory).toHaveBeenCalledWith(
        expect.anything(),
        {
          categoryId: validCatId,
          slug: "electronics-newslug",
          isActive: true,
          translation: null,
        },
      );
    });
  });

  describe("updateProductAction", () => {
    const validProdId = "33333333-3333-3333-3333-333333333333";

    it("rejects blank/whitespace name when translation is submitted", async () => {
      const res = await updateProductAction({
        productId: validProdId,
        slug: "phone",
        price: "100.00",
        isActive: true,
        languageCode: "en",
        name: "   ",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.errors?.name).toMatch(/required/i);
      expect(mockEditCatalogProduct).not.toHaveBeenCalled();
    });

    it("updates product base and translation atomically", async () => {
      const mockSavedProduct = {
        id: validProdId,
        categoryId: "cat-1",
        slug: "phone-pro",
        price: "199.50",
        isActive: false,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {
          en: {
            id: "pt-en",
            languageId: "lang-en-id",
            name: "Phone Pro",
            description: "Short desc",
            details: "Long details",
          },
        },
      };
      mockEditCatalogProduct.mockResolvedValueOnce({ product: mockSavedProduct });

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
      expect(res.product).toEqual(mockSavedProduct);
      expect(mockEditCatalogProduct).toHaveBeenCalledWith(
        expect.anything(),
        {
          productId: validProdId,
          slug: "phone-pro",
          price: "199.50",
          isActive: false,
          translation: {
            languageId: "lang-en-id",
            name: "Phone Pro",
            description: "Short desc",
            details: "Long details",
          },
        },
      );
    });
  });
});
