"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

import {
  getNavGroupOpenState,
  isNavItemActive,
  navGroups,
  type NavGroupId,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function DashboardNav({
  className,
  onNavigate,
  variant = "sidebar",
}: {
  className?: string;
  /** Called after a link is activated (used to close the mobile drawer). */
  onNavigate?: () => void;
  variant?: "sidebar" | "mobile";
}) {
  const pathname = usePathname();

  return (
    <DashboardNavContent
      key={pathname}
      pathname={pathname}
      className={className}
      onNavigate={onNavigate}
      variant={variant}
    />
  );
}

function DashboardNavContent({
  pathname,
  className,
  onNavigate,
  variant,
}: {
  pathname: string;
  className?: string;
  onNavigate?: () => void;
  variant: "sidebar" | "mobile";
}) {
  const [manualOpenState, setManualOpenState] = useState<
    Record<NavGroupId, boolean> | null
  >(null);
  const openState = manualOpenState ?? getNavGroupOpenState(pathname);

  return (
    <nav
      aria-label="Dashboard"
      data-testid={`${variant}-nav`}
      className={cn("min-w-0", className)}
    >
      <div className="flex flex-col gap-5">
        {navGroups.map((group) => {
          const groupOpen = openState[group.id];
          const listId = `nav-group-${group.id}`;
          const headingId = `nav-group-heading-${group.id}`;

          return (
            <section key={group.id} aria-labelledby={headingId}>
              {group.collapsible ? (
                <h2 id={headingId}>
                  <button
                    type="button"
                    aria-expanded={groupOpen}
                    aria-controls={listId}
                    onClick={() =>
                      setManualOpenState({
                        ...openState,
                        [group.id]: !groupOpen,
                      })
                    }
                    className={cn(
                      "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/60 outline-none transition-colors",
                      "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                      "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                    )}
                    data-testid={`nav-group-toggle-${group.id}`}
                  >
                    <span>{group.label}</span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 transition-transform",
                        groupOpen ? "rotate-180" : undefined,
                      )}
                    />
                  </button>
                </h2>
              ) : (
                <h2
                  id={headingId}
                  className="flex min-h-11 items-center px-3 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/60"
                >
                  {group.label}
                </h2>
              )}

              <ul
                id={listId}
                hidden={!groupOpen}
                className="mt-1 flex flex-col gap-1"
              >
                {group.items.map((item) => {
                  const isActive = isNavItemActive(pathname, item.href);
                  const Icon = item.icon;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={isActive ? "page" : undefined}
                        data-testid={`nav-link-${item.href.slice(1)}`}
                        className={cn(
                          // min-h-11 keeps every link at the 44x44 CSS-pixel touch
                          // target required on mobile, in the drawer and the sidebar.
                          "relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none transition-colors",
                          "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                          isActive
                            ? "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-2 before:w-1 before:rounded-full before:bg-foreground before:content-['']"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                        )}
                      >
                        <Icon
                          aria-hidden="true"
                          className={cn(
                            "size-4 shrink-0",
                            isActive
                              ? "text-sidebar-accent-foreground"
                              : "text-muted-foreground",
                          )}
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
