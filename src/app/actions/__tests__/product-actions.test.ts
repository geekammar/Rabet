import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockGetDb = vi.fn(() => ({}));
vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

const mockCreateProductAction = vi.fn();
const mockEditProductAction = vi.fn();
const mockListProductActions = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    createProductAction: (...args: unknown[]) => mockCreateProductAction(...args),
    editProductAction: (...args: unknown[]) => mockEditProductAction(...args),
    listProductActions: (...args: unknown[]) => mockListProductActions(...args),
    listLanguages: (...args: unknown[]) => mockListLanguages(...args),
    resolveDefaultLanguage: (...args: unknown[]) => mockResolveDefaultLanguage(...args),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const {
  createProductActionAction,
  updateProductActionAction,
  loadProductActionsAction,
} = await import("../product-actions");

describe("Product Action Server Actions", () => {
  const validProductId = "a0000000-0000-0000-0000-000000000001";
  const validActionId = "b0000000-0000-0000-0000-000000000001";

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

  describe("Authorization", () => {
    it("refuses unauthorized execution before reading database", async () => {
      mockRequireAdmin.mockRejectedValue(new Error("Unauthorized: Admin session required"));

      await expect(
        createProductActionAction({
          productId: validProductId,
          actionType: "OPEN_SUBMENU",
          label: "Menu",
        }),
      ).rejects.toThrow(/Unauthorized/);

      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("refuses unauthorized updates before touching database", async () => {
      mockRequireAdmin.mockRejectedValue(new Error("Unauthorized: Admin session required"));

      await expect(
        updateProductActionAction({
          actionId: validActionId,
          productId: validProductId,
          actionType: "OPEN_SUBMENU",
          isActive: true,
        }),
      ).rejects.toThrow(/Unauthorized/);

      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });
  });

  describe("createProductActionAction", () => {
    it("rejects invalid or missing product IDs with 0 DB writes", async () => {
      const res = await createProductActionAction({
        productId: "invalid-id",
        actionType: "OPEN_SUBMENU",
        label: "Menu",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("rejects deferred action types in this slice", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_URL",
        label: "Link",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.actionType).toMatch(/deferred/i);
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("rejects blank labels", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "   ",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.label).toMatch(/required/i);
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("rejects labels exceeding 64 characters", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "A".repeat(65),
      });

      expect(res.success).toBe(false);
      expect(res.errors?.label).toMatch(/64 characters/i);
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("rejects submenu message on SHOW_DETAILS action type", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "SHOW_DETAILS",
        label: "Details",
        menuText: "This should not be allowed",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.parameters).toMatch(/only permitted on OPEN_SUBMENU/i);
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("rejects URL and navigation parameters in this slice", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "Menu",
        url: "https://example.com",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.parameters).toMatch(/URL configuration is not supported/i);
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("successfully creates root action and returns authoritative record", async () => {
      mockCreateProductAction.mockResolvedValue({
        actionId: validActionId,
        action: {
          id: validActionId,
          productId: validProductId,
          parentActionId: null,
          actionType: "OPEN_SUBMENU",
          sortOrder: 0,
          isActive: true,
          translations: {
            en: { id: "trans-1", label: "Choose Options", menuText: null },
          },
        },
      });

      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        label: "Choose Options",
      });

      expect(res.success).toBe(true);
      expect(res.actionId).toBe(validActionId);
      expect(mockCreateProductAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          productId: validProductId,
          parentActionId: null,
          actionType: "OPEN_SUBMENU",
          isActive: true,
          translations: [
            expect.objectContaining({
              languageId: "lang-en-id",
              languageCode: "en",
              label: "Choose Options",
            }),
          ],
        }),
      );
    });

    it("rejects redundant Arabic fields when store default is Arabic", async () => {
      mockResolveDefaultLanguage.mockResolvedValue({
        id: "lang-ar-id",
        code: "ar",
        label: "العربية",
        isEnabled: true,
      });

      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "القائمة الرئيسية",
        arabicLabel: "تكرار",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.arabicLabel).toMatch(/already Arabic/i);
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });
  });

  describe("updateProductActionAction", () => {
    it("rejects missing action ID or product ID", async () => {
      const res = await updateProductActionAction({
        actionId: "not-a-uuid",
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
      });

      expect(res.success).toBe(false);
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });

    it("rejects unregistered language update", async () => {
      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        languageCode: "fr",
        label: "Options",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.languageCode).toMatch(/not registered/i);
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });

    it("successfully edits an action with its translation", async () => {
      mockEditProductAction.mockResolvedValue({
        action: {
          id: validActionId,
          productId: validProductId,
          actionType: "START_INQUIRY",
          isActive: true,
          translations: {
            en: { id: "trans-1", label: "Ask a Question", menuText: null },
          },
        },
      });

      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "START_INQUIRY",
        isActive: true,
        languageCode: "en",
        label: "Ask a Question",
      });

      expect(res.success).toBe(true);
      expect(mockEditProductAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actionId: validActionId,
          productId: validProductId,
          actionType: "START_INQUIRY",
          isActive: true,
          translation: expect.objectContaining({
            languageId: "lang-en-id",
            languageCode: "en",
            label: "Ask a Question",
          }),
        }),
      );
    });
  });

  describe("loadProductActionsAction", () => {
    it("returns actions for valid product", async () => {
      mockListProductActions.mockResolvedValue([
        {
          id: validActionId,
          productId: validProductId,
          actionType: "OPEN_SUBMENU",
          sortOrder: 0,
        },
      ]);

      const res = await loadProductActionsAction(validProductId);
      expect(res.success).toBe(true);
      expect(res.actions).toHaveLength(1);
    });
  });
});
