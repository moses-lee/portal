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
import { LayoutGrid, PencilLine, Plus, X } from "lucide-react";
import type { LayoutPreset, Tab } from "@portal/contracts/workspace";
import { LAYOUT_PRESETS, WORKSPACE_TAB_TITLE_MAX } from "@portal/contracts/workspace";
import { presetOf } from "@portal/shared/workspace";
import TabIcon from "./TabIcon";
import IconButton from "../IconButton";
import { RenameField } from "../ProjectActions";
import { ContextActions, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from "../ActionMenu";
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
 * Tabs are flush blocks of one width (shrinking together as the strip fills, then scrolling), a
 * full-height divider between each pair. The other tabs and the strip's empty end are shaded, with
 * a line along the bottom; the selected tab is not, so it opens into the pane below, and a white
 * line marks its top. A tab is dragged along the strip to reorder it (`move_tab`, optimistic like
 * every op), or picked up with Space on its focused trigger and moved with the arrow keys. A tab's
 * menu opens on right-click (long-press on touch, the menu key on the keyboard); it has no button.
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
        <Tabs.List ref={list} aria-label="Workspace tabs" className="flex h-9 shrink-0 items-stretch overflow-x-auto">
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
          {/* The rest of the strip, shaded like the tabs behind the selected one. */}
          <div className="flex min-w-10 flex-1 items-center bg-black/25 pl-1.5 shadow-[inset_0_-1px_0_rgb(255_255_255/0.08)]">
            <IconButton label="New tab" size="icon-xs" onClick={onNewTab} className="shrink-0 text-muted-foreground">
              <Plus />
            </IconButton>
          </div>
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
  /** The neighbour that took the focus when the menu's "Close tab" ran; the menu must not hand focus back to a tab that is gone. */
  const closedTo = useRef<string | null>(null);
  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);
  // The rename field is a text field while it shows: no dragging it, and the browser's own menu on right-click.
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: tab.id, disabled: renaming });
  const current = presetOf(tab.root);
  /** Where focus goes when the menu closes. */
  const onMenuCloseAutoFocus = (event: Event) => {
    // Rename swaps the trigger for its input: focus goes there, not back to the tab.
    if (renameInput.current) {
      event.preventDefault();
      renameInput.current.focus();
      return;
    }
    // "Close tab": the tab is going away; the neighbour's trigger has the focus.
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
  /** The menu key or Shift+F10 opens the tab's menu at the tab, on every platform (macOS fires no `contextmenu` for them). */
  const menuKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.bottom }));
  };
  return (
    <ContextActions items={items} disabled={renaming} onCloseAutoFocus={onMenuCloseAutoFocus}>
      <div
        ref={setNodeRef}
        style={{ transform: DndCSS.Translate.toString(transform), transition }}
        data-tab={tab.id}
        data-selected={selected || undefined}
        data-dragging={isDragging || undefined}
        className={`group/tab relative flex min-w-[88px] max-w-[200px] flex-1 basis-0 items-center border-r border-white/8 pr-1 transition-colors ${
          selected
            ? "text-foreground before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-white"
            : "text-foreground/60 shadow-[inset_0_-1px_0_rgb(255_255_255/0.08)] hover:text-foreground"
        } ${isDragging ? "z-10 bg-background shadow-lg shadow-black/40" : selected ? "" : "bg-black/25 hover:bg-black/10"}`}
      >
        {renaming ? (
          <div className="min-w-0 flex-1 px-1.5">
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
            // The trigger alone starts a drag: a press on the close button (or in the open menu, which is the
            // tab's child in React) must stay a click.
            {...listeners}
            onKeyDown={(event) => {
              holdArrows(event);
              menuKey(event);
              listeners?.onKeyDown?.(event);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-3 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <TabIcon cells={cells} unread={unread} />
            <span className="min-w-0 truncate">{title}</span>
            {unread && <span className="sr-only">, unread</span>}
          </Tabs.Trigger>
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
