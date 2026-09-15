"use client";

import { useState } from "react";
import type { PermissionOption, ToolCallUpdate } from "@agentclientprotocol/sdk";

export type PermissionResponse =
  | { outcome: "selected"; optionId: string; optionName: string }
  | { outcome: "cancelled" };

export type PermissionBlock = {
  kind: "permission";
  requestId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  response: PermissionResponse | null;
};

const PREVIEW_LIMIT = 400;

const optionClass: Record<PermissionOption["kind"], string> = {
  allow_once: "bg-indigo-600 text-white hover:bg-indigo-500",
  allow_always: "bg-emerald-700 text-white hover:bg-emerald-600",
  reject_once: "border border-zinc-600 text-zinc-300 hover:bg-zinc-800",
  reject_always: "border border-red-800 text-red-300 hover:bg-red-950/60",
};

function formatInput(rawInput: unknown) {
  if (typeof rawInput === "string") return rawInput;
  try {
    return JSON.stringify(rawInput, null, 2) ?? String(rawInput);
  } catch {
    return String(rawInput);
  }
}

function RawInputPreview({ rawInput }: { rawInput: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const full = formatInput(rawInput);
  const truncated = full.length > PREVIEW_LIMIT;
  const shown = expanded || !truncated ? full : full.slice(0, PREVIEW_LIMIT) + "…";
  return (
    <div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 text-[11px] text-zinc-400">{shown}</pre>
      {truncated && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-1 text-[11px] text-zinc-500 hover:text-zinc-300">
          {expanded ? "Show less" : `Show all (${full.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function describeResponse(b: PermissionBlock) {
  const r = b.response;
  if (!r) return "";
  if (r.outcome === "cancelled") return "Cancelled";
  const option = b.options.find((o) => o.optionId === r.optionId);
  const kindLabel: Record<PermissionOption["kind"], string> = {
    allow_once: "Allowed once",
    allow_always: "Allowed always",
    reject_once: "Rejected once",
    reject_always: "Rejected always",
  };
  const verdict = option ? kindLabel[option.kind] : "Answered";
  return verdict === r.optionName ? verdict : `${verdict} · ${r.optionName}`;
}

/** A permission request from the agent, rendered inline right after the tool call it concerns. */
export default function PermissionCard({ b, onAnswer }: {
  b: PermissionBlock;
  /** Resolves when the server accepted the answer; rejects with a message to show otherwise. */
  onAnswer: (requestId: string, optionId: string) => Promise<void>;
}) {
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = b.toolCall.title || "Tool call";
  const answered = b.response !== null;

  const answer = async (optionId: string) => {
    if (inFlight || answered) return;
    setInFlight(true);
    setError(null);
    try {
      await onAnswer(b.requestId, optionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the answer. Try again.");
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Permission request: ${title}`}
      className={`my-1 rounded-lg border text-sm ${answered ? "border-zinc-800 bg-zinc-900/40" : "border-amber-700/60 bg-amber-950/20"}`}
    >
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs text-zinc-300">
        <span className={answered ? "text-zinc-600" : "text-amber-400"} aria-hidden="true">{answered ? "●" : "?"}</span>
        <span className="text-zinc-500">{b.toolCall.kind ?? "tool"}</span>
        <span className="truncate">{title}</span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-500">{answered ? describeResponse(b) : "permission"}</span>
      </div>
      {!answered && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2">
          {b.toolCall.rawInput !== undefined && b.toolCall.rawInput !== null && <RawInputPreview rawInput={b.toolCall.rawInput} />}
          <div className="flex flex-wrap items-center gap-2">
            {b.options.map((o) => (
              <button
                key={o.optionId}
                type="button"
                disabled={inFlight}
                onClick={() => void answer(o.optionId)}
                className={`rounded px-3 py-1 text-xs font-medium disabled:opacity-50 ${optionClass[o.kind] ?? optionClass.reject_once}`}
              >
                {o.name}
              </button>
            ))}
            <span className="text-[11px] text-zinc-500" aria-live="polite">
              {inFlight ? "Sending…" : "Waiting for your answer"}
            </span>
          </div>
          {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        </div>
      )}
    </div>
  );
}
