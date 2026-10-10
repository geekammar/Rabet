import type { MetadataRoute } from "next";

/**
 * Web App Manifest — Rabet.
 *
 * Served at `/manifest.webmanifest` and linked automatically in the document
 * head by Next.js. This is the PWA foundation: it makes the dashboard
 * installable to a home screen with a standalone, app-like window.
 *
 * Deliberate omissions (see docs/ARCHITECTURE.md, "PWA foundation"):
 * - No service worker and no offline caching. This is an admin application;
 *   caching dashboard data or authenticated responses is a security risk, and
 *   there is no proven offline requirement yet.
 * - No Web Push Notifications.
 * - No `display_override`, no fake install buttons. Installation relies on the
 *   browser's own prompt once the manifest + icons + HTTPS criteria are met.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Rabet",
    short_name: "Rabet",
    description:
      "Rabet is a lightweight Telegram-based digital services management system with a web dashboard.",
    // The dashboard is the installable surface; the public landing page stays
    // in scope so it remains reachable from the standalone window.
    start_url: "/overview",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/icons/icon-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/maskable-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
