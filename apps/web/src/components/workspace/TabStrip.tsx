"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { Ellipsis, LayoutGrid, PencilLine, Plus, X } from "lucide-react";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionState } from "@/lib/session-state";
import { neighbourTab, presetLabels, sameCells, tabCells, type IconCellState } from "@/lib/workspace";

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
 * layout presets, close, close others), and a `+` that opens a start-page tab. Each tab's name and
 * icon cells are resolved here and handed to the memoised item as values, so a session-list patch
 * re-renders only the items it changed. Closing a tab moves keyboard focus to its neighbour's trigger
 * (right, else left), the tab the view shows next, not the body.
 */
export default function TabStrip({ tabs, focusedTabId, unread, titleOf, stateOf, onNewTab, onClose, onCloseOthers, onRename, onArrange }: TabStripProps) {
  const list = useRef<HTMLDivElement>(null);
  const focusTab = useCallback((tabId: string) => {
    list.current?.querySelector<HTMLElement>(`[data-tab-trigger="${CSS.escape(tabId)}"]`)?.focus();
  }, []);
  /** Close the tab and answer the neighbour that took the focus (null when it was the last tab). */
  const close = useCallback(
    (tabId: string): string | null => {
      const neighbour = neighbourTab(tabs, tabId);
      onClose(tabId);
      if (neighbour) focusTab(neighbour.id);
      return neighbour?.id ?? null;
    },
    [tabs, onClose, focusTab],
  );
  return (
    <Tabs.List ref={list} aria-label="Workspace tabs" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/5 px-2 py-1.5">
      {tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          title={titleOf(tab)}
          cells={tabCells(tab.root, stateOf)}
          selected={tab.id === focusedTabId}
          unread={unread.has(tab.id)}
          only={tabs.length === 1}
          onClose={close}
          onCloseOthers={onCloseOthers}
          onRename={onRename}
          onArrange={onArrange}
          focusTab={focusTab}
        />
      ))}
      <IconButton label="New tab" size="icon-xs" onClick={onNewTab} className="ml-0.5 shrink-0 text-muted-foreground">
        <Plus />
      </IconButton>
    </Tabs.List>
  );
}

type TabItemProps = {
  tab: Tab;
  title: string;
  /** The icon's cells with their states, compared by value (`sameCells`). */
  cells: readonly IconCellState[];
  selected: boolean;
  unread: boolean;
  /** The only tab: "Close others" has nothing to do. */
  only: boolean;
  /** Closes the tab; answers the neighbour that took the focus, for the menu's focus return. */
  onClose: (tabId: string) => string | null;
  onCloseOthers: (tabId: string) => void;
  onRename: (tabId: string, title: string | null) => void;
  onArrange: (tab: Tab, preset: LayoutPreset) => void;
  focusTab: (tabId: string) => void;
};

const TabItem = memo(function TabItem({ tab, title, cells, selected, unread, only, onClose, onCloseOthers, onRename, onArrange, focusTab }: TabItemProps) {
  const [renaming, setRenaming] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  /** The neighbour that took the focus when the menu's "Close tab" ran; the menu must not hand focus back to a button that is gone. */
  const closedTo = useRef<string | null>(null);
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
          data-tab-trigger={tab.id}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TabIcon cells={cells} unread={unread} />
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
              return;
            }
            // "Close tab": the menu button is going away with its tab; the neighbour's trigger has the focus.
            if (closedTo.current) {
              event.preventDefault();
              focusTab(closedTo.current);
              closedTo.current = null;
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
              <DropdownMenuRadioGroup value={current ?? ""} onValueChange={(preset) => onArrange(tab, preset as LayoutPreset)}>
                {LAYOUT_PRESETS.map((preset) => (
                  <DropdownMenuRadioItem key={preset} value={preset}>
                    {presetLabels[preset]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              closedTo.current = onClose(tab.id);
            }}
          >
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
}, areTabItemPropsEqual);

/** The memo's comparison: `cells` by value, everything else by identity (the callbacks are stable). */
function areTabItemPropsEqual(prev: TabItemProps, next: TabItemProps): boolean {
  return (
    prev.tab === next.tab &&
    prev.title === next.title &&
    prev.selected === next.selected &&
    prev.unread === next.unread &&
    prev.only === next.only &&
    prev.onClose === next.onClose &&
    prev.onCloseOthers === next.onCloseOthers &&
    prev.onRename === next.onRename &&
    prev.onArrange === next.onArrange &&
    prev.focusTab === next.focusTab &&
    sameCells(prev.cells, next.cells)
  );
}
