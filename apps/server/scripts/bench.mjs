/**
 * Sizes and times the endpoints the perf plan tracks, raw and gzipped, against a running server.
 *
 *   pnpm --filter @portal/server bench [--base http://127.0.0.1:3100] [--sessions id1,id2]
 *
 * Without `--sessions` the three largest sessions by event count are picked from `/api/sessions`
 * plus the newest one. Prints a Markdown table; paste it into the PR next to the baseline.
 */
import { request } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: process.env.PORTAL_BENCH_BASE ?? "http://127.0.0.1:3100" },
    sessions: { type: "string" },
    runs: { type: "string", default: "3" },
  },
});
const base = values.base.replace(/\/$/, "");
const runs = Math.max(1, Number(values.runs) || 3);

/** One GET over plain http, so the bytes on the wire are counted as sent (fetch would inflate gzip on the way in). */
function get(url, encoding) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { "accept-encoding": encoding } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), encoding: res.headers["content-encoding"] ?? "identity" }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function measure(path, { gzip = false } = {}) {
  let best = Infinity;
  let bytes = 0;
  let status = 0;
  let count = null;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const r = await get(`${base}${path}`, gzip ? "gzip" : "identity");
    const elapsed = performance.now() - started;
    best = Math.min(best, elapsed);
    bytes = r.body.length;
    status = r.status;
    if (!gzip && r.status === 200 && count === null) {
      try {
        const json = JSON.parse(r.body.toString("utf8"));
        const list = json.events ?? json.messages ?? json.sessions ?? json.items ?? json.entries;
        if (Array.isArray(list)) count = list.length;
      } catch {
        // Not JSON; leave the count blank.
      }
    }
  }
  return { status, bytes, ms: best, count };
}

const kb = (n) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

async function pickSessions() {
  if (values.sessions) return values.sessions.split(",").map((s) => s.trim()).filter(Boolean);
  const r = await fetch(`${base}/api/sessions`);
  if (!r.ok) throw new Error(`GET /api/sessions -> ${r.status}`);
  const { sessions } = await r.json();
  // Event counts are not in the list; approximate "largest" by the newest three and the oldest one.
  const byAge = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return [...new Set([...byAge.slice(0, 3), byAge.at(-1)].filter(Boolean).map((s) => s.id))];
}

const rows = [];
async function row(label, path) {
  const raw = await measure(path);
  const gz = await measure(path, { gzip: true });
  rows.push([label, raw.status, raw.count ?? "", kb(raw.bytes), kb(gz.bytes), `${raw.ms.toFixed(0)} ms`]);
}

await row("GET /api/sessions", "/api/sessions");
await row("GET /api/projects", "/api/projects");
await row("GET /api/portal", "/api/portal");
await row("GET /api/portal/messages", "/api/portal/messages");
await row("GET /api/portal/items", "/api/portal/items");
await row("GET /api/portal/activity", "/api/portal/activity");
for (const id of await pickSessions()) {
  const short = id.slice(0, 8);
  await row(`events ${short} (default page)`, `/api/sessions/${encodeURIComponent(id)}/events`);
  await row(`events ${short} (turns=3)`, `/api/sessions/${encodeURIComponent(id)}/events?turns=3`);
}

const header = ["Endpoint", "Status", "Items", "Raw", "Gzip", `Best of ${runs}`];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ")} |`;
console.log(line(header));
console.log(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
for (const r of rows) console.log(line(r));
