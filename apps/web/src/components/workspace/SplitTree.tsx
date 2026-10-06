"use client";

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import type { LayoutNode, PaneNode, SplitNode } from "@portal/contracts/workspace";
import { panesOf } from "@portal/shared/workspace";
import { layoutOf, sameSizes, sizesFromLayout } from "@/lib/workspace";

/** How long after the pointer is released a drag's sizes are sent as a `resize` op. */
const RESIZE_DEBOUNCE_MS = 300;

export type SplitTreeProps = {
  root: LayoutNode;
  /** The focused pane; it gets the ring in a split (none in a single-pane tab). */
  focusedPaneId: string | null;
  /** The pane's content; `first` is true for the tab's first pane in reading order (it carries the sidebar toggle). */
  renderPane: (pane: PaneNode, first: boolean) => ReactNode;
  /** Pointer down or focus landed in the pane. */
  onFocusPane: (paneId: string) => void;
  /** A split's sizes after the user dragged a separator (debounced). */
  onResize: (splitId: string, sizes: number[]) => void;
  /** The key to render a node under (the provider's `keyOf`): stable across the server replacing optimistic ids. */
  keyOf: (id: string) => string;
};

/**
 * A tab's layout tree with nested resizable groups: each split is a `Group` keyed by its node id,
 * seeded with the stored sizes, reporting drags as `resize` ops, and following server pushes through
 * the group's imperative `setLayout`. Each pane is a `Panel` around the pane's content.
 */
export default function SplitTree({ root, focusedPaneId, renderPane, onFocusPane, onResize, keyOf }: SplitTreeProps) {
  if (root.kind === "pane") {
    return (
      <PaneFrame pane={root} focused={false} multi={false} onFocus={onFocusPane}>
        {renderPane(root, true)}
      </PaneFrame>
    );
  }
  const firstPaneId = panesOf(root)[0]?.id;
  const paneContent = (pane: PaneNode) => renderPane(pane, pane.id === firstPaneId);
  return <SplitGroup node={root} focusedPaneId={focusedPaneId} paneContent={paneContent} onFocusPane={onFocusPane} onResize={onResize} keyOf={keyOf} />;
}

function SplitGroup({
  node,
  focusedPaneId,
  paneContent,
  onFocusPane,
  onResize,
  keyOf,
}: {
  node: SplitNode;
  focusedPaneId: string | null;
  paneContent: (pane: PaneNode) => ReactNode;
  onFocusPane: (paneId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  keyOf: (id: string) => string;
}) {
  const groupRef = useGroupRef();
  /** The sizes this group last showed or sent; a push that differs is applied through the ref. */
  const applied = useRef<number[]>(node.sizes);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizesKey = node.sizes.join(",");
  useEffect(() => {
    if (sameSizes(node.sizes, applied.current)) return;
    applied.current = node.sizes;
    groupRef.current?.setLayout(layoutOf(node, keyOf));
    // The sizes are what matters; the node object changes with every workspace copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizesKey]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const changed = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const sizes = sizesFromLayout(node, layout, keyOf);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      applied.current = sizes;
      onResize(node.id, sizes);
    }, RESIZE_DEBOUNCE_MS);
  };
  const row = node.direction === "row";
  return (
    <Group
      id={keyOf(node.id)}
      orientation={row ? "horizontal" : "vertical"}
      defaultLayout={layoutOf(node, keyOf)}
      groupRef={groupRef}
      onLayoutChanged={changed}
      className="min-h-0 min-w-0 flex-1"
    >
      {node.children.map((child, index) => (
        <Fragment key={keyOf(child.id)}>
          {index > 0 && (
            <Separator
              aria-label={row ? "Resize panes side by side" : "Resize stacked panes"}
              className={`shrink-0 bg-white/5 transition-colors hover:bg-indigo-300/30 focus-visible:bg-indigo-300/30 ${row ? "w-1.5" : "h-1.5"}`}
            />
          )}
          <Panel id={keyOf(child.id)} minSize="10%" className="flex h-full min-h-0 min-w-0 flex-col">
            {child.kind === "pane" ? (
              <PaneFrame pane={child} focused={child.id === focusedPaneId} multi onFocus={onFocusPane}>
                {paneContent(child)}
              </PaneFrame>
            ) : (
              <SplitGroup node={child} focusedPaneId={focusedPaneId} paneContent={paneContent} onFocusPane={onFocusPane} onResize={onResize} keyOf={keyOf} />
            )}
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

/** The box around a pane: focus tracking (pointer down or focus within) and, in a split, the focus ring. */
function PaneFrame({
  pane,
  focused,
  multi,
  onFocus,
  children,
}: {
  pane: PaneNode;
  focused: boolean;
  /** Whether the pane shares its tab: only then is focus tracked and shown. */
  multi: boolean;
  onFocus: (paneId: string) => void;
  children: ReactNode;
}) {
  const focus = multi && !focused ? () => onFocus(pane.id) : undefined;
  return (
    <div
      data-pane-frame={pane.id}
      data-focused={(multi && focused) || undefined}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      className={`flex min-h-0 min-w-0 flex-1 flex-col ${multi && focused ? "ring-1 ring-inset ring-indigo-400/60" : ""}`}
    >
      {children}
    </div>
  );
}
