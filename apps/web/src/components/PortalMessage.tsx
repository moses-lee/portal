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
  Wrench,
} from "lucide-react";
import { getToolName, isToolUIPart, type UIMessagePart, type UIDataTypes, type UITools } from "ai";
import PortalMarkdown from "./PortalMarkdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { formatClock } from "@/lib/orchestrator/format";
import { TOOL_IO_OMITTED, type OrchestratorMessage } from "@/lib/orchestrator/types";
import { MessageTime } from "./ChatTime";
import { messageBubbles } from "@/lib/orchestrator/message-bubbles";

type Part = UIMessagePart<UIDataTypes, UITools>;

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  // A paged message: the row asked for the whole message when it opened; this shows until it lands.
  if (value === TOOL_IO_OMITTED)
    return (
      <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        Loading {label.toLowerCase()}…
      </p>
    );
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
function ToolRow({ part, onOpen }: { part: ToolPart; onOpen?: () => void }) {
  const name = getToolName(part);
  const { verb, tone } = describeToolState(part);
  const failed = tone === "failed";
  const reason =
    (part.state === "approval-responded" || part.state === "output-denied") && part.approval.reason;
  return (
    <Collapsible className="tool-details" onOpenChange={(open) => open && onOpen?.()}>
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

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex max-w-full items-center gap-2 rounded-lg py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Brain className="size-3.5" />
          Reasoning
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

function MessageActivity({ parts, onOpen }: { parts: Part[]; onOpen: () => void }) {
  if (parts.length === 0) return null;
  return (
    <Collapsible className="w-full max-w-[90%]" onOpenChange={(open) => { if (open) onOpen(); }}>
      <CollapsibleTrigger asChild>
        <button type="button" className="group flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
          Activity
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-1">
        {parts.map((part, index) => isToolUIPart(part)
          ? <ToolRow key={index} part={part} />
          : part.type === "reasoning" ? <Reasoning key={index} text={part.text} /> : null)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function UserMessage({ message, at, day }: { message: OrchestratorMessage; at: number; day: number }) {
  return (
    <Message align="end">
      <MessageContent className="gap-1.5">
        <Bubble variant="secondary" className="max-w-[90%]">
          <BubbleContent className="!rounded-[20px] !border-bubble-border !bg-bubble !px-4 !py-3 !text-[14px] !leading-7 whitespace-pre-wrap">
            {userText(message)}
          </BubbleContent>
        </Bubble>
        {at > 0 && <MessageFooter className="!px-2"><MessageTime at={at} day={day || at} /></MessageFooter>}
      </MessageContent>
    </Message>
  );
}

function ReplyLabel({ message }: { message: OrchestratorMessage }) {
  const tick = message.metadata?.tick;
  if (!tick) return null;
  const at = message.metadata?.at;
  return <p className="mb-1 px-2 text-[11px] text-muted-foreground">{tick.reason === "manual" ? "Manual" : "Scheduled"} check{at ? ` · ${formatClock(at)}` : ""}</p>;
}

function CurationLink({ message, onOpen }: { message: OrchestratorMessage; onOpen?: (runId: string) => void }) {
  const run = message.metadata?.run;
  if (run?.kind !== "consolidate" || !onOpen) return null;
  return (
    <button type="button" onClick={() => onOpen(run.id)} className="-mt-1 inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground hover:underline">
      <History className="size-3.5" />
      Open the digest and changes
    </button>
  );
}

/**
 * One message of the chat: bubbles of prose separated by tool use, with tool calls and reasoning
 * available in one collapsed Activity control. The chat is prose: the items
 * a message touched are not drawn under it (the Needs-you strip is where they are read and acted
 * on). Tick messages carry a "Scheduled check · 10:42" label instead of the Portal label. Each
 * message shows its time: a prompt when the server took it, a reply when it finished (nothing
 * while it streams, nor when the time is unknown).
 */
const PortalMessage = memo(function PortalMessage({
  message,
  streaming,
  day,
  onOpenCurationRun,
  onLoadToolIO,
  onNavigate,
}: {
  message: OrchestratorMessage;
  /** True while this message is still arriving. */
  streaming: boolean;
  /** Any time on the day of the day divider this message sits under; 0 before the first. */
  day: number;
  /** Set when the page can show a curation run's digest and diff (a consolidator's note links to it). */
  onOpenCurationRun?: (runId: string) => void;
  /** Asked for the whole message when a tool row of a paged message (tool traffic left out) is opened. */
  onLoadToolIO?: (messageId: string) => void;
  onNavigate?: (path: string) => void;
}) {
  const at = message.metadata?.at ?? 0;
  if (message.role === "user") return <UserMessage message={message} at={at} day={day} />;
  const tick = message.metadata?.tick;
  const bubbles = messageBubbles(message.parts);
  const activity = message.parts.filter((part) => isToolUIPart(part) || (part.type === "reasoning" && part.text));
  // The separate typing bubble is the only placeholder before text arrives.
  if (bubbles.length === 0 && activity.length === 0 && !tick) return null;
  return (
    <Message>
      <MessageContent className="gap-1.5">
        <ReplyLabel message={message} />
        {bubbles.map((bubble) => (
          <Bubble key={bubble.key} variant="muted" className="max-w-[90%]" data-agent-bubble="">
            <BubbleContent className="!rounded-[20px] !border-white/8 !bg-white/[.06] !px-4 !py-3">
              <PortalMarkdown text={bubble.text} onNavigate={onNavigate} streaming={streaming} />
            </BubbleContent>
          </Bubble>
        ))}
        <MessageActivity parts={activity} onOpen={() => {
          if (message.metadata?.toolIO === "omitted") onLoadToolIO?.(message.id);
        }} />
        {!tick && !streaming && at > 0 && <MessageFooter className="!px-2"><MessageTime at={at} day={day || at} /></MessageFooter>}
        <CurationLink message={message} onOpen={onOpenCurationRun} />
      </MessageContent>
    </Message>
  );
});

export default PortalMessage;
