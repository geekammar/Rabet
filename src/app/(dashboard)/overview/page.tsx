import type { Metadata } from "next";
import { connection } from "next/server";

import { OverviewDashboard } from "@/components/dashboard/overview/overview-dashboard";
import { requireAdmin } from "@/lib/auth/session";
import { loadOverviewData } from "@/lib/dashboard/overview";

export const metadata: Metadata = {
  title: "Overview",
  description: "Store counts and common merchant tasks.",
};

export const instant = false;

export default async function OverviewPage() {
  await connection();
  await requireAdmin();

  const data = await loadOverviewData();

  return <OverviewDashboard data={data} />;
}
