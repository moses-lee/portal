/**
 * Postgres cannot store U+0000: `text` columns reject the byte and `jsonb` rejects the `\u0000`
 * escape. Agent output can hold it (`cat` on a binary, `find -print0`, a pasted terminal transcript),
 * and so could the legacy JSON files, so every value headed for the database passes through here
 * first: the importer and the live stores alike. Object keys are cleaned too.
 */
export function stripNul<T>(value: T): T {
  return clean(value) as T;
}

function clean(value: unknown): unknown {
  if (typeof value === "string") return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
  if (Array.isArray(value)) return value.map(clean);
  // fromEntries defines own properties, so a parsed "__proto__" key stays data instead of setting the prototype.
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [clean(key), clean(entry)]));
  return value;
}
