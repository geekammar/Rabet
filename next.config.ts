import type { NextConfig } from "next";

/**
 * Cache policy for authenticated dashboard routes.
 *
 * Dashboard pages are personalized — they are only reachable by the signed-in
 * admin and will later carry customer and inquiry data. Such responses
 * must never be stored in a shared CDN cache or the browser cache, otherwise a
 * private page could be served to a different visitor of the same cache, or
 * replayed after logout.
 *
 * `private, no-store, must-revalidate` is the strictest portable policy. It is
 * declared here (rather than set imperatively at request time) because with
 * Cache Components the dashboard shell is partially prerendered and the
 * prerendered segment's headers are finalized before the streamed, gated
 * segment runs — so a runtime `headers().set()` in the layout throws. A static
 * declaration applies to the whole response regardless of how it was rendered.
 *
 * Public routes (`/`, `/login`, static and PWA assets) keep Next.js defaults.
 */
const dashboardPaths = [
  "/overview",
  "/catalog",
  "/inquiries",
  "/customers",
  "/bot-content",
  "/telegram",
  "/settings",
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return dashboardPaths.map((source) => ({
      source,
      headers: [
        {
          key: "Cache-Control",
          value: "private, no-store, must-revalidate",
        },
        {
          key: "Pragma",
          value: "no-cache",
        },
      ],
    }));
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
