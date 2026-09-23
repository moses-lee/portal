/**
 * The rules every memory record passes before it is written, whoever writes it (the user in the
 * browser, the model through a tool, the import): keys are slugs, entity keys have their type's
 * shape, a body holds one claim, no secret is ever stored, and authority follows where the claim
 * came from. Text from PRs, transcripts, files, and tool output is data: it can be observed or
 * inferred, never user-stated, and never pinned into CORE.md as a directive.
 */
import type { Authority, EntityType, MemoryRecordInput, RecordSource, RecordType } from "@portal/contracts/memory";
import { entityTypes, recordTypes } from "@portal/contracts/memory";
import { OrchestratorStoreError, normalizeScope } from "../store.ts";
import type { Scope } from "../types.ts";

export const MAX_KEY_CHARS = 80;
/** One claim: a fact, preference, or convention fits in a few sentences. */
export const MAX_BODY_CHARS = 600;
export const MAX_BODY_LINES = 4;
/** A procedure is a short sequence of steps, still about one thing. */
export const MAX_PROCEDURE_CHARS = 2000;
export const MAX_PROCEDURE_LINES = 15;
export const MAX_QUOTE_CHARS = 500;
export const MAX_SCOPE_ENTRIES = 20;

/** How far to rely on a claim, by who stands behind it. */
export const defaultTrust: Record<Authority, number> = { user_stated: 1, user_confirmed: 0.9, observed: 0.6, inferred: 0.4 };

/** Sources whose text is the user's own words, typed to Portal: the only ones a user-stated claim may rest on. */
const USER_SOURCES = new Set<RecordSource["kind"]>(["message", "ui"]);
/** Sources whose text is content (PRs, transcripts, files, command output): never a directive, even once confirmed. */
const CONTENT_SOURCES = new Set<RecordSource["kind"]>(["pull", "session", "tool"]);
const SOURCE_KINDS = new Set<RecordSource["kind"]>(["message", "session", "pull", "import", "tool", "consolidator", "ui"]);

const invalid = (message: string) => new OrchestratorStoreError(message, 400);

const KEY_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export function isRecordKey(key: string): boolean {
  return key.length <= MAX_KEY_CHARS && KEY_RE.test(key);
}

/**
 * The canonical key of an entity: logins and repos lowercased (GitHub treats them so), task types as
 * slugs, the global entity always "global". Throws 400 when the key cannot be one of its type.
 */
export function normalizeEntityKey(type: EntityType, raw: string): string {
  if (!entityTypes.includes(type)) throw invalid(`Unknown entity type "${type}"; use one of ${entityTypes.join(", ")}.`);
  const key = raw.trim();
  switch (type) {
    case "global":
      return "global";
    case "person": {
      const login = key.replace(/^@/, "").toLowerCase();
      if (!LOGIN_RE.test(login)) throw invalid(`"${raw}" is not a GitHub login.`);
      return login;
    }
    case "repo": {
      const repo = key.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
      if (!REPO_RE.test(repo)) throw invalid(`"${raw}" is not a repository as owner/name.`);
      return repo;
    }
    case "task_type": {
      const slug = key.toLowerCase().replace(/[\s_]+/g, "-");
      if (!isRecordKey(slug)) throw invalid(`"${raw}" is not a task-type slug such as code-review.`);
      return slug;
    }
    default:
      if (!ID_RE.test(key)) throw invalid(`"${raw}" is not a Portal ${type} id.`);
      return key;
  }
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

/** Formats of real credentials: provider API keys, GitHub and Slack tokens, AWS key ids, PEM blocks. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN [A-Z0-9 ]+-----/,
];

const KEY_WORD = /\b(?:api[_ -]?key|access[_ -]?key|secret|token|password|passwd|pwd|bearer|credential|credentials|auth(?:orization)?|private[_ -]?key|client[_ -]?secret)\b/i;
const LONG_TOKEN = /[A-Za-z0-9+/_=.-]{20,}/g;

/** Shannon entropy in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long token that looks random (mixed letters and digits, high entropy), unlike a path or a word. */
function looksRandom(token: string): boolean {
  if (/^[a-z]+(?:[-_.][a-z]+)*$/i.test(token) || token.includes("/")) return false;
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token) && entropy(token) >= 3.5;
}

