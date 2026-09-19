import { useMediaQuery } from "@/components/useMediaQuery";

const MOBILE_BREAKPOINT = 768;

/** What shadcn's Sidebar asks for, on Portal's subscription-based media query hook. */
export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`, false);
}
