"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Tabs } from "radix-ui";
import {
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { Ellipsis, LayoutGrid, PencilLine, Plus, X } from "lucide-react";
import type { LayoutPreset, Tab } from "@portal/contracts/workspace";
import { LAYOUT_PRESETS, WORKSPACE_TAB_TITLE_MAX } from "@portal/contracts/workspace";
import { presetOf } from "@portal/shared/workspace";
import TabIcon from "./TabIcon";
import IconButton from "../IconButton";
import { RenameField } from "../ProjectActions";
import { ContextActions, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from "../ActionMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
  /** Move the tab to `index` in the strip (a drag dropped). */
  onMove: (tabId: string, index: number) => void;
};

/** A dragged tab slides along the strip only. */
const alongStrip: Modifier = ({ transform }) => ({ ...transform, y: 0 });

/** Space picks a focused tab up and drops it; Enter stays the trigger's own key. */
const KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
};

/**
 * The strip of tabs (decision 1 and 10): Radix tabs controlled by the URL (the view around this owns
 * `Tabs.Root`), each trigger the layout miniature, the name, a close button and a menu (rename inline,
 * layout presets, close, close others), and a `+` that opens a start-page tab. Each tab's name and
 * icon cells are resolved here and handed to the memoised item as values, so a session-list patch
 * re-renders only the items it changed. Closing a tab moves keyboard focus to its neighbour's trigger
 * (right, else left), the tab the view shows next, not the body.
 *
 * Tabs share one width (shrinking together as the strip fills, then scrolling) with a divider
 * between each pair. A tab is dragged along the strip to reorder it (`move_tab`, optimistic like
 * every op), or picked up with Space on its focused trigger and moved with the arrow keys. A tab's
 * menu opens from its `…` button (on the selected tab) or by right-clicking the tab.
 */
export default function TabStrip({ tabs, focusedTabId, unread, titleOf, stateOf, onNewTab, onClose, onCloseOthers, onRename, onArrange, onMove }: TabStripProps) {
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
  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click still just selects the tab. Mouse only:
    // on touch the strip scrolls sideways and a long press opens the tab's menu.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );
  const ids = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const index = tabs.findIndex((tab) => tab.id === over.id);
      if (index >= 0) onMove(String(active.id), index);
    },
    [tabs, onMove],
  );
  const announcements = useMemo<Announcements>(() => {
    const name = (id: string | number) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      return tab ? titleOf(tab) : "Tab";
    };
    const place = (id: string | number) => `position ${tabs.findIndex((tab) => tab.id === id) + 1} of ${tabs.length}`;
    return {
      onDragStart: ({ active }) => `Picked up tab ${name(active.id)}, ${place(active.id)}.`,
      onDragOver: ({ active, over }) => (over ? `Tab ${name(active.id)} moved to ${place(over.id)}.` : undefined),
      onDragEnd: ({ active, over }) => (over ? `Tab ${name(active.id)} dropped at ${place(over.id)}.` : `Tab ${name(active.id)} dropped.`),
      onDragCancel: ({ active }) => `Moving tab ${name(active.id)} was cancelled.`,
    };
  }, [tabs, titleOf]);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[alongStrip]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: "To move a tab, press Space, use the left and right arrow keys, then press Space again to drop it or Escape to cancel." },
      }}
    >
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
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
      </SortableContext>
    </DndContext>
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
  // The rename field is a text field while it shows: no dragging it, and the browser's own menu on right-click.
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: tab.id, disabled: renaming });
  const current = presetOf(tab.root);
  /** Where focus goes when either menu closes. */
  const onMenuCloseAutoFocus = (event: Event) => {
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
  };
  const items = (
    <>
      <MenuItem onSelect={() => setRenaming(true)}>
        <PencilLine />
        Rename
      </MenuItem>
      {tab.title !== null && <MenuItem onSelect={() => onRename(tab.id, null)}>Use the default name</MenuItem>}
      <MenuSub>
        <MenuSubTrigger>
          <LayoutGrid />
          Layout
        </MenuSubTrigger>
        <MenuSubContent>
          <MenuRadioGroup value={current ?? ""} onValueChange={(preset) => onArrange(tab, preset as LayoutPreset)}>
            {LAYOUT_PRESETS.map((preset) => (
              <MenuRadioItem key={preset} value={preset}>
                {presetLabels[preset]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
      <MenuSeparator />
      <MenuItem
        onSelect={() => {
          closedTo.current = onClose(tab.id);
        }}
      >
        <X />
        Close tab
      </MenuItem>
      <MenuItem disabled={only} onSelect={() => onCloseOthers(tab.id)}>
        Close other tabs
      </MenuItem>
    </>
  );
  /** While this tab is being moved by keyboard, the arrow keys move it rather than the focus along the strip. */
  const holdArrows = (event: KeyboardEvent) => {
    if (isDragging && (event.key === "ArrowLeft" || event.key === "ArrowRight")) event.preventDefault();
  };
  return (
    <ContextActions items={items} disabled={renaming} onCloseAutoFocus={onMenuCloseAutoFocus}>
      <div
        ref={setNodeRef}
        style={{ transform: DndCSS.Translate.toString(transform), transition }}
        data-tab={tab.id}
        data-selected={selected || undefined}
        data-dragging={isDragging || undefined}
        className={`group/tab relative flex min-w-[88px] max-w-[200px] flex-1 basis-0 items-center rounded-lg pr-0.5 transition-colors not-first:before:pointer-events-none not-first:before:absolute not-first:before:top-1/2 not-first:before:-left-[2.5px] not-first:before:h-4 not-first:before:w-px not-first:before:-translate-y-1/2 not-first:before:bg-white/15 ${
          selected ? "bg-white/14 text-foreground" : "text-foreground/70 hover:bg-white/5 hover:text-foreground"
        } ${isDragging ? "z-10 shadow-lg shadow-black/30" : ""}`}
      >
        {renaming ? (
          <div className="min-w-0 flex-1 px-1">
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
            ref={setActivatorNodeRef}
            value={tab.id}
            title={title}
            data-tab-trigger={tab.id}
            aria-roledescription="sortable tab"
            aria-describedby={attributes["aria-describedby"]}
            // The trigger alone starts a drag: a press on the close or menu button (or in the open menu, which
            // is the tab's child in React) must stay a click.
            {...listeners}
            onKeyDown={(event) => {
              holdArrows(event);
              listeners?.onKeyDown?.(event);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <TabIcon cells={cells} unread={unread} />
            <span className="min-w-0 truncate">{title}</span>
            {unread && <span className="sr-only">, unread</span>}
          </Tabs.Trigger>
        )}
        {selected && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Tab menu for ${title}`} size="icon-xs" className="shrink-0 text-muted-foreground">
                <Ellipsis />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={onMenuCloseAutoFocus}>
              {items}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <IconButton
          label={`Close tab ${title}`}
          size="icon-xs"
          onClick={() => onClose(tab.id)}
          className="shrink-0 text-muted-foreground opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 group-data-[selected]/tab:opacity-100"
        >
          <X />
        </IconButton>
      </div>
    </ContextActions>
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
