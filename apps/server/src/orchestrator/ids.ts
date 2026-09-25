/**
 * Session and project ids as the model hands them back. The World section shows `SHORT_ID`-char
 * prefixes, so whatever takes an id also takes a unique prefix of one, and what is stored (scopes,
 * item links) holds the full id. One strict rule everywhere: the exact id, else the only id that
 * starts with the query (case-insensitive, at least `MIN_ID_PREFIX` characters). No match and
 * several matches are different errors; titles and names never count here (resolve_session does that).
 */
import type { ItemAction, ItemLinks, Scope } from "@portal/contracts/orchestrator";
import type { OrchestratorDeps } from "./deps.ts";

/** Shortest prefix that counts as a reference; shorter ones match too much by chance. */
export const MIN_ID_PREFIX = 4;
/** Candidates an ambiguity error names. */
const MAX_NAMED = 5;

export type IdKind = "session" | "project";

const lookupHint: Record<IdKind, string> = { session: "use resolve_session", project: "use resolve_repo or list_projects" };

/** The item with id `query`, else the only one whose id starts with it; `candidates` holds every prefix match (none, or several, when `match` is null). */
export function matchId<T extends { id: string }>(items: readonly T[], query: string): { match: T | null; candidates: T[] } {
  const q = query.trim();
  const exact = items.find((item) => item.id === q);
  if (exact) return { match: exact, candidates: [exact] };
  if (q.length < MIN_ID_PREFIX) return { match: null, candidates: [] };
  const lower = q.toLowerCase();
  const hits = items.filter((item) => item.id.toLowerCase().startsWith(lower));
  return { match: hits.length === 1 ? hits[0] : null, candidates: hits };
}

/** `matchId`'s single answer or undefined, for display and matching where a miss only shows less. */
export const findById = <T extends { id: string }>(items: readonly T[], query: string): T | undefined => matchId(items, query).match ?? undefined;

/** Whether `ref` (a stored id, maybe an older prefix) names the full id `id`. */
export const idMatches = (ref: string, id: string) => ref === id || (ref.length >= MIN_ID_PREFIX && id.toLowerCase().startsWith(ref.toLowerCase()));

/**
 * `matchId`'s answer, or an error (with an HTTP `status`, as `httpError` makes; ops.ts imports this
 * module) saying whether nothing or several matched, the latter by full id and `label`. `where`
 * names the offending field in the message.
 */
export function pickById<T extends { id: string }>(items: readonly T[], query: string, kind: IdKind, label: (item: T) => string | null | undefined, where?: string): T {
  const { match, candidates } = matchId(items, query);
  if (match) return match;
  const q = query.trim();
  const at = where ? `${where}: ` : "";
  if (candidates.length > 1) {
    const named = candidates.slice(0, MAX_NAMED).map((item) => (label(item) ? `${item.id} ("${label(item)}")` : item.id));
    const more = candidates.length > MAX_NAMED ? `, +${candidates.length - MAX_NAMED} more` : "";
    throw Object.assign(new Error(`${at}Id "${q}" is ambiguous: ${candidates.length} ${kind}s start with it: ${named.join(", ")}${more}. Pass the full id.`), { status: 409 });
  }
  const short = q.length < MIN_ID_PREFIX ? ` of at least ${MIN_ID_PREFIX} characters` : "";
  throw Object.assign(new Error(`${at}No ${kind} has id "${q}". Ids in the World section are prefixes; pass one${short} that is unique or the full id, or ${lookupHint[kind]}.`), { status: 404 });
}

export type KnownIds = { sessions: readonly { id: string; title?: string | null }[]; projects: readonly { id: string; name?: string }[] };

/** The full id of the session or project `id` names among `known`; see `pickById`. */
export function fullId(known: KnownIds, kind: IdKind, id: string, where?: string): string {
  return kind === "session" ? pickById(known.sessions, id, kind, (s) => s.title, where).id : pickById(known.projects, id, kind, (p) => p.name, where).id;
}

/** Every session and project Portal lists now, to resolve ids against. */
export async function knownIds(deps: Pick<OrchestratorDeps, "sessions" | "projects">): Promise<KnownIds> {
  const [sessions, projects] = await Promise.all([deps.sessions.list(), deps.projects.list()]);
  return { sessions, projects };
}

/**
 * `scope` with each session and project id made full by `pickById`; throws naming the first id that
 * matches nothing or several. Ids already in `keep` (what was stored before) pass as they are when
 * they no longer resolve, so an old scope never blocks an unrelated change.
 */
export function canonicalScope<S extends Partial<Scope>>(scope: S, known: KnownIds, keep?: Partial<Scope>): S {
  const full = (ids: string[] | undefined, kind: IdKind, kept: string[] | undefined) =>
    ids?.map((id) => (kept?.includes(id) ? expandId(known, kind, id) : fullId(known, kind, id, `scope.${kind}Ids`)));
  return {
    ...scope,
    ...(scope.sessionIds ? { sessionIds: full(scope.sessionIds, "session", keep?.sessionIds) } : {}),
    ...(scope.projectIds ? { projectIds: full(scope.projectIds, "project", keep?.projectIds) } : {}),
  };
}

/** The full id `id` uniquely prefixes among `known`, else `id` as it is: for what was stored before ids were kept full. */
export function expandId(known: KnownIds, kind: IdKind, id: string): string {
  return findById<{ id: string }>(kind === "session" ? known.sessions : known.projects, id)?.id ?? id;
}

type Refs = { links?: ItemLinks; actions?: ItemAction[] };

/** Item `links` and `actions` with each session and project id passed through `full` (told which field it is, for its errors). */
export function mapRefs({ links, actions }: Refs, full: (kind: IdKind, id: string, where: string) => string): Refs {
  return {
    ...(links ? {
      links: {
        ...links, ...(links.sessionId ? { sessionId: full("session", links.sessionId, "links.sessionId") } : {}),
        ...(links.projectId ? { projectId: full("project", links.projectId, "links.projectId") } : {}),
      },
    } : {}),
    ...(actions ? {
      actions: actions.map((action, i) => ("sessionId" in action ? { ...action, sessionId: full("session", action.sessionId, `actions[${i}].sessionId`) }
        : "projectId" in action ? { ...action, projectId: full("project", action.projectId, `actions[${i}].projectId`) } : action)),
    } : {}),
  };
}

/** `scope` with every id that uniquely prefixes a known one expanded (the rest untouched), and whether anything changed. */
export function expandScope(scope: Scope, known: KnownIds): { scope: Scope; changed: boolean } {
  const sessionIds = scope.sessionIds.map((id) => expandId(known, "session", id));
  const projectIds = scope.projectIds.map((id) => expandId(known, "project", id));
  const changed = sessionIds.some((id, i) => id !== scope.sessionIds[i]) || projectIds.some((id, i) => id !== scope.projectIds[i]);
  return { scope: changed ? { ...scope, sessionIds, projectIds } : scope, changed };
}
