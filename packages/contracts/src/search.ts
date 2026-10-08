/**
 * Global search (`GET /api/search?q=`). See docs/SEARCH.md.
 *
 * The client matches sessions and projects itself from the lists it already holds; the server
 * answers only what the client cannot: message text hits and sessions associated with a pull
 * request named by the query (number, `repo#number`, or words of its title).
 */
import type { PullRef } from "./orchestrator.ts";

/** One prompt or reply whose text contains the query. */
export type SearchMessageHit = {
  sessionId: string;
  /** The event's seq in the session log. */
  seq: number;
  role: "user" | "agent";
  /** Epoch ms. */
  ts: number;
  /** A window of the text around the first match; the query itself is in it, case-insensitive. */
  snippet: string;
};

/** A session found through a pull request. */
export type SearchPullHit = {
  sessionId: string;
  pull: PullRef & { title?: string };
  /** How the session and the PR are linked. */
  via: "branch" | "title" | "item";
};

export type SearchResponse = {
  q: string;
  messages: SearchMessageHit[];
  pulls: SearchPullHit[];
};
