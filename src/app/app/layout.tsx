import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  applicationName: "Nokmel Merchant",
  manifest: "/app/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Nokmel Merchant",
    statusBarStyle: "default",
  },
};

export default function MerchantAppLayout({ children }: { children: ReactNode }) {
  return children;
}
