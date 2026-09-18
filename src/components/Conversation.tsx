"use client";

import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  LoaderCircle,
  Workflow,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Message,
  MessageContent,
  MessageFooter,
} from "@/components/ui/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import AgentLogo from "./AgentLogo";
import CopyButton from "./CopyButton";
import PermissionCard from "./PermissionCard";
import type { Block, History, ToolBlock, Turn } from "@/lib/transcript";

function textContent(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textContent(child.props.children)
        : typeof child === "string" || typeof child === "number"
          ? String(child)
          : "",
    )
    .join("");
}

function CodeBlock({ children }: ComponentProps<"pre">) {
  const child = Children.toArray(children)[0];
  const language = isValidElement<{ className?: string }>(child)
    ? /language-([\w+-]+)/.exec(child.props.className ?? "")?.[1]
    : undefined;
  return (
    <div className="code-block">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">
          {language ?? "Code"}
        </span>
        <CopyButton
          text={textContent(children)}
          label="Copy code"
          className="text-muted-foreground"
        />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const markdownComponents = {
  pre: CodeBlock,
  a: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="conversation-markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function DiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
}) {
  const changes = useMemo(
    () =>
      (oldText?.length ?? 0) + newText.length > 300_000
        ? undefined
        : diffLines(oldText ?? "", newText, {
            timeout: 30,
            maxEditLength: 1500,
          }),
    [oldText, newText],
  );
  return (
    <div className="overflow-hidden rounded-lg border border-white/5">
      <div className="break-all border-b border-white/5 px-3 py-2 font-mono text-xs text-muted-foreground">
        {path}
      </div>
      {changes ? (
        <pre className="max-h-96 overflow-auto py-2 text-[11px] leading-6">
          {changes.map((change, i) => (
            <span
              key={i}
              className={`block min-w-max px-3 ${change.added ? "bg-emerald-400/5 text-emerald-200" : change.removed ? "bg-rose-400/5 text-rose-200" : "text-muted-foreground"}`}
            >
              {change.value
                .replace(/\n$/, "")
                .split("\n")
                .map((line, index) => (
                  <span key={index} className="block">
                    <span
                      className="mr-3 select-none opacity-50"
                      aria-hidden="true"
                    >
                      {change.added ? "+" : change.removed ? "−" : " "}
                    </span>
                    {line || " "}
                  </span>
                ))}
            </span>
          ))}
        </pre>
      ) : (
        <div className="space-y-3 p-3 text-xs">
          <p className="text-muted-foreground">
            Large change — showing full versions.
          </p>
          <p>Before</p>
          <pre className="max-h-64 overflow-auto">{oldText ?? "New file"}</pre>
          <p>After</p>
          <pre className="max-h-64 overflow-auto">{newText}</pre>
        </div>
      )}
    </div>
  );
}

function ToolStatus({ status }: { status?: string | null }) {
  if (status === "completed")
    return (
      <Check
        className="size-3.5 shrink-0 text-emerald-300/70"
        aria-label="Completed"
      />
    );
  if (status === "failed")
    return (
      <CircleAlert
        className="size-3.5 shrink-0 text-destructive"
        aria-label="Failed"
      />
    );
  if (status === "in_progress")
    return (
      <LoaderCircle
        className="size-3.5 shrink-0 animate-spin text-indigo-200"
        aria-label="In progress"
      />
    );
  return (
    <Circle
      className="size-3 shrink-0 text-muted-foreground"
      aria-label="Pending"
    />
  );
}

function ToolCard({ block }: { block: ToolBlock }) {
  const text = block.content.filter((item) => item.type === "content");
  return (
    <Collapsible className="tool-details">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full min-w-0 items-start gap-2.5 p-3 text-left text-xs"
        >
          <ToolStatus status={block.status} />
          <span className="min-w-0 flex-1 break-words leading-relaxed">
            {block.title}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-white/5 p-3">
          {block.rawInput !== undefined && (
            <div>
              <p className="mb-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Input
              </p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/15 p-3 text-[11px] leading-relaxed text-muted-foreground">
                {typeof block.rawInput === "string"
                  ? block.rawInput
                  : JSON.stringify(block.rawInput, null, 2)}
              </pre>
            </div>
          )}
          {block.content
            .filter((item) => item.type === "diff")
            .map((item, i) => (
              <DiffView
                key={i}
                path={item.path}
                oldText={item.oldText}
                newText={item.newText}
              />
            ))}
          {text.map((item, i) =>
            item.content.type === "text" ? (
              <pre
                key={i}
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/15 p-3 text-[11px] leading-relaxed"
              >
                {item.content.text}
              </pre>
            ) : null,
          )}
          {block.rawOutput !== undefined && text.length === 0 && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/15 p-3 text-[11px] leading-relaxed">
              {typeof block.rawOutput === "string"
                ? block.rawOutput
                : JSON.stringify(block.rawOutput, null, 2)}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type ActivityBlock = Extract<Block, { kind: "tool" | "thought" | "plan" }>;
function isActivity(block: Block): block is ActivityBlock {
  return ["tool", "thought", "plan"].includes(block.kind);
}

function ActivityGroup({
  blocks,
  working,
}: {
  blocks: ActivityBlock[];
  working: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tools = blocks.filter((block) => block.kind === "tool");
  const failed = tools.some((tool) => tool.status === "failed");
  const label = working
    ? "Agent activity"
    : failed
      ? "Activity needs attention"
      : tools.length
        ? `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`
        : "Reasoning & plan";
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex max-w-full items-center gap-2 rounded-lg py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {working ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : failed ? (
            <CircleAlert className="size-3.5 text-destructive" />
          ) : (
            <Workflow className="size-3.5" />
          )}
          {label}
          <ChevronDown
            className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 space-y-2 border-l border-white/10 pl-3">
          {blocks.map((block, i) =>
            block.kind === "tool" ? (
              <ToolCard key={block.id} block={block} />
            ) : block.kind === "thought" ? (
              <div
                key={i}
                className="p-2 text-xs leading-7 text-muted-foreground"
              >
                <p className="mb-1 font-medium text-foreground/70">Reasoning</p>
                <p className="whitespace-pre-wrap">{block.text}</p>
              </div>
            ) : (
              <div key={i} className="tool-details space-y-2 p-3">
                <p className="mb-3 text-xs font-medium">Plan</p>
                {block.entries.map((entry, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-2 text-xs leading-relaxed"
                  >
                    <ToolStatus status={entry.status} />
                    <span
                      className={
                        entry.status === "completed"
                          ? "text-muted-foreground"
                          : "text-foreground"
                      }
                    >
                      {entry.content}
                    </span>
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const TurnView = memo(function TurnView({
  turn,
  agentId,
  agentName,
  working,
  onAnswer,
}: {
  turn: Turn;
  agentId: string;
  agentName: string;
  working: boolean;
  onAnswer: (requestId: string, optionId: string) => Promise<void>;
}) {
  const segments: (Block | ActivityBlock[])[] = [];
  for (const block of turn.blocks) {
    const previous = segments.at(-1);
    if (isActivity(block)) {
      if (Array.isArray(previous)) previous.push(block);
      else segments.push([block]);
    } else segments.push(block);
  }
  let hasAgentLabel = false;
  return (
    <div className="conversation-turn">
      {segments.map((segment, i) => {
        if (Array.isArray(segment))
          return (
            <ActivityGroup
              key={`activity-${i}`}
              blocks={segment}
              working={working && i === segments.length - 1}
            />
          );
        if (segment.kind === "user")
          return (
            <Message key={`user-${i}`} align="end">
              <MessageContent>
                <Bubble variant="secondary" className="max-w-[90%]">
                  <BubbleContent className="!rounded-[20px] !border-white/5 !bg-[#252b3e]/70 !px-4 !py-3 !text-[14px] !leading-7 whitespace-pre-wrap">
                    {segment.text}
                  </BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
          );
        if (segment.kind === "assistant") {
          const label = !hasAgentLabel;
          hasAgentLabel = true;
          return (
            <Message key={`assistant-${i}`}>
              <MessageContent className="gap-3">
                {label && (
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <AgentLogo agentId={agentId} className="!size-4" />
                    {agentName}
                  </div>
                )}
                <Markdown text={segment.text} />
                {!working && (
                  <MessageFooter className="!px-0">
                    <CopyButton
                      text={segment.text}
                      label="Copy response"
                      className="text-muted-foreground/70"
                    />
                  </MessageFooter>
                )}
              </MessageContent>
            </Message>
          );
        }
        if (segment.kind === "permission")
          return (
            <PermissionCard
              key={segment.requestId}
              b={segment}
              onAnswer={onAnswer}
            />
          );
        if (segment.kind === "error")
          return (
            <div
              key={`error-${i}`}
              role="alert"
              className="flex items-start gap-2.5 rounded-xl border border-destructive/15 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {segment.message}
            </div>
          );
        if (segment.kind === "turn_end" && segment.stopReason !== "end_turn")
          return (
            <p key={`end-${i}`} className="text-xs text-muted-foreground">
              {segment.stopReason === "cancelled"
                ? "You stopped this response."
                : `Response ended · ${segment.stopReason.replaceAll("_", " ")}`}
            </p>
          );
        return null;
      })}
    </div>
  );
});

function ScrollOnSend({ request }: { request: number }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (request) scrollToEnd({ behavior: "instant" });
  }, [request, scrollToEnd]);
  return null;
}

export default function Conversation({
  history,
  loading,
  loadingOlder,
  error,
  loadOlder,
  busy,
  agentId,
  agentName,
  onAnswer,
  scrollRequest,
}: {
  history: History;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  loadOlder: () => void;
  busy: boolean;
  agentId: string;
  agentName: string;
  onAnswer: (requestId: string, optionId: string) => Promise<void>;
  scrollRequest: number;
}) {
  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={80}
    >
      <MessageScroller className="flex-1">
        <ScrollOnSend request={scrollRequest} />
        <MessageScrollerViewport
          aria-label="Conversation"
          preserveScrollOnPrepend
          onScroll={(event) => {
            if (
              event.currentTarget.scrollTop < 200 &&
              history.hasMore &&
              !loading &&
              !loadingOlder
            )
              loadOlder();
          }}
        >
          {/* Keep pagination outside the message list so its first item remains a stable scroll anchor. */}
          {(history.hasMore || loadingOlder) && (
            <div className="flex justify-center px-6 pt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : null}
                {loadingOlder
                  ? "Loading earlier messages…"
                  : "Load earlier messages"}
              </Button>
            </div>
          )}
          <MessageScrollerContent
            className="conversation-content !gap-10"
            role="log"
            aria-live="off"
            aria-label="Messages"
          >
            {loading && (
              <p
                role="status"
                className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"
              >
                <LoaderCircle className="size-4 animate-spin" />
                Opening conversation…
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {!loading && !history.turns.length && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="glass rounded-2xl p-4">
                  <AgentLogo agentId={agentId} className="!size-7" />
                </span>
                <h2 className="mt-2 text-lg font-medium tracking-tight">
                  Ready when you are.
                </h2>
                <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                  Give {agentName} a task, ask a question, or explore an idea
                  together.
                </p>
              </div>
            )}
            {history.turns.map((turn, i) => (
              <MessageScrollerItem
                key={turn.key}
                messageId={`turn-${turn.key}`}
                className="![content-visibility:visible]"
              >
                <TurnView
                  turn={turn}
                  agentId={agentId}
                  agentName={agentName}
                  working={busy && i === history.turns.length - 1}
                  onAnswer={onAnswer}
                />
              </MessageScrollerItem>
            ))}
            {busy && (
              <div
                role="status"
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="flex gap-1" aria-hidden="true">
                  <span className="size-1 rounded-full bg-indigo-200/60 animate-pulse" />
                  <span className="size-1 rounded-full bg-indigo-200/40 animate-pulse [animation-delay:200ms]" />
                  <span className="size-1 rounded-full bg-indigo-200/20 animate-pulse [animation-delay:400ms]" />
                </span>
                {history.turns
                  .at(-1)
                  ?.blocks.some(
                    (block) => block.kind === "permission" && !block.response,
                  )
                  ? "Waiting for your approval"
                  : `${agentName} is working`}
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          size="sm"
          className="glass !rounded-full !px-3 !text-xs"
          aria-label="Jump to latest message"
        >
          <ArrowDown className="size-3.5" />
          Jump to latest
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
