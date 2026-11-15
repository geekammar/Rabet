import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  connection: vi.fn().mockResolvedValue(undefined),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockLoadCatalogAdminViewData = vi.fn();
vi.mock("@/lib/catalog/load-admin-data", () => ({
  loadCatalogAdminViewData: (...args: unknown[]) =>
    mockLoadCatalogAdminViewData(...args),
}));

const CategoriesPage = (await import("@/app/(dashboard)/categories/page")).default;

describe("Categories Page — availability states and read-only loading", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  it("requires the admin boundary before loading data", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized"));
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "database_setup_required",
    });

    await expect(CategoriesPage()).rejects.toThrow("Unauthorized");
    expect(mockLoadCatalogAdminViewData).not.toHaveBeenCalled();
  });

  it("renders DatabaseSetupRequired when DATABASE_URL is missing", async () => {
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "database_setup_required",
    });

    const element = await CategoriesPage();
    expect(element.type.name).toBe("DatabaseSetupRequired");
    expect(element.props.title).toBe("Categories");
  });

  it("renders DatabaseUnavailable with the safe message", async () => {
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "database_unavailable",
      message: "Could not connect. Details were logged.",
    });

    const element = await CategoriesPage();
    expect(element.type.name).toBe("DatabaseUnavailable");
    expect(element.props.title).toBe("Categories");
  });

  it("renders CatalogStoreSetupRequired when store settings are missing", async () => {
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "store_setup_required",
    });

    const element = await CategoriesPage();
    expect(element.type.name).toBe("CatalogStoreSetupRequired");
  });

  it("renders CategoriesAdmin with categories and the products used for counts", async () => {
    const data = {
      settings: { displayName: "Store", currency: "USD" },
      defaultLanguage: {
        id: "lang-en",
        code: "en",
        label: "English",
        textDirection: "ltr" as const,
      },
      languages: [
        { id: "lang-en", code: "en", label: "English", isEnabled: true },
      ],
      categories: [{ id: "cat-1", slug: "root" }],
      products: [{ id: "prod-1", categoryId: "cat-1", slug: "phone" }],
    };
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "ready",
      data,
    });

    const element = await CategoriesPage();
    expect(element.type.name).toBe("CategoriesAdmin");
    expect(element.props.categories).toEqual(data.categories);
    expect(element.props.products).toEqual(data.products);
  });
});
