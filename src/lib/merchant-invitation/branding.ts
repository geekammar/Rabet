/**
 * Merchant-facing invitation branding.
 *
 * Kept in a small shared module so the client page, the document title and
 * the server metadata cannot drift. This is intentionally scoped to the
 * invitation page; it does not rebrand the dashboard or legacy surfaces.
 */

export const INVITATION_BRAND = {
  ar: "نكمل",
  en: "Nokmel",
} as const;

export const INVITATION_PAGE_TITLE = {
  ar: "دعوة لإدارة متجرك على نكمل",
  en: "You’re invited to manage your store on Nokmel",
} as const;
