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
const mockReadSettings = vi.fn();

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    createProductAction: (...args: unknown[]) => mockCreateProductAction(...args),
    editProductAction: (...args: unknown[]) => mockEditProductAction(...args),
    listProductActions: (...args: unknown[]) => mockListProductActions(...args),
    listLanguages: (...args: unknown[]) => mockListLanguages(...args),
    resolveDefaultLanguage: (...args: unknown[]) => mockResolveDefaultLanguage(...args),
    readSettings: (...args: unknown[]) => mockReadSettings(...args),
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
    mockReadSettings.mockResolvedValue({
      supportCategory: ["Returns", "Warranty"],
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

    it("rejects arbitrary or invalid action types", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "CUSTOM_UNKNOWN_TYPE",
        label: "Link",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.actionType).toMatch(/invalid action type/i);
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

    it("rejects URL and navigation parameters on OPEN_SUBMENU", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "Menu",
        url: "https://example.com",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.parameters).toMatch(/only permitted on OPEN_URL/i);
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

    it("rejects terminal action with nonblank arabicMenuText with 0 DB writes", async () => {
      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "SHOW_DETAILS",
        label: "Specs",
        arabicLabel: "المواصفات",
        arabicMenuText: "نص غير مسموح",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.parameters).toMatch(/only permitted on OPEN_SUBMENU/i);
      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("rejects invalid actionConfig with 0 DB writes", async () => {
      const res1 = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "Menu",
        actionConfig: "arbitrary-string",
      });
      expect(res1.success).toBe(false);
      expect(res1.errors?.parameters).toMatch(/actionConfig must be an empty plain object/i);

      const res2 = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "Menu",
        actionConfig: [1, 2, 3],
      });
      expect(res2.success).toBe(false);
      expect(res2.errors?.parameters).toMatch(/actionConfig cannot be an array/i);

      const res3 = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "Menu",
        actionConfig: { extraField: true },
      });
      expect(res3.success).toBe(false);
      expect(res3.errors?.parameters).toMatch(/Custom actionConfig properties are not supported/i);

      expect(mockCreateProductAction).not.toHaveBeenCalled();
    });

    it("successfully creates an action when Arabic is store default", async () => {
      mockResolveDefaultLanguage.mockResolvedValue({
        id: "lang-ar-id",
        code: "ar",
        label: "العربية",
        isEnabled: true,
      });
      mockCreateProductAction.mockResolvedValue({
        actionId: validActionId,
        action: {
          id: validActionId,
          productId: validProductId,
          actionType: "OPEN_SUBMENU",
        },
      });

      const res = await createProductActionAction({
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        label: "القائمة الرئيسية",
      });

      expect(res.success).toBe(true);
      expect(mockCreateProductAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          translations: [
            expect.objectContaining({
              languageCode: "ar",
              label: "القائمة الرئيسية",
            }),
          ],
        }),
      );
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

    it("rejects translation update when languageCode is missing", async () => {
      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        label: "Updated Label",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.languageCode).toMatch(/Language code is required/i);
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });

    it("rejects translation update when label is missing", async () => {
      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        languageCode: "en",
        menuText: "Updated Menu Text",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.label).toMatch(/Button label in EN is required/i);
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });

    it("rejects unsupported language code before database lookup", async () => {
      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        languageCode: "es",
        label: "Opciones",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.languageCode).toMatch(/not supported by the action editor/i);
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });

    it("rejects unregistered language update", async () => {
      mockListLanguages.mockResolvedValue([
        { id: "lang-en-id", code: "en", label: "English", isEnabled: true },
      ]); // Arabic not registered

      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        languageCode: "ar",
        label: "خيارات",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.languageCode).toMatch(/not registered/i);
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });

    it("rejects terminal action with nonblank menuText", async () => {
      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "SHOW_DETAILS",
        isActive: true,
        languageCode: "en",
        label: "View Specs",
        menuText: "Message on terminal action",
      });

      expect(res.success).toBe(false);
      expect(res.errors?.menuText).toMatch(/only permitted on OPEN_SUBMENU/i);
      expect(mockEditProductAction).not.toHaveBeenCalled();
    });

    it("allows intentional base-only update without translation fields", async () => {
      mockEditProductAction.mockResolvedValue({
        action: {
          id: validActionId,
          productId: validProductId,
          actionType: "START_INQUIRY",
          isActive: false,
          translations: {},
        },
      });

      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "START_INQUIRY",
        isActive: false,
      });

      expect(res.success).toBe(true);
      expect(mockEditProductAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actionId: validActionId,
          productId: validProductId,
          actionType: "START_INQUIRY",
          isActive: false,
          translation: undefined,
        }),
      );
    });

    it("preserves omitted menuText when updating label only", async () => {
      mockEditProductAction.mockResolvedValue({
        action: {
          id: validActionId,
          productId: validProductId,
          actionType: "OPEN_SUBMENU",
          isActive: true,
          translations: {},
        },
      });

      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        languageCode: "en",
        label: "New Submenu Label",
      });

      expect(res.success).toBe(true);
      expect(mockEditProductAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          translation: expect.objectContaining({
            label: "New Submenu Label",
            menuText: undefined,
          }),
        }),
      );
    });

    it("explicitly clears menuText when passed empty string or null", async () => {
      mockEditProductAction.mockResolvedValue({
        action: {
          id: validActionId,
          productId: validProductId,
          actionType: "OPEN_SUBMENU",
          isActive: true,
          translations: {},
        },
      });

      const res = await updateProductActionAction({
        actionId: validActionId,
        productId: validProductId,
        actionType: "OPEN_SUBMENU",
        isActive: true,
        languageCode: "en",
        label: "Submenu",
        menuText: "",
      });

      expect(res.success).toBe(true);
      expect(mockEditProductAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          translation: expect.objectContaining({
            label: "Submenu",
            menuText: null,
          }),
        }),
      );
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

    it("returns safe not-found state when product does not exist or is deleted", async () => {
      const { RabetDataError } = await import("@/lib/data");
      mockListProductActions.mockRejectedValue(
        new RabetDataError(
          "NOT_FOUND",
          "Referenced product does not exist or has been deleted.",
        ),
      );

      const res = await loadProductActionsAction(validProductId);
      expect(res.success).toBe(false);
      expect(res.code).toBe("NOT_FOUND");
      expect(res.message).toMatch(/does not exist or has been deleted/i);
    });
  });

  describe("Phase 05-B2 New Action Types", () => {
    describe("SEND_TEMPLATE_MESSAGE", () => {
      it("requires nonblank template body in default language", async () => {
        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          label: "Send Message",
          templateBody: "",
        });

        expect(res.success).toBe(false);
        expect(res.code).toBe("INVALID_INPUT");
        expect(res.errors?.templateBody).toMatch(/required/i);
      });

      it("rejects unknown placeholders in template body", async () => {
        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          label: "Send Message",
          templateBody: "Hello {{unknown_placeholder}}",
        });

        expect(res.success).toBe(false);
        expect(res.code).toBe("INVALID_INPUT");
        expect(res.errors?.templateBody).toMatch(/unknown placeholder/i);
      });

      it("creates SEND_TEMPLATE_MESSAGE with valid placeholders", async () => {
        mockCreateProductAction.mockResolvedValue({
          actionId: validActionId,
          action: { id: validActionId, actionType: "SEND_TEMPLATE_MESSAGE" },
        });

        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          label: "Send Message",
          templateBody: "Hello {{customer_name}}, {{product_name}} is {{price}} at {{store_name}}.",
        });

        expect(res.success).toBe(true);
        expect(mockCreateProductAction).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actionType: "SEND_TEMPLATE_MESSAGE",
            translations: expect.arrayContaining([
              expect.objectContaining({
                label: "Send Message",
                templateBody: "Hello {{customer_name}}, {{product_name}} is {{price}} at {{store_name}}.",
              }),
            ]),
          }),
        );
      });
    });

    describe("OPEN_URL", () => {
      it("requires a valid HTTPS URL", async () => {
        const invalidRes = await createProductActionAction({
          productId: validProductId,
          actionType: "OPEN_URL",
          label: "Open Docs",
          url: "http://insecure.example.com",
        });

        expect(invalidRes.success).toBe(false);
        expect(invalidRes.code).toBe("INVALID_INPUT");
        expect(invalidRes.errors?.url).toMatch(/HTTPS/i);
      });

      it("creates OPEN_URL action with valid HTTPS URL", async () => {
        mockCreateProductAction.mockResolvedValue({
          actionId: validActionId,
          action: { id: validActionId, actionType: "OPEN_URL" },
        });

        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "OPEN_URL",
          label: "Documentation",
          url: "https://example.com/docs",
        });

        expect(res.success).toBe(true);
        expect(mockCreateProductAction).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actionType: "OPEN_URL",
            url: "https://example.com/docs",
          }),
        );
      });
    });

    describe("OPEN_SUPPORT", () => {
      it("accepts configured support category", async () => {
        mockCreateProductAction.mockResolvedValue({
          actionId: validActionId,
          action: { id: validActionId, actionType: "OPEN_SUPPORT" },
        });

        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "OPEN_SUPPORT",
          label: "Get Help",
          supportCategory: "Returns",
        });

        expect(res.success).toBe(true);
        expect(mockCreateProductAction).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actionType: "OPEN_SUPPORT",
            actionConfig: { support_category: "Returns" },
          }),
        );
      });

      it("rejects unconfigured support category", async () => {
        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "OPEN_SUPPORT",
          label: "Get Help",
          supportCategory: "NonexistentCategory",
        });

        expect(res.success).toBe(false);
        expect(res.code).toBe("INVALID_INPUT");
        expect(res.errors?.parameters).toMatch(/not configured in store settings/i);
      });
    });

    describe("NAVIGATE_CATALOG", () => {
      const validCatId = "c0000000-0000-0000-0000-000000000001";
      const validTargetProdId = "d0000000-0000-0000-0000-000000000001";

      it("requires either a category or a product target", async () => {
        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "NAVIGATE_CATALOG",
          label: "Jump",
        });

        expect(res.success).toBe(false);
        expect(res.code).toBe("INVALID_INPUT");
        expect(res.errors?.navigationTarget).toMatch(/requires either a category or a product/i);
      });

      it("rejects both category and product targets submitted together", async () => {
        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "NAVIGATE_CATALOG",
          label: "Jump",
          navigateCategoryId: validCatId,
          navigateProductId: validTargetProdId,
        });

        expect(res.success).toBe(false);
        expect(res.code).toBe("INVALID_INPUT");
        expect(res.errors?.navigationTarget).toMatch(/cannot specify both/i);
      });

      it("creates NAVIGATE_CATALOG with valid category target", async () => {
        mockCreateProductAction.mockResolvedValue({
          actionId: validActionId,
          action: { id: validActionId, actionType: "NAVIGATE_CATALOG" },
        });

        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "NAVIGATE_CATALOG",
          label: "Jump to Category",
          navigateCategoryId: validCatId,
        });

        expect(res.success).toBe(true);
        expect(mockCreateProductAction).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actionType: "NAVIGATE_CATALOG",
            navigateCategoryId: validCatId,
          }),
        );
      });
    });

    describe("Arabic default configuration", () => {
      it("handles Arabic default store correctly", async () => {
        mockResolveDefaultLanguage.mockResolvedValue({
          id: "lang-ar-id",
          code: "ar",
          label: "العربية",
          isEnabled: true,
        });

        mockCreateProductAction.mockResolvedValue({
          actionId: validActionId,
          action: { id: validActionId, actionType: "OPEN_URL" },
        });

        const res = await createProductActionAction({
          productId: validProductId,
          actionType: "OPEN_URL",
          label: "رابط المتجر",
          url: "https://example.com/ar",
        });

        expect(res.success).toBe(true);
        expect(mockCreateProductAction).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            translations: expect.arrayContaining([
              expect.objectContaining({
                languageId: "lang-ar-id",
                languageCode: "ar",
                label: "رابط المتجر",
              }),
            ]),
          }),
        );
      });
    });
  });
});
