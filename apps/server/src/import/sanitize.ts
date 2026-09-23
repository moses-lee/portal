/**
 * Postgres cannot store U+0000: `text` columns reject the byte and `jsonb` rejects the `\u0000`
 * escape. The legacy JSON files could hold it (a pasted terminal transcript, a tool's raw output),
 * so every value headed for the database passes through here first. Object keys are cleaned too.
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
