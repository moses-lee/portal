"use client";

import { Button } from "@/components/ui/button";
import { Check, ShieldQuestion, Sparkles } from "lucide-react";
import { useState } from "react";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { PermissionBlock } from "@/lib/transcript";

export type { PermissionBlock, PermissionResponse } from "@/lib/transcript";

const PREVIEW_LIMIT = 400;

const optionClass: Record<PermissionOption["kind"], string> = {
  allow_once: "bg-primary text-primary-foreground hover:bg-primary/90",
  allow_always: "bg-white/5 text-foreground hover:bg-white/10",
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
  const shown =
    expanded || !truncated ? full : full.slice(0, PREVIEW_LIMIT) + "…";
  return (
    <div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 text-[11px] text-zinc-400">
        {shown}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          {expanded
            ? "Show less"
            : `Show all (${full.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

/** "Allowed once by you", "Allowed once by Portal": who answered is part of the record. */
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
  const who = r.by === "portal" ? " by Portal" : r.by === "user" ? " by you" : "";
  return `${verdict}${who}${verdict === r.optionName ? "" : ` · ${r.optionName}`}`;
}

const answeredByPortal = (b: PermissionBlock) => b.response?.outcome === "selected" && b.response.by === "portal";

/** A permission request from the agent, rendered inline right after the tool call it concerns. */
export default function PermissionCard({
  b,
  onAnswer,
}: {
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
      setError(
        e instanceof Error
          ? e.message
          : "Could not send the answer. Try again.",
      );
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Permission request: ${title}`}
      data-answered-by={b.response?.outcome === "selected" ? b.response.by ?? "user" : undefined}
      className={`my-1 rounded-2xl border text-sm ${answered ? (answeredByPortal(b) ? "border-sky-300/15 bg-sky-300/[.03]" : "border-white/5 bg-white/[.015]") : "border-amber-300/20 bg-amber-300/[.035]"}`}
    >
      <div className="flex items-start gap-3 p-4">
        {answered ? (
          answeredByPortal(b) ? (
            <Sparkles className="mt-0.5 size-4 shrink-0 text-sky-200" />
          ) : (
            <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )
        ) : (
          <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-200" />
        )}
        <div className="min-w-0 flex-1">
          <p className={`mb-1 text-xs font-medium ${answeredByPortal(b) ? "text-sky-200/90" : "text-muted-foreground"}`}>
            {answered ? describeResponse(b) : "Your approval is needed"}
          </p>
          <p className="break-words text-sm leading-relaxed">{title}</p>
          {b.response?.outcome === "selected" && b.response.reason && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{b.response.reason}</p>
          )}
        </div>
      </div>
      {!answered && (
        <div className="space-y-3 border-t border-white/5 p-4">
          {b.toolCall.rawInput !== undefined &&
            b.toolCall.rawInput !== null && (
              <RawInputPreview rawInput={b.toolCall.rawInput} />
            )}
          <div className="flex flex-wrap items-center gap-2">
            {b.options.map((o) => (
              <Button
                key={o.optionId}
                type="button"
                disabled={inFlight}
                onClick={() => void answer(o.optionId)}
                className={`rounded px-3 py-1 text-xs font-medium disabled:opacity-50 ${optionClass[o.kind] ?? optionClass.reject_once}`}
              >
                {o.name}
              </Button>
            ))}
            <span className="text-[11px] text-zinc-500" aria-live="polite">
              {inFlight ? "Sending…" : "Waiting for your answer"}
            </span>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
