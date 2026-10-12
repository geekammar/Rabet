import type { Metadata } from "next";
import { Package } from "lucide-react";

import { SectionPlaceholder } from "@/components/dashboard/section-placeholder";

export const metadata: Metadata = {
  title: "Catalog",
  description: "Products, categories, displayed prices and button trees.",
};

export default function CatalogPage() {
  return (
    <SectionPlaceholder
      title="Catalog"
      description="Manage your digital products, categories, displayed prices and configurable button trees."
      icon={Package}
      emptyDescription="The catalog editor is planned for a later phase. No products or button trees have been created yet."
    />
  );
}
