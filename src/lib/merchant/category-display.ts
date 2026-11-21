type CategoryTranslations = Record<
  string,
  { name?: string | null } | undefined
>;

/**
 * Resolves a saved category name with the same fallback convention as the
 * merchant product list: Arabic, then English, then any saved language in code
 * order, then the stable slug.
 */
export function resolveMerchantCategoryName(
  translations: CategoryTranslations,
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