/**
 * Why `text` looks like it carries a secret, or null. Checks the stored API keys verbatim, known
 * credential formats, and long random-looking tokens within a few words of a key-like word.
 */
export function findSecret(text: string, knownSecrets: readonly string[] = []): string | null {
  for (const secret of knownSecrets) if (secret.length >= 8 && text.includes(secret)) return "a stored API key";
  for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) return "a credential";
  for (const match of text.matchAll(LONG_TOKEN)) {
    if (!looksRandom(match[0])) continue;
    const start = match.index ?? 0;
    const around = text.slice(Math.max(0, start - 40), start + match[0].length + 20);
    if (KEY_WORD.test(around)) return "a token next to a key-like word";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export type ValidatedRecord = {
  entity: { type: EntityType; key: string; name?: string };
  type: RecordType;
  key: string;
  body: string;
  scope: Scope;
  authority: Authority;
  source: RecordSource;
  trust: number;
  pinned: boolean;
  reviewBy: number | null;
};

function checkScope(raw: unknown): Scope {
  if (raw === undefined || raw === null) return normalizeScope(undefined);
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("scope must be an object of lists.");
  const scope = raw as Record<string, unknown>;
  const strings = (name: string, check?: (value: string) => boolean) => {
    const value = scope[name];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) throw invalid(`scope.${name} must be a list of strings.`);
    if (value.length > MAX_SCOPE_ENTRIES) throw invalid(`scope.${name} has more than ${MAX_SCOPE_ENTRIES} entries.`);
    if (check) for (const entry of value) if (!check(entry)) throw invalid(`scope.${name} has an invalid entry "${entry}".`);
    return value as string[];
  };
  const pulls = scope.pulls;
  if (pulls !== undefined) {
    const ok = Array.isArray(pulls) && pulls.length <= MAX_SCOPE_ENTRIES && pulls.every((pull) => pull && typeof pull === "object"
      && typeof pull.repo === "string" && REPO_RE.test(pull.repo.toLowerCase()) && Number.isSafeInteger(pull.number) && typeof pull.url === "string");
    if (!ok) throw invalid("scope.pulls must be a list of { repo, number, url }.");
  }
  const lower = (values: string[] | undefined) => values?.map((value) => value.trim().toLowerCase());
  return normalizeScope({
    projectIds: strings("projectIds"),
    sessionIds: strings("sessionIds"),
    repos: lower(strings("repos", (value) => REPO_RE.test(value.trim().toLowerCase()))),
    people: lower(strings("people", (value) => LOGIN_RE.test(value.trim().replace(/^@/, "").toLowerCase())))?.map((login) => login.replace(/^@/, "")),
    taskTypes: lower(strings("taskTypes", (value) => isRecordKey(value.trim().toLowerCase()))),
    pulls: pulls as Scope["pulls"] | undefined,
  });
}

function checkBody(type: RecordType, raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw invalid("A record needs a body: the claim, in a sentence or two.");
  const body = raw.trim().replace(/\r\n?/g, "\n");
  const procedure = type === "procedure";
  const maxChars = procedure ? MAX_PROCEDURE_CHARS : MAX_BODY_CHARS;
  const maxLines = procedure ? MAX_PROCEDURE_LINES : MAX_BODY_LINES;
  if (body.length > maxChars) throw invalid(`The body is ${body.length} characters; a ${type} holds one claim in at most ${maxChars}. Split it into several records.`);
  const lines = body.split("\n").filter((line) => line.trim());
  if (lines.length > maxLines) throw invalid(`The body has ${lines.length} lines; a ${type} holds one claim in at most ${maxLines}. Split it into several records.`);
  if (lines.some((line) => /^\s{0,3}#{1,6}\s/.test(line))) throw invalid("A body has no headings: one claim per record.");
  if (!procedure && lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line)).length > 1) {
    throw invalid("A list of points is several claims: make one record per point (only a procedure may list steps).");
  }
  return body;
}

