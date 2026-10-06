/**
 * In-app navigation without a server round trip: Next syncs `usePathname` and `useSearchParams` with
 * the native history API, and the app's routes render nothing of their own, so a router navigation
 * (which fetches the route's payload first) would only delay the switch.
 */
const current = () => `${window.location.pathname}${window.location.search}`;

/** A new history entry, unless `path` is already the current URL. */
export function pushPath(path: string) {
  if (current() === path) return;
  window.history.pushState(null, "", path);
}

/** Rewrite the current entry (resolvers, focus changes). */
export function replacePath(path: string) {
  if (current() === path) return;
  window.history.replaceState(null, "", path);
}

export function navigateTo(path: string, options: { replace?: boolean } = {}) {
  if (options.replace) replacePath(path);
  else pushPath(path);
}
