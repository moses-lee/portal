"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { Check, Ellipsis, LayoutGrid, PencilLine, Plus, X } from "lucide-react";
import type { LayoutPreset, Tab } from "@portal/contracts/workspace";
import { LAYOUT_PRESETS, WORKSPACE_TAB_TITLE_MAX } from "@portal/contracts/workspace";
import { presetOf } from "@portal/shared/workspace";
import TabIcon from "./TabIcon";
import IconButton from "../IconButton";
import { RenameField } from "../ProjectActions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionState } from "@/lib/session-state";
import { presetLabels } from "@/lib/workspace";

export type TabStripProps = {
  tabs: Tab[];
  focusedTabId: string | null;
  unread: ReadonlySet<string>;
  titleOf: (tab: Tab) => string;
  stateOf: (sessionId: string) => SessionState | null;
  onNewTab: () => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onRename: (tabId: string, title: string | null) => void;
  onArrange: (tab: Tab, preset: LayoutPreset) => void;
};

/**
 * The strip of tabs (decision 1 and 10): Radix tabs controlled by the URL (the view around this owns
 * `Tabs.Root`), each trigger the layout miniature, the name, a close button and a menu (rename inline,
 * layout presets, close, close others), and a `+` that opens a start-page tab.
 */
export default function TabStrip({ tabs, focusedTabId, unread, titleOf, stateOf, onNewTab, onClose, onCloseOthers, onRename, onArrange }: TabStripProps) {
  return (
    <Tabs.List aria-label="Workspace tabs" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/5 px-2 py-1.5">
      {tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          title={titleOf(tab)}
          selected={tab.id === focusedTabId}
          unread={unread.has(tab.id)}
          only={tabs.length === 1}
          stateOf={stateOf}
          onClose={onClose}
          onCloseOthers={onCloseOthers}
          onRename={onRename}
          onArrange={onArrange}
        />
      ))}
      <IconButton label="New tab" size="icon-xs" onClick={onNewTab} className="ml-0.5 shrink-0 text-muted-foreground">
        <Plus />
      </IconButton>
    </Tabs.List>
  );
}

const TabItem = memo(function TabItem({
  tab,
  title,
  selected,
  unread,
  only,
  stateOf,
  onClose,
  onCloseOthers,
  onRename,
  onArrange,
}: {
  tab: Tab;
  title: string;
  selected: boolean;
  unread: boolean;
  /** The only tab: "Close others" has nothing to do. */
  only: boolean;
  stateOf: (sessionId: string) => SessionState | null;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onRename: (tabId: string, title: string | null) => void;
  onArrange: (tab: Tab, preset: LayoutPreset) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);
  const current = presetOf(tab.root);
  return (
    <div
      data-tab={tab.id}
      data-selected={selected || undefined}
      className={`group/tab flex max-w-[260px] shrink-0 items-center rounded-lg pr-0.5 transition-colors ${
        selected ? "bg-white/8 text-foreground" : "text-foreground/70 hover:bg-white/4 hover:text-foreground"
      }`}
    >
      {renaming ? (
        <div className="min-w-[160px] px-1">
          <RenameField
            inputRef={renameInput}
            initial={tab.title ?? ""}
            ariaLabel="Tab name"
            maxLength={WORKSPACE_TAB_TITLE_MAX}
            className="my-0.5 w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-0.5 text-xs outline-none"
            onCancel={() => setRenaming(false)}
            onCommit={(next) => {
              setRenaming(false);
              onRename(tab.id, next);
            }}
          />
        </div>
      ) : (
        <Tabs.Trigger
          value={tab.id}
          title={title}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TabIcon root={tab.root} stateOf={stateOf} unread={unread} />
          <span className="min-w-0 truncate">{title}</span>
          {unread && <span className="sr-only">, unread</span>}
        </Tabs.Trigger>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label={`Tab menu for ${title}`}
            size="icon-xs"
            className="text-muted-foreground opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 group-data-[selected]/tab:opacity-100"
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            // Rename swaps the trigger for its input: focus goes there, not back to the menu button.
            if (renameInput.current) {
              event.preventDefault();
              renameInput.current.focus();
            }
          }}
        >
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <PencilLine />
            Rename
          </DropdownMenuItem>
          {tab.title !== null && (
            <DropdownMenuItem onSelect={() => onRename(tab.id, null)}>Use the default name</DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <LayoutGrid />
              Layout
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {LAYOUT_PRESETS.map((preset) => (
                <DropdownMenuItem key={preset} onSelect={() => onArrange(tab, preset)} aria-current={preset === current || undefined}>
                  <span className="flex size-4 items-center justify-center">{preset === current && <Check className="size-3.5" />}</span>
                  {presetLabels[preset]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onClose(tab.id)}>
            <X />
            Close tab
          </DropdownMenuItem>
          <DropdownMenuItem disabled={only} onSelect={() => onCloseOthers(tab.id)}>
            Close other tabs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton
        label={`Close tab ${title}`}
        size="icon-xs"
        onClick={() => onClose(tab.id)}
        className="text-muted-foreground opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 group-data-[selected]/tab:opacity-100"
      >
        <X />
      </IconButton>
    </div>
  );
});
