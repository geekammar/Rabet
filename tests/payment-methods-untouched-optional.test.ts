import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockCheckPaymentMethodsCapability = vi.fn();
const mockListLanguages = vi.fn();
const mockReadPaymentMethod = vi.fn();
const mockEditPaymentMethod = vi.fn();

vi.mock("@/db/client", () => ({
  getDb: () => ({}),
}));

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    checkPaymentMethodsCapability: (...args: unknown[]) =>
      mockCheckPaymentMethodsCapability(...args),
    listLanguages: (...args: unknown[]) => mockListLanguages(...args),
    readPaymentMethod: (...args: unknown[]) => mockReadPaymentMethod(...args),
    editPaymentMethod: (...args: unknown[]) => mockEditPaymentMethod(...args),
  };
});

const { updatePaymentMethodAction } = await import("@/app/actions/payment-methods");

describe("updatePaymentMethodAction — Untouched Optional Translations & Partial Updates", () => {
  const methodId = "00000000-0000-0000-0000-000000000001";

  const registeredLanguages = [
    { id: "lang-en", code: "en", label: "English", textDirection: "ltr", isEnabled: true },
    { id: "lang-ar", code: "ar", label: "Arabic", textDirection: "rtl", isEnabled: true },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    mockCheckPaymentMethodsCapability.mockResolvedValue({ supported: true });
    mockListLanguages.mockResolvedValue(registeredLanguages);
  });

  it("a. English-only method, Arabic registered but untouched: changes admin label and saves successfully", async () => {
    // Method currently only has English
    mockReadPaymentMethod.mockResolvedValueOnce({
      id: methodId,
      adminLabel: "Original Label",
      isActive: false,
      translations: {
        en: {
          id: "trans-en",
          languageId: "lang-en",
          languageCode: "en",
          title: "Bank Wire",
          instructions: "IBAN 123",
        },
      },
    });

    mockEditPaymentMethod.mockResolvedValueOnce({
      method: {
        id: methodId,
        adminLabel: "New Admin Label",
        isActive: false,
        translations: {
          en: {
            id: "trans-en",
            languageId: "lang-en",
            languageCode: "en",
            title: "Bank Wire",
            instructions: "IBAN 123",
          },
        },
      },
    });

    // Submitting with empty/untouched Arabic draft
    const res = await updatePaymentMethodAction({
      id: methodId,
      adminLabel: "New Admin Label",
      translations: [
        { languageCode: "en", title: "Bank Wire", instructions: "IBAN 123" },
        { languageCode: "ar", title: "", instructions: "" },
      ],
    });

    expect(res.success).toBe(true);
    expect(res.errors).toBeUndefined();
    expect(mockEditPaymentMethod).toHaveBeenCalledTimes(1);

    const callArg = mockEditPaymentMethod.mock.calls[0][1];
    expect(callArg.adminLabel).toBe("New Admin Label");
    // Arabic must NOT have been sent to editPaymentMethod as an invalid translation
    const arTrans = callArg.translations.find((t: { languageCode: string }) => t.languageCode === "ar");
    expect(arTrans).toBeUndefined();
  });

  it("b. Arabic-only method with English untouched: changes admin label and saves successfully", async () => {
    // Method currently only has Arabic
    mockReadPaymentMethod.mockResolvedValueOnce({
      id: methodId,
      adminLabel: "Original Arabic Label",
      isActive: false,
      translations: {
        ar: {
          id: "trans-ar",
          languageId: "lang-ar",
          languageCode: "ar",
          title: "تحويل بنكي",
          instructions: "رقم الحساب 123",
        },
      },
    });

    mockEditPaymentMethod.mockResolvedValueOnce({
      method: {
        id: methodId,
        adminLabel: "Updated Arabic Label",
        isActive: false,
        translations: {
          ar: {
            id: "trans-ar",
            languageId: "lang-ar",
            languageCode: "ar",
            title: "تحويل بنكي",
            instructions: "رقم الحساب 123",
          },
        },
      },
    });

    // Submitting with empty/untouched English draft
    const res = await updatePaymentMethodAction({
      id: methodId,
      adminLabel: "Updated Arabic Label",
      translations: [
        { languageCode: "en", title: "", instructions: "" },
        { languageCode: "ar", title: "تحويل بنكي", instructions: "رقم الحساب 123" },
      ],
    });

    expect(res.success).toBe(true);
    expect(mockEditPaymentMethod).toHaveBeenCalledTimes(1);
    const callArg = mockEditPaymentMethod.mock.calls[0][1];
    expect(callArg.adminLabel).toBe("Updated Arabic Label");
    const enTrans = callArg.translations.find((t: { languageCode: string }) => t.languageCode === "en");
    expect(enTrans).toBeUndefined();
  });

  it("c. Change both languages: both persist atomically", async () => {
    mockReadPaymentMethod.mockResolvedValueOnce({
      id: methodId,
      adminLabel: "Bilingual Method",
      isActive: true,
      translations: {
        en: {
          id: "trans-en",
          languageId: "lang-en",
          languageCode: "en",
          title: "Old English Title",
          instructions: "Old English Inst",
        },
        ar: {
          id: "trans-ar",
          languageId: "lang-ar",
          languageCode: "ar",
          title: "عنوان قديم",
          instructions: "تعليمات قديمة",
        },
      },
    });

    mockEditPaymentMethod.mockResolvedValueOnce({
      method: {
        id: methodId,
        adminLabel: "Bilingual Method",
        isActive: true,
        translations: {
          en: {
            id: "trans-en",
            languageId: "lang-en",
            languageCode: "en",
            title: "New English Title",
            instructions: "New English Inst",
          },
          ar: {
            id: "trans-ar",
            languageId: "lang-ar",
            languageCode: "ar",
            title: "عنوان جديد",
            instructions: "تعليمات جديدة",
          },
        },
      },
    });

    const res = await updatePaymentMethodAction({
      id: methodId,
      translations: [
        { languageCode: "en", title: "New English Title", instructions: "New English Inst" },
        { languageCode: "ar", title: "عنوان جديد", instructions: "تعليمات جديدة" },
      ],
    });

    expect(res.success).toBe(true);
    expect(mockEditPaymentMethod).toHaveBeenCalledTimes(1);
    const callArg = mockEditPaymentMethod.mock.calls[0][1];
    expect(callArg.translations).toHaveLength(2);
    expect(callArg.translations[0].title).toBe("New English Title");
    expect(callArg.translations[1].title).toBe("عنوان جديد");
  });

  it("d. Clear an existing title: failure and zero partial writes", async () => {
    mockReadPaymentMethod.mockResolvedValueOnce({
      id: methodId,
      adminLabel: "Test Method",
      isActive: false,
      translations: {
        en: {
          id: "trans-en",
          languageId: "lang-en",
          languageCode: "en",
          title: "Existing Title",
          instructions: "Existing Instructions",
        },
      },
    });

    // Explicitly clearing existing title
    const res = await updatePaymentMethodAction({
      id: methodId,
      translations: [
        { languageCode: "en", title: "   ", instructions: "Updated Inst" },
      ],
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.errors?.title_en).toContain("Customer-facing title cannot be empty");
    // Zero database writes occurred!
    expect(mockEditPaymentMethod).not.toHaveBeenCalled();
  });

  it("e. Add instructions without a title to a new translation: failure and zero writes", async () => {
    mockReadPaymentMethod.mockResolvedValueOnce({
      id: methodId,
      adminLabel: "English Only",
      isActive: false,
      translations: {
        en: {
          id: "trans-en",
          languageId: "lang-en",
          languageCode: "en",
          title: "Existing English",
          instructions: null,
        },
      },
    });

    // Adding instructions to new Arabic translation without providing a title
    const res = await updatePaymentMethodAction({
      id: methodId,
      translations: [
        { languageCode: "ar", title: "", instructions: "تعليمات بدون عنوان" },
      ],
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.errors?.title_ar).toContain("Customer-facing title is required for a new translation");
    expect(mockEditPaymentMethod).not.toHaveBeenCalled();
  });

  it("f. Explicitly clear existing instructions: succeeds and preserves title", async () => {
    mockReadPaymentMethod.mockResolvedValueOnce({
      id: methodId,
      adminLabel: "Test Method",
      isActive: false,
      translations: {
        en: {
          id: "trans-en",
          languageId: "lang-en",
          languageCode: "en",
          title: "Preserved Title",
          instructions: "Old Instructions to Clear",
        },
      },
    });

    mockEditPaymentMethod.mockResolvedValueOnce({
      method: {
        id: methodId,
        adminLabel: "Test Method",
        isActive: false,
        translations: {
          en: {
            id: "trans-en",
            languageId: "lang-en",
            languageCode: "en",
            title: "Preserved Title",
            instructions: null,
          },
        },
      },
    });

    const res = await updatePaymentMethodAction({
      id: methodId,
      translations: [
        { languageCode: "en", instructions: "" },
      ],
    });

    expect(res.success).toBe(true);
    expect(mockEditPaymentMethod).toHaveBeenCalledTimes(1);
    const callArg = mockEditPaymentMethod.mock.calls[0][1];
    expect(callArg.translations).toHaveLength(1);
    expect(callArg.translations[0].instructions).toBeNull();
  });
});
