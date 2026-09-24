import { portalViews } from "@/lib/session-routes";

/**
 * The home (`/`) and the fixed view paths are prerendered at build time, so they are static like
 * the separate home page used to be. `{ view: [] }` is the optional catch-all's root; the build
 * treats a missing or undefined optional param the same way. Thread ids (`/threads/<id>`) and memory
 * entities (`/memory/<id>`, `/memory/curation/...`) cannot be enumerated: `dynamicParams` stays at
 * its default (`true`), so those render on demand instead of 404ing.
 */
export function generateStaticParams(): { view: string[] }[] {
  return [{ view: [] }, ...portalViews.filter((view) => view !== "chat").map((view) => ({ view: [view] }))];
}

/** Portal's home and views (`/`, `/threads/<id>`, `/goals`, ...); the layout renders the app and reads the route from the URL. */
export default function PortalRoute() {
  return null;
}
