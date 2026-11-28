import type { MetadataRoute } from "next";

import adminManifest from "../../manifest";

export function GET(): Response {
  // Share the existing icon assets and display settings while keeping a
  // separate install identity and launch path for the merchant dashboard.
  const manifest: MetadataRoute.Manifest = {
    ...adminManifest(),
    id: "/app",
    name: "Nokmel Merchant Dashboard",
    short_name: "Nokmel Merchant",
    description: "Manage your Nokmel store, products, and orders.",
    start_url: "/app",
    scope: "/app",
  };

  return Response.json(manifest, {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
