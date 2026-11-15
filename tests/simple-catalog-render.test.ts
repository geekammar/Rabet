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

vi.mock("@/app/actions/catalog", () => ({
  createProductAction: vi.fn(),
  updateProductAction: vi.fn(),
  createCategoryAction: vi.fn(),
  updateCategoryAction: vi.fn(),
}));

const { ProductsAdmin } = await import(
  "@/components/dashboard/catalog/products-admin"
);
const { CategoriesAdmin } = await import(
  "@/components/dashboard/catalog/categories-admin"
);

const now = new Date("2026-01-01T00:00:00.000Z");

const rootCategory = {
  id: "cat-root",
  parentId: null,
  slug: "root",
  sortOrder: 0,
  isActive: true,
  createdAt: now,
  updatedAt: now,
  translations: {
    en: {
      id: "cat-root-en",
      languageId: "lang-en",
      name: "Root",
      description: null,
    },
  },
};

const childCategory = {
  id: "cat-child",
  parentId: "cat-root",
  slug: "child",
  sortOrder: 0,
  isActive: true,
  createdAt: now,
  updatedAt: now,
  translations: {
    en: {
      id: "cat-child-en",
      languageId: "lang-en",
      name: "Child",
      description: null,
    },
  },
};

const activeProduct = {
  id: "prod-active",
  categoryId: "cat-child",
  slug: "active-product",
  price: "10.00",
  isActive: true,
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
  translations: {
    en: {
      id: "prod-active-en",
      languageId: "lang-en",
      name: "Active Product",
      description: null,
      details: null,
    },
  },
};

const inactiveProduct = {
  id: "prod-inactive",
  categoryId: "cat-root",
  slug: "inactive-product",
  price: "20.00",
  isActive: false,
  sortOrder: 1,
  createdAt: now,
  updatedAt: now,
  translations: {
    en: {
      id: "prod-inactive-en",
      languageId: "lang-en",
      name: "Inactive Product",
      description: null,
      details: null,
    },
  },
};

const languages = [
  { id: "lang-en", code: "en", label: "English", isEnabled: true },
];
const defaultLanguage = {
  id: "lang-en",
  code: "en",
  label: "English",
  textDirection: "ltr" as const,
};

describe("simple catalog screens — first render", () => {
  it("renders the independent product list with name, category, price, currency and status", () => {
    const html = renderToStaticMarkup(
      createElement(ProductsAdmin, {
        settings: { displayName: "Store", currency: "USD" },
        defaultLanguage,
        languages,
        categories: [rootCategory, childCategory],
        products: [activeProduct, inactiveProduct],
      }),
    );

    expect(html).toContain('data-testid="products-admin"');
    expect(html).toContain("Active Product");
    expect(html).toContain("Inactive Product");
    expect(html).toContain("USD");
    expect(html).toContain("10.00");
    expect(html).toContain("Root › Child");
    expect(html).toContain("Active");
    expect(html).toContain("Inactive");
    expect(html).toContain('data-testid="product-search"');
    expect(html).toContain('data-testid="add-product-btn"');
    expect(html).not.toContain("<table");
  });

  it("renders root and child categories with truthful counts and status", () => {
    const html = renderToStaticMarkup(
      createElement(CategoriesAdmin, {
        defaultLanguage,
        languages,
        categories: [rootCategory, childCategory],
        products: [activeProduct, inactiveProduct],
      }),
    );

    expect(html).toContain('data-testid="categories-admin"');
    expect(html).toContain('data-category-root="true"');
    expect(html).toContain('data-category-root="false"');
    expect(html).toContain("Root category");
    expect(html).toContain("Child of Root");
    expect(html).toContain("1 direct · 2 including subcategories");
    expect(html).toContain('data-testid="add-category-btn"');
    expect(html).not.toContain("<table");
  });

  it("uses 44 CSS pixel minimum targets and avoids dense tables on both screens", () => {
    const productsHtml = renderToStaticMarkup(
      createElement(ProductsAdmin, {
        settings: { displayName: "Store", currency: "USD" },
        defaultLanguage,
        languages,
        categories: [rootCategory, childCategory],
        products: [activeProduct, inactiveProduct],
      }),
    );
    const categoriesHtml = renderToStaticMarkup(
      createElement(CategoriesAdmin, {
        defaultLanguage,
        languages,
        categories: [rootCategory, childCategory],
        products: [activeProduct, inactiveProduct],
      }),
    );

    expect(productsHtml).toContain("min-h-11");
    expect(productsHtml).toContain("overflow-x-clip");
    expect(categoriesHtml).toContain("min-h-11");
    expect(categoriesHtml).toContain("overflow-x-clip");
  });
});
