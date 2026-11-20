type ProductTranslations = Record<string, { name?: string | null } | undefined>;

export function resolveMerchantProductName(
  translations: ProductTranslations,
  slug: string,
): string {
  const arabic = translations.ar?.name?.trim();
  if (arabic) return arabic;

  const english = translations.en?.name?.trim();
  if (english) return english;

  for (const code of Object.keys(translations).sort()) {
    const name = translations[code]?.name?.trim();
    if (name) return name;
  }

  return slug;
}
