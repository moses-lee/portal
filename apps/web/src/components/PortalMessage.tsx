"use client";

import { memo, useState } from "react";
import {
  Ban,
  Brain,
  ChevronDown,
  CircleAlert,
  History,
  LoaderCircle,
  ShieldQuestion,
  Sparkles,
  Wrench,
} from "lucide-react";
import { getToolName, isToolUIPart, type UIMessagePart, type UIDataTypes, type UITools } from "ai";
import PortalItemCard, { type ItemCardHandlers } from "./PortalItemCard";
import PortalMarkdown from "./PortalMarkdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Message, MessageContent } from "@/components/ui/message";
import type { Item, OrchestratorMessage } from "@/lib/orchestrator/types";

type Part = UIMessagePart<UIDataTypes, UITools>;

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </p>
      <pre className="max-h-60 overflow-auto rounded-lg bg-black/15 p-3 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

type ToolPart = Extract<Part, { type: `tool-${string}` | "dynamic-tool" }>;

/** The row's verb for each tool state, and how to draw it. Approval states come from tools that need consent before running. */
function describeToolState(part: ToolPart): { verb: string; tone: "running" | "failed" | "waiting" | "denied" | "done" } {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return { verb: "Running", tone: "running" };
    case "approval-requested":
      return { verb: "Waiting for approval to run", tone: "waiting" };
    case "approval-responded":
      return part.approval.approved
        ? { verb: "Approved", tone: "running" }
        : { verb: "Declined", tone: "denied" };
    case "output-denied":
      return { verb: "Denied", tone: "denied" };
    case "output-error":
      return { verb: "Failed", tone: "failed" };
    default:
      return { verb: "Ran", tone: "done" };
  }
}

/** One tool call as a one-line row ("Ran get_tick_digest") that expands to its input and output. */
function ToolRow({ part }: { part: ToolPart }) {
  const name = getToolName(part);
  const { verb, tone } = describeToolState(part);
  const failed = tone === "failed";
  const reason =
    (part.state === "approval-responded" || part.state === "output-denied") && part.approval.reason;
  return (
    <Collapsible className="tool-details">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-xs"
        >
          {tone === "running" ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : failed ? (
            <CircleAlert className="size-3.5 shrink-0 text-destructive" />
          ) : tone === "waiting" ? (
            <ShieldQuestion className="size-3.5 shrink-0 text-amber-300" />
          ) : tone === "denied" ? (
            <Ban className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {verb} <code className="font-mono text-[11px]">{name}</code>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-white/5 p-3">
          <Json label="Input" value={part.input} />
          {reason && <p className="text-xs leading-relaxed text-muted-foreground">{reason}</p>}
          {failed ? (
            <p className="text-xs leading-relaxed text-destructive">{part.errorText}</p>
          ) : (
            <Json label="Output" value={part.output} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex max-w-full items-center gap-2 rounded-lg py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {streaming ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Brain className="size-3.5" />
          )}
          {streaming ? "Thinking" : "Reasoning"}
          <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 border-l border-white/10 pl-3 text-xs leading-6 whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function userText(message: OrchestratorMessage) {
  return message.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * One message of the thread: the user's bubble, or the orchestrator's reply with its text through
 * Markdown, reasoning folded away, tool calls as compact rows, and cards for the items it touched.
 * Every touched item still known to the page gets a card, settled ones dimmed, so the thread reads
 * as a record of what happened. Tick messages carry a "Scheduled check · 10:42" label instead of
 * the Portal label.
 */
const PortalMessage = memo(function PortalMessage({
  message,
  items,
  streaming,
  handlers,
}: {
  message: OrchestratorMessage;
  items: ReadonlyMap<string, Item>;
  /** True while this message is still arriving. */
  streaming: boolean;
  handlers: ItemCardHandlers;
}) {
  if (message.role === "user") {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary" className="max-w-[90%]">
            <BubbleContent className="!rounded-[20px] !border-white/5 !bg-[#252b3e]/70 !px-4 !py-3 !text-[14px] !leading-7 whitespace-pre-wrap">
              {userText(message)}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }
  const tick = message.metadata?.tick;
  const at = message.metadata?.at;
  const run = message.metadata?.run;
  const curationRun = run?.kind === "consolidate" && handlers.onOpenCurationRun ? run.id : null;
  const cards = (message.metadata?.itemIds ?? [])
    .map((id) => items.get(id))
    .filter((item): item is Item => !!item);
  return (
    <Message>
      <MessageContent className="gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Sparkles className="size-3.5" />
          {tick
            ? `${tick.reason === "manual" ? "Manual" : "Scheduled"} check${at ? ` · ${formatTime(at)}` : ""}`
            : "Portal"}
        </div>
        {message.parts.map((part, index) => {
          if (part.type === "text")
            return part.text ? <PortalMarkdown key={index} text={part.text} /> : null;
          if (part.type === "reasoning")
            return part.text ? (
              <Reasoning
                key={index}
                text={part.text}
                streaming={streaming && part.state === "streaming"}
              />
            ) : null;
          if (isToolUIPart(part)) return <ToolRow key={index} part={part} />;
          return null;
        })}
        {curationRun && (
          <button
            type="button"
            onClick={() => handlers.onOpenCurationRun?.(curationRun)}
            className="-mt-1 inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            <History className="size-3.5" />
            Open the digest and changes
          </button>
        )}
        {cards.length > 0 && (
          <div className="mt-1 space-y-2.5">
            {cards.map((item) => (
              <PortalItemCard key={item.id} item={item} {...handlers} />
            ))}
          </div>
        )}
      </MessageContent>
    </Message>
  );
});

export default PortalMessage;
