"use client";

import { useEffect } from "react";

export function MerchantOrderAnchor({ cardId }: { cardId: string }) {
  useEffect(() => {
    // The selected order can survive sign-in even if navigation drops the fragment.
    if (window.location.hash) return;

    const card = document.getElementById(cardId);
    if (!card) return;

    window.history.replaceState(null, "", `#${cardId}`);
    card.scrollIntoView({ block: "start" });
  }, [cardId]);

  return null;
}
