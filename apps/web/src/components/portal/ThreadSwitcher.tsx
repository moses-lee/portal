"use client";

import { Archive, ChevronDown, LoaderCircle, MessagesSquare } from "lucide-react";
import { usePortalLive } from "./PortalLive";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MAIN_THREAD_ID, type Thread } from "@/lib/orchestrator/types";

/**
 * The compact thread switcher above the conversation: the main thread, then the side threads
 * Portal opened (it alone opens and archives them, so there is no "new" or "archive" here), each
 * marked while it is answering or has news. Archived threads stay readable from a menu. Hidden
 * while the main thread is the only one.
 */
export default function ThreadSwitcher({
  current,
  unread,
  onSelect,
}: {
  current: string;
  unread: ReadonlySet<string>;
  onSelect: (threadId: string) => void;
}) {
  const { threads, status } = usePortalLive();
  const side = threads.filter((thread) => thread.kind === "side");
  if (side.length === 0 && current === MAIN_THREAD_ID) return null;
  const active = side.filter((thread) => thread.status === "active");
  const archived = side.filter((thread) => thread.status === "archived");
  const busy = new Set(status?.busyThreads ?? []);
  const main: Pick<Thread, "id" | "title"> = threads.find((thread) => thread.kind === "main") ?? {
    id: MAIN_THREAD_ID,
    title: "Main",
  };
  const pill = (thread: Pick<Thread, "id" | "title">, label: string) => {
    const selected = thread.id === current;
    return (
      <button
        key={thread.id}
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={() => onSelect(thread.id)}
        title={thread.title}
        className={`flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full px-3 text-xs transition-colors ${
          selected ? "bg-white/12 text-foreground" : "text-foreground/70 hover:bg-white/6 hover:text-foreground"
        }`}
      >
        {busy.has(thread.id) ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-sky-300" aria-label="Answering" />
        ) : unread.has(thread.id) && !selected ? (
          <span className="size-1.5 shrink-0 rounded-full bg-sky-300" aria-label="New messages" />
        ) : null}
        <span className="truncate">{label}</span>
      </button>
    );
  };
  const currentArchived = archived.find((thread) => thread.id === current);
  return (
    <div className="border-b border-white/5">
      <div className="mx-auto flex w-full max-w-[840px] items-center gap-1 px-5 py-1.5 max-sm:px-3">
        <MessagesSquare className="mr-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div role="tablist" aria-label="Threads" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {pill(main, "Main")}
          {active.map((thread) => pill(thread, thread.title))}
          {currentArchived && pill(currentArchived, currentArchived.title)}
        </div>
        {archived.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-white/6 hover:text-foreground"
              >
                <Archive className="size-3" />
                Archived ({archived.length})
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              <DropdownMenuLabel>Archived by Portal</DropdownMenuLabel>
              {archived.map((thread) => (
                <DropdownMenuItem key={thread.id} onSelect={() => onSelect(thread.id)}>
                  <span className="truncate">{thread.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
