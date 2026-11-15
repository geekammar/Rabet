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

const ProductsPage = (await import("@/app/(dashboard)/products/page")).default;

describe("Products Page — availability states and read-only loading", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  it("requires the admin boundary before loading data", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized"));
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "database_setup_required",
    });

    await expect(ProductsPage()).rejects.toThrow("Unauthorized");
    expect(mockLoadCatalogAdminViewData).not.toHaveBeenCalled();
  });

  it("renders DatabaseSetupRequired when DATABASE_URL is missing", async () => {
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "database_setup_required",
    });

    const element = await ProductsPage();
    expect(element.type.name).toBe("DatabaseSetupRequired");
    expect(element.props.title).toBe("Products");
  });

  it("renders DatabaseUnavailable with the safe message", async () => {
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "database_unavailable",
      message: "Could not connect. Details were logged.",
    });

    const element = await ProductsPage();
    expect(element.type.name).toBe("DatabaseUnavailable");
    expect(element.props.title).toBe("Products");
    expect(element.props.message).toBe(
      "Could not connect. Details were logged.",
    );
  });

  it("renders CatalogStoreSetupRequired when store settings are missing", async () => {
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "store_setup_required",
    });

    const element = await ProductsPage();
    expect(element.type.name).toBe("CatalogStoreSetupRequired");
  });

  it("renders ProductsAdmin with loaded catalog data", async () => {
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
      products: [{ id: "prod-1", slug: "phone" }],
    };
    mockLoadCatalogAdminViewData.mockResolvedValueOnce({
      kind: "ready",
      data,
    });

    const element = await ProductsPage();
    expect(element.type.name).toBe("ProductsAdmin");
    expect(element.props.settings.currency).toBe("USD");
    expect(element.props.categories).toEqual(data.categories);
    expect(element.props.products).toEqual(data.products);
  });
});
