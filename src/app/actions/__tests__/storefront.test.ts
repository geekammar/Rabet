import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockGetDb = vi.fn(() => ({}));
vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

const mockSave = vi.fn();
const mockReset = vi.fn();
vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    saveStorefrontMenuConfig: (...args: unknown[]) => mockSave(...args),
    resetStorefrontMenuConfig: (...args: unknown[]) => mockReset(...args),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { saveStorefrontMenuAction, resetStorefrontMenuAction } = await import(
  "../storefront"
);

const validConfig = {
  version: 1 as const,
  items: [
    { key: "support" as const, enabled: true },
    { key: "products" as const, enabled: false },
    { key: "categories" as const, enabled: true },
    { key: "languages" as const, enabled: true },
    { key: "inquiries" as const, enabled: true },
  ],
};

describe("storefront menu Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test" });
  });

  it("checks the admin session before any database access", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized admin access"));

    await expect(saveStorefrontMenuAction(validConfig)).rejects.toThrow(
      "Unauthorized admin access",
    );
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects an all-disabled menu before writing", async () => {
    const result = await saveStorefrontMenuAction({
      version: 1,
      items: validConfig.items.map((item) => ({ ...item, enabled: false })),
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("persists a valid ordered configuration", async () => {
    mockSave.mockResolvedValue(validConfig);

    const result = await saveStorefrontMenuAction(validConfig);

    expect(result.success).toBe(true);
    expect(result.config).toEqual(validConfig);
    expect(mockSave).toHaveBeenCalledWith(expect.anything(), validConfig);
  });

  it("resets through the dedicated data-layer operation", async () => {
    mockReset.mockResolvedValue({
      version: 1,
      items: validConfig.items.map((item) => ({ ...item, enabled: true })),
    });

    const result = await resetStorefrontMenuAction();

    expect(result.success).toBe(true);
    expect(result.message).toContain("reset");
    expect(mockReset).toHaveBeenCalledTimes(1);
  });
});
