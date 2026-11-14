/**
 * Pure localization resolution for central payment-method content.
 *
 * This helper is shared by the server-side journey resolver and the dashboard
 * previews so both use the same documented fallback chain:
 * requested language → store default language → unavailable.
 *
 * It exposes no admin-only fields and never substitutes an internal admin
 * label for missing customer-facing content.
 */

export interface PaymentMethodContentCandidate {
  languageId: string;
  languageCode: string;
  title: string;
  instructions: string | null;
}

export interface ResolvedPaymentMethodContent {
  title: string;
  instructions: string | null;
  languageId: string;
  languageCode: string;
  usedFallback: boolean;
}

function candidateList(
  translations:
    | Record<string, PaymentMethodContentCandidate>
    | PaymentMethodContentCandidate[],
): PaymentMethodContentCandidate[] {
  return Array.isArray(translations) ? translations : Object.values(translations);
}

/**
 * Resolves customer-facing title/instructions for a payment method.
 * Returns `null` when no customer-facing title exists in either requested or
 * default language. Instructions are optional and are never borrowed from a
 * different language than the resolved title.
 */
export function resolvePaymentMethodContent(
  translations:
    | Record<string, PaymentMethodContentCandidate>
    | PaymentMethodContentCandidate[],
  requestedLanguageId: string | null | undefined,
  defaultLanguageId: string | null | undefined,
): ResolvedPaymentMethodContent | null {
  const candidates = candidateList(translations);

  const requested = requestedLanguageId
    ? candidates.find(
        (candidate) =>
          candidate.languageId === requestedLanguageId &&
          candidate.title.trim().length > 0,
      )
    : undefined;

  if (requested) {
    return {
      title: requested.title.trim(),
      instructions: requested.instructions,
      languageId: requested.languageId,
      languageCode: requested.languageCode,
      usedFallback: false,
    };
  }

  const fallback = defaultLanguageId
    ? candidates.find(
        (candidate) =>
          candidate.languageId === defaultLanguageId &&
          candidate.title.trim().length > 0,
      )
    : undefined;

  if (fallback) {
    return {
      title: fallback.title.trim(),
      instructions: fallback.instructions,
      languageId: fallback.languageId,
      languageCode: fallback.languageCode,
      usedFallback: requestedLanguageId !== defaultLanguageId,
    };
  }

  return null;
}
