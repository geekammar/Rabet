const MAX_SLUG_LENGTH = 100;
const RANDOM_HEX_LENGTH = 8;

export type CatalogSlugPrefix = "product" | "category";

function asciiBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function randomHex(length = RANDOM_HEX_LENGTH): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

export function generateCatalogSlug(
  prefix: CatalogSlugPrefix,
  displayName: string,
  token = randomHex(),
): string {
  const suffix = token.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16);
  const separatorLength = suffix.length > 0 ? prefix.length + suffix.length + 2 : prefix.length + 1;
  const maxBaseLength = Math.max(0, MAX_SLUG_LENGTH - separatorLength);
  const base = asciiBase(displayName).slice(0, maxBaseLength).replace(/-+$/g, "");
  const parts = [prefix, base, suffix].filter((part) => part.length > 0);

  return parts.join("-");
}
