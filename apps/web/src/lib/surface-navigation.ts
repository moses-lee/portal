/** Internal links request a UI destination; the shell chooses a popup, page surface, or workspace tab. */
export const APP_NAVIGATION_EVENT = "portal:navigate";

export function requestAppNavigation(path: string) {
  window.dispatchEvent(new CustomEvent(APP_NAVIGATION_EVENT, { detail: path }));
}
