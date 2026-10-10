import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

/**
 * Shared layout for dashboard sections that do not have functionality yet.
 * Keeps heading hierarchy and empty states consistent across sections.
 */
export function SectionPlaceholder({
  title,
  description,
  icon,
  emptyDescription,
  children,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  emptyDescription: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-8">
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={icon}
        title={`${title} will appear here`}
        description={emptyDescription}
      >
        {children}
      </EmptyState>
    </div>
  );
}
