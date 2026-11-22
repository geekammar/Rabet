import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const React = await import("react");

  return {
    default: ({
      href,
      children,
      ...props
    }: {
      href: string;
      children?: React.ReactNode;
    }) => React.createElement("a", { href, ...props }, children),
  };
});

vi.mock("next/server", () => ({
  connection: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));

const cookieLocale = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "rabet-merchant-locale" && cookieLocale.value
        ? { name, value: cookieLocale.value }
        : undefined,
  }),
}));

vi.mock("@/lib/auth/merchant-gate", () => ({
  isMerchantAppEnabled: () => true,
}));

const { InvitationAcceptance, INVITATION_COPY } = await import(
  "@/components/merchant/invitation-acceptance"
);
const { InvitationBrand } = await import(
  "@/components/merchant/invitation-brand"
);
const { INVITATION_BRAND, INVITATION_PAGE_TITLE } = await import(
  "@/lib/merchant-invitation/branding"
);
const { generateMetadata } = await import("@/app/invite/page");

describe("merchant invitation branding", () => {
  it("uses the exact Nokmel Arabic and English copy", () => {
    expect(INVITATION_BRAND).toEqual({ ar: "نكمل", en: "Nokmel" });

    expect(INVITATION_COPY.ar.title).toBe("دعوة لإدارة متجرك على نكمل");
    expect(INVITATION_COPY.ar.subtitle).toBe(
      "أنشئ حسابك للبدء في إعداد متجرك.",
    );
    expect(INVITATION_COPY.ar.submit).toBe("افتح متجري");

    expect(INVITATION_COPY.en.title).toBe(
      "You’re invited to manage your store on Nokmel",
    );
    expect(INVITATION_COPY.en.subtitle).toBe(
      "Create your account to start setting up your store.",
    );
    expect(INVITATION_COPY.en.submit).toBe(
      "Open my store",
    );
  });

  it("renders the Arabic brand, title and description without legacy Rabet copy", () => {
    const html = renderToStaticMarkup(
      createElement(InvitationAcceptance, { initialLocale: "ar" }),
    );

    expect(html).toContain('aria-label="نكمل"');
    expect(html).toContain(">نكمل<");
    expect(html).toContain("دعوة لإدارة متجرك على نكمل");
    expect(html).toContain("أنشئ حسابك للبدء في إعداد متجرك.");
    expect(html).not.toContain("Rabet");
    expect(html).not.toContain("قبول دعوة التاجر");
    expect(html).not.toContain("Accept merchant invitation");
  });

  it("renders the English brand with the same accessible name", () => {
    const html = renderToStaticMarkup(
      createElement(InvitationBrand, { locale: "en" }),
    );

    expect(html).toContain('aria-label="Nokmel"');
    expect(html).toContain(">Nokmel<");
    expect(html).not.toContain("Rabet");
  });

  it("uses the Nokmel page title in server metadata", async () => {
    cookieLocale.value = undefined;
    const metadata = await generateMetadata();

    expect(metadata.title).toBe(INVITATION_PAGE_TITLE.ar);
    expect(metadata.description).toBe(
      "Accept a Nokmel merchant invitation.",
    );
    expect(metadata.title).not.toMatch(/Rabet/);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("localizes the invitation document metadata from the saved locale", async () => {
    cookieLocale.value = "en";

    try {
      const metadata = await generateMetadata();

      expect(metadata.title).toBe(INVITATION_PAGE_TITLE.en);
      expect(metadata.robots).toEqual({ index: false, follow: false });
    } finally {
      cookieLocale.value = undefined;
    }
  });
});
