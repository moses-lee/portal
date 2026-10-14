import { MAIN_THREAD_ID } from "./types";

/** Drafts and prompt history share a stable key per Agent thread. */
export const threadDraftKey = (threadId: string) =>
  threadId === MAIN_THREAD_ID ? "portal:orchestrator" : `portal:orchestrator:${threadId}`;
