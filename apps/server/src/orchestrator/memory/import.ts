/**
 * The one-time import of the legacy memory text (the Markdown notes phase 1 kept as a single
 * document). `splitLegacyMemory` turns it into claims deterministically: each bullet is one, each
 * run of plain lines is one paragraph (long ones cut at sentence ends), and headings are context
 * that prefixes the claim and its key. The claims land in the inbox as observed records under the
 * global entity, quoting the line they came from, so the user approves each one. The legacy text
 * itself is left as it was, for audit.
 */
import type { RecordType } from "@portal/contracts/memory";
import { MAX_BODY_CHARS, MAX_KEY_CHARS, MAX_QUOTE_CHARS } from "./validate.ts";

export type LegacyClaim = { key: string; type: RecordType; body: string; quote: string; heading: string | null };

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const TRUNCATION = /^\[Portal truncated this file/;

function slug(text: string, words = 6): string {
  return text.toLowerCase().replace(/[`*_~[\]()]/g, "").split(/[^a-z0-9]+/).filter(Boolean).slice(0, words).join("-");
}

/** Cut text at sentence ends into pieces that each fit one record. */
function sentences(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [text]) {
    if (current && current.length + sentence.length > max) {
      pieces.push(current.trim());
      current = "";
    }
    current += sentence;
    while (current.length > max) {
      pieces.push(current.slice(0, max).trim());
      current = current.slice(max);
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

const PREFERENCE = /\b(?:prefer|prefers|preferred|like|likes|want|wants|always|never|don't|do not|avoid)\b/i;

/**
 * The claims in `text`, in order. `takenKeys` are keys already used on the global entity; every key
 * returned is unique among them and each other.
 */
export function splitLegacyMemory(text: string, takenKeys: Iterable<string> = []): LegacyClaim[] {
  const blocks: { text: string; quote: string; heading: string | null }[] = [];
  let heading: string | null = null;
  let paragraph: string[] = [];
  let bullet: string[] | null = null;
  const flush = () => {
    if (bullet) blocks.push({ text: bullet.join(" "), quote: bullet.join("\n"), heading });
    if (paragraph.length) blocks.push({ text: paragraph.join(" "), quote: paragraph.join("\n"), heading });
    bullet = null;
    paragraph = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || FENCE.test(line) || TRUNCATION.test(line)) {
      flush();
      continue;
    }
    const title = HEADING.exec(raw);
    if (title) {
      flush();
      heading = title[1].trim() || null;
      continue;
    }
    const item = BULLET.exec(raw);
    if (item) {
      flush();
      bullet = [item[1].trim()];
      continue;
    }
    // An indented line under a bullet continues it; anything else is paragraph text.
    if (bullet && /^\s+/.test(raw)) bullet.push(line);
    else {
      if (bullet) flush();
      paragraph.push(line);
    }
  }
  flush();

  const taken = new Set(takenKeys);
  const claims: LegacyClaim[] = [];
  for (const block of blocks) {
    const prefix = block.heading ? `${block.heading}: ` : "";
    for (const piece of sentences(block.text, MAX_BODY_CHARS - prefix.length)) {
      const base = [block.heading ? slug(block.heading, 3) : "", slug(piece)].filter(Boolean).join(".").slice(0, MAX_KEY_CHARS - 4).replace(/[-.]+$/, "") || "note";
      let key = base;
      for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
      taken.add(key);
      claims.push({
        key, type: PREFERENCE.test(piece) ? "preference" : "fact", body: `${prefix}${piece}`,
        quote: block.quote.slice(0, MAX_QUOTE_CHARS), heading: block.heading,
      });
    }
  }
  return claims;
}