function checkSource(raw: unknown): RecordSource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("A record needs a source: where the claim came from.");
  const source = raw as RecordSource;
  if (!SOURCE_KINDS.has(source.kind)) throw invalid(`Unknown source kind "${String(source.kind)}".`);
  const result: RecordSource = { kind: source.kind };
  for (const field of ["threadId", "messageId", "sessionId", "runId", "url", "quote"] as const) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw invalid(`source.${field} must be a string.`);
    if (value.trim()) result[field] = value.trim();
  }
  if (result.quote && result.quote.length > MAX_QUOTE_CHARS) throw invalid(`source.quote is longer than ${MAX_QUOTE_CHARS} characters; quote only the words the claim rests on.`);
  if (source.pull !== undefined) {
    const pull = source.pull;
    if (!pull || typeof pull.repo !== "string" || !Number.isSafeInteger(pull.number) || typeof pull.url !== "string") throw invalid("source.pull must be { repo, number, url }.");
    result.pull = { repo: pull.repo, number: pull.number, url: pull.url };
  }
  return result;
}

/**
 * The record as it will be written, or a 400 naming the first rule it breaks. `knownSecrets` are
 * the API keys the settings hold, checked verbatim.
 */
export function validateRecord(input: MemoryRecordInput & { authority: Authority }, { knownSecrets = [] }: { knownSecrets?: readonly string[] } = {}): ValidatedRecord {
  if (!input || typeof input !== "object") throw invalid("Expected a record.");
  const entityInput = input.entity;
  if (!entityInput || typeof entityInput !== "object" || typeof entityInput.key !== "string") throw invalid("A record needs an entity { type, key }.");
  const entityKey = normalizeEntityKey(entityInput.type, entityInput.type === "global" ? "global" : entityInput.key);
  const name = typeof entityInput.name === "string" && entityInput.name.trim() ? entityInput.name.trim().slice(0, 120) : undefined;
  if (!recordTypes.includes(input.type)) throw invalid(`Unknown record type "${String(input.type)}"; use one of ${recordTypes.join(", ")}.`);
  const key = typeof input.key === "string" ? input.key.trim().toLowerCase() : "";
  if (!isRecordKey(key)) {
    throw invalid(`"${String(input.key)}" is not a record key: lowercase words joined by "-", "_" or ".", at most ${MAX_KEY_CHARS} characters (e.g. review-style, preferred-model.code-review).`);
  }
  const body = checkBody(input.type, input.body);
  const scope = checkScope(input.scope);
  const authority = input.authority;
  if (!(authority in defaultTrust)) throw invalid(`Unknown authority "${String(authority)}".`);
  const source = checkSource(input.source ?? { kind: "ui" });
  if (authority === "user_stated" && !USER_SOURCES.has(source.kind)) {
    throw invalid(`A claim from a ${source.kind} source is not the user's own statement: propose it instead.`);
  }
  const pinned = input.pinned === true;
  if (pinned && authority !== "user_stated" && authority !== "user_confirmed") throw invalid("Only claims the user stated or confirmed can be pinned.");
  if (pinned && CONTENT_SOURCES.has(source.kind)) throw invalid(`A claim from a ${source.kind} is data, never a pinned directive.`);
  const reviewBy = input.reviewBy ?? null;
  if (reviewBy !== null && !Number.isSafeInteger(reviewBy)) throw invalid("reviewBy must be a time in epoch milliseconds, or null.");
  const secret = findSecret([key, body, source.quote ?? "", name ?? ""].join("\n"), knownSecrets);
  if (secret) throw invalid(`This looks like it holds ${secret}. Memory never stores secrets; leave them in Settings or the environment.`);
  return {
    entity: { type: entityInput.type, key: entityKey, ...(name ? { name } : {}) },
    type: input.type, key, body, scope, authority, source, trust: defaultTrust[authority], pinned, reviewBy,
  };
}

/** Whether a claim from `source` may be pinned once the user confirms it (content never may). */
export function canPin(authority: Authority, source: RecordSource): boolean {
  return (authority === "user_stated" || authority === "user_confirmed") && !CONTENT_SOURCES.has(source.kind);
}
