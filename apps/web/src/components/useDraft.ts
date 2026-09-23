"use client";

import { useCallback, useSyncExternalStore } from "react";
import { readDraft, subscribeDrafts, writeDraft } from "@/lib/drafts";

export function useDraft(id: string) {
  const value = useSyncExternalStore(
    subscribeDrafts,
    () => readDraft(id),
    () => "",
  );
  const setValue = useCallback((text: string) => writeDraft(id, text), [id]);
  return [value, setValue] as const;
}
