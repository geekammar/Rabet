export const STOREFRONT_PROFILE_LIMITS = {
  displayName: 80,
  welcome: 160,
  description: 400,
  logoUrl: 2048,
  coverUrl: 2048,
} as const;

export type StorefrontProfile = Record<keyof typeof STOREFRONT_PROFILE_LIMITS, string>;

export const EMPTY_STOREFRONT_PROFILE: StorefrontProfile = {
  displayName: "",
  welcome: "",
  description: "",
  logoUrl: "",
  coverUrl: "",
};

export function storefrontImageUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password &&
      url.href.length <= STOREFRONT_PROFILE_LIMITS.coverUrl ? url.href : null;
  } catch {
    return null;
  }
}

export function parseStorefrontProfile(input: FormData):
  | { ok: true; profile: StorefrontProfile }
  | { ok: false; field: keyof StorefrontProfile } {
  const profile = { ...EMPTY_STOREFRONT_PROFILE };
  for (const field of Object.keys(profile) as Array<keyof StorefrontProfile>) {
    const raw = input.get(field);
    if (typeof raw !== "string") return { ok: false, field };
    const value = raw.trim();
    if (value.length > STOREFRONT_PROFILE_LIMITS[field] || value.includes("\0")) {
      return { ok: false, field };
    }
    if (value && (field === "logoUrl" || field === "coverUrl")) {
      const url = storefrontImageUrl(value);
      if (!url) return { ok: false, field };
      profile[field] = url;
    } else {
      profile[field] = value;
    }
  }
  return { ok: true, profile };
}

export function storefrontWelcomeLines(
  profile: StorefrontProfile,
  storeName: string,
  defaultWelcome: (name: string) => string,
): string[] {
  const displayName = profile.displayName.trim() || storeName;
  const welcome = profile.welcome.trim();
  const description = profile.description.trim();
  return [
    ...(welcome ? [displayName, welcome] : [defaultWelcome(displayName)]),
    ...(description ? [description] : []),
  ];
}
