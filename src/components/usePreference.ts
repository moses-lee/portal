"use client";

import { useCallback, useSyncExternalStore } from "react";

const eventName = "portal-preferences";
const memory = new Map<string, string>();
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
}

export function usePreference(key: string, fallback: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return memory.get(key) ?? localStorage.getItem(key) ?? fallback;
      } catch {
        return memory.get(key) ?? fallback;
      }
    },
    () => fallback,
  );
  const setValue = useCallback(
    (value: string) => {
      try {
        localStorage.setItem(key, value);
        memory.delete(key);
      } catch {
        memory.set(key, value);
      }
      window.dispatchEvent(new Event(eventName));
    },
    [key],
  );
  return [value, setValue] as const;
}
