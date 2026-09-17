import { createFileSessionStore } from "./file-session-store.ts";
import type { SessionStore } from "./session-store.ts";

// Keep the file handles and loaded index alive across Next.js dev HMR, as projects.ts does.
const globals = globalThis as unknown as { __portalSessionStore?: SessionStore };
export const sessionStore: SessionStore = (globals.__portalSessionStore ??= createFileSessionStore());
