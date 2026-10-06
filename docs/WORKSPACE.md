# Workspace: tabs and split panes for sessions

Date: 2026-10-05. Status: spec agreed with Moses, nothing built yet. Branch `feat/workspace`.

## Why

Portal shows one session at a time. The URL names it, switching remounts the pane, and the only way to see two sessions together is the tracked panel on the orchestrator pages, which shows one session beside the thread. Working across several agent sessions means bouncing through the sidebar.

This spec adds a **workspace**: a strip of tabs, each tab holding one session or a split of up to four. The workspace is stored on the server so every device shows the same tabs and the orchestrator can read and edit it. Phones get the same tabs rendered flat, with a bottom bar to switch.

## Vocabulary

- **Workspace**: the ordered list of tabs. One per Portal install (named workspaces are out of scope).
- **Tab**: one entry in the strip. Holds a **layout tree** whose leaves are panes.
- **Pane**: one view. Either a session, or the start page (a "new session" pane that turns into a session once one is created).
- **Split**: a layout node that divides its space among its children, as a row (side by side) or a column (stacked), with sizes in percent.
- **Preset**: one of the six shapes the UI offers: single, two columns, three columns, two rows, 2x2, and one pane beside two stacked.
- **Focus**: which tab and which pane a device is looking at. Per device, carried in the URL, never stored.

## Decisions on record

| # | Topic | Decision |
|---|---|---|
| 1 | Shape | A workspace is an ordered list of tabs. A tab holds one session or a split tree of 2 to 4 panes. Tabs switch, splits show together. |
| 2 | Rows | Splits nest, rows and columns both, capped at 4 panes and depth 2. The UI offers the six presets; no drag-to-split in round one. |
| 3 | Pane content | The full session page per pane (header, transcript, composer, agent settings, context bar, terminal). One GitHub inspector follows the focused pane. |
| 4 | Storage | Server-side, one `settings` row (`key = 'workspace'`), pushed over the portal stream. The structure (tabs, panes, split sizes, names, order) is shared by every device. |
| 5 | Named workspaces | One workspace. The model leaves room for more later. |
| 6 | Per-device focus | Which tab and pane a device shows is that device's business. Another device or the orchestrator can rearrange the workspace, never steer focus. |
| 7 | URL | `/tabs/<tabId>` is the focused tab, `?pane=<paneId>` the focused pane of a split. The "session by itself" page goes away. `/sessions/<id>` and `/new` stay as resolvers: focus the tab that holds the session (or a start-page pane), else open one, then rewrite the URL. Old links keep working. |
| 8 | Opening | Sidebar rows, the tracked panel's "open full page", item links and orchestrator links all do the same thing: focus the session if it is open anywhere, otherwise open it in a new tab. Closing a tab or pane never touches the session. |
| 9 | Start page | `/new` is a "new session" pane. The pane becomes the session's pane once it is created. An empty workspace renders the start page without a tab strip; creating a session there opens the first tab. |
| 10 | Tab icon | Each tab shows a miniature of its layout, one cell per pane, each cell a dot in the state colours the sidebar uses (one vocabulary). A start-page cell is hollow. A ring around the icon marks unread: a hidden pane's turn ended, or asked for approval, since the tab was last focused. |
| 11 | Shortcuts | None in round one. |
| 12 | Pins and recent rooms | Unchanged. |
| 13 | Orchestrator can | Read the workspace and what the asking device is looking at; open a session in a tab or beside another; arrange sessions into a preset; close a tab or pane; rename a tab. |
| 14 | When | Chat turns only. Never background turns, watches or jobs. Ungated: every edit is reversible. |
| 15 | Auto-open | No. Sessions the orchestrator creates are tracked, not opened. It opens a tab only when asked. |
| 16 | "This session" | Each orchestrator chat message carries the sending device's view (the tracked panel's open session if any, else the focused pane's session and tab). The turn's prompt gets a "You are looking at" line. |
| 17 | Tracked panel | Unchanged, on every Portal view, no tabs or splits there. |
| 18 | Mobile | Below 768 px the workspace renders as a flat list of panes (every pane of every tab, in order). A slim bar under the composer shows the current pane's title and state dot; swipe left or right on the bar to switch, tap to open the tabs sheet. Hidden while the keyboard is up. Swiping the transcript does nothing. |
| 19 | Mobile edits | Shared like any other: closing a pane on the phone removes that pane from its split on every device. |
| 20 | Tablet | 768 to 1100 px: tabs with 1 or 2 panes render as splits; bigger tabs render the focused pane with a pane switcher. |
| 21 | Layout model | A split tree underneath, presets on top. The orchestrator describes layouts with the same presets. |
| 22 | Same session twice | Not allowed anywhere in the workspace. Opening an already-open session focuses it. |
| 23 | Focus after an orchestrator edit | None. Its tool results and reply carry the tab's path; the user taps to go there. |
| 24 | Device focus storage | The URL only. Unread markers are in memory and reset on reload. No localStorage. |
| 25 | Tab names | Default: the session title, or "A + B" for two, "3 sessions" past that. A rename overrides, with `user` outranking `portal` as session titles do. |
| 26 | Terminals | Every pane has its own terminal toggle and height, independent. Open state and height are local to the device, not in the workspace. |
| 27 | Sidebar | The focused pane's session gets the active highlight. Other sessions open in the workspace get a small tab glyph on their row. |
| 28 | Libraries | Splits: `react-resizable-panels` (already installed, upgrade 4.12 to 4.14), nested, structure from our tree, sizes seeded on mount and applied from server pushes through its ref. Tabs: Radix Tabs from the installed `radix-ui`, force-mounted and hidden. Reorder, later: the stable `@dnd-kit/core` + `@dnd-kit/sortable` line, not `@dnd-kit/react` 0.x. Not dockview. |
| 29 | Dragging | None in round one: no tab reorder by drag, no drag-to-split. Presets and menus do the arranging. |
| 30 | Hidden tabs | The focused tab plus the 3 most recently focused stay mounted (their streams run). Others mount on focus from the history cache. Unread is computed from the session-list stream, so it works for unmounted tabs too. |

## Model

In `packages/contracts/src/workspace.ts` (wire types) and `packages/shared/src/workspace.ts` (the pure reducer, used by the server to apply operations and by the web app to apply them optimistically).

```ts
export type PaneNode = { kind: "pane"; id: string; sessionId: string | null }; // null: the start page
export type SplitNode = { kind: "split"; id: string; direction: "row" | "column"; children: LayoutNode[]; sizes: number[] }; // sizes sum to 100
export type LayoutNode = PaneNode | SplitNode;
export type Tab = { id: string; title: string | null; titleSource: "user" | "portal" | null; root: LayoutNode; createdAt: number };
export type Workspace = { tabs: Tab[]; version: number };
export type LayoutPreset = "single" | "columns-2" | "columns-3" | "rows-2" | "grid-2x2" | "one-beside-two";
```

Invariants, enforced by the reducer and checked by its tests:

- A session id appears in at most one pane across the workspace.
- At most 4 panes per tab, split depth at most 2, no split with fewer than 2 children (a split left with one child collapses into it).
- `sizes` has one entry per child, each at least 10, summing to 100.
- Ids are generated server-side (`crypto.randomUUID()`), stable for the life of the tab or pane.

Operations (`WorkspaceOp`), each a single JSON object; the reducer answers the new workspace plus, for opens, the location (`tabId`, `paneId`) so the caller can navigate:

| op | fields | effect |
|---|---|---|
| `open` | `sessionId` (or null for a start page), `target?` | If the session is already open: no change, return its location. Else `target` absent: new tab at the end. `target: { tabId, paneId, edge }` (`left`, `right`, `top`, `bottom`): split that pane. |
| `replace_pane` | `paneId`, `sessionId` | A start-page pane becomes the new session's pane. Also "open here". |
| `arrange` | `sessionIds[]` (0 to 4, nulls allowed for start pages), `preset`, `tabId?`, `title?` | Build the preset in a new tab, or rebuild `tabId`. Sessions already open elsewhere move (their old panes close). Slots past the list are start-page panes. If a rebuilt tab held sessions the preset has no room for, each moves to its own new tab after it. |
| `close_tab` | `tabId` | Remove the tab. |
| `close_pane` | `paneId` | Remove the pane; its parent collapses if one child is left; a tab with no panes is removed. |
| `move_tab` | `tabId`, `index` | Reorder. |
| `rename_tab` | `tabId`, `title` (1 to 60 chars, or null to clear), `source` | A `portal` rename never overwrites a `user` one. |
| `resize` | `splitId`, `sizes` | Normalised and clamped. Not logged to Activity. |

Deleting a session (route, orchestrator tool, lifecycle purge of removed sessions) runs `close_pane` for its pane, the way `tracked_sessions` cascades today.

## Server

### Store and service

- `apps/server/src/workspace/store.ts`: the row under `WORKSPACE_KEY = "workspace"` in `settings`, with the same load/save backend split and serialised mutation queue as `settings/last-used.ts`, so two devices' operations never interleave their read-modify-write. `version` increments on every write.
- `apps/server/src/workspace/service.ts`: `read()`, `apply(op, actor, context)`, `onSessionDeleted(id)`. `apply` runs the shared reducer, saves, emits `{ type: "workspace", workspace }` on the hub, and logs structural ops to Activity. Validation errors from the reducer (unknown tab, pane cap, duplicate session) become 400s or tool errors with the reducer's message.
- Registered like `tracked` is: a slice on the hub, routes in `app.ts`, `sessions.onDeleted` wired in `orchestrator/deps.ts`.

### Routes

| Method and path | Body | Response |
|---|---|---|
| `GET /api/workspace` | | `{ workspace }` |
| `POST /api/workspace/ops` | one `WorkspaceOp` | `{ workspace, location? }`; 400 for a malformed op, 404 for an unknown session, 409 when the reducer refuses (cap reached) |

Origin-checked like every mutation. Both act as `user`.

### Contract and events

- `OrchestratorEvent` gains `{ type: "workspace"; workspace: Workspace }` (`packages/contracts/src/orchestrator.ts`). The portal stream sends the workspace on connect, after the tracked list, and on every change.
- `POST /api/portal/messages` and `POST /api/portal/threads/:id/messages` accept an optional `view: { sessionId: string | null; tabId: string | null; paneId: string | null }` beside `message`. `parseUserMessage` stays as is; a new `parseView` validates it. The view is passed to `prepareTurn`, which appends one line to the system prompt: `You are looking at: session <short id> (<title>), in tab "<name>".` or `You are looking at: the Portal page, no session.` Background turns get nothing.

### Activity

New kinds under a `workspace.` prefix, each with `actor` and `refs.sessionId` where there is one, and `detail.tabId`:

`workspace.opened` · `workspace.closed` (tab or pane, `detail.what`) · `workspace.arranged` (`detail.preset`, `detail.sessionIds`) · `workspace.renamed` (`detail.from`, `detail.to`).

`resize` and `move_tab` are not logged.

## Orchestrator

Tools in `apps/server/src/orchestrator/workspace/tools.ts`, always offered on chat turns (like the tracked tools), none on background turns, none gated:

| Tool | Behaviour |
|---|---|
| `get_workspace()` | Read-only. The tabs in order, each with its name, preset-like shape (`row[pane, column[pane, pane]]`), and panes with session short id, title, state. Plus "the user is looking at" from this message's view. |
| `open_in_workspace({ sessionId, besideSessionId?, edge? })` | `open` in a new tab, or split the pane that holds `besideSessionId`. Returns the tab id and its path `/tabs/<id>`. Says so when the session was already open. |
| `arrange_tab({ sessionIds, preset, tabId?, title? })` | `arrange`. Returns the tab id and path. |
| `close_in_workspace({ tabId?, sessionId? })` | `close_tab`, or `close_pane` for the pane holding the session. |
| `rename_tab({ tabId, title })` | `rename_tab` as `portal`; refused with a note when the user named it. |

Session ids resolve through `requireSession` (full id or a unique 4+ character prefix). Tab ids are accepted whole or by 4+ character prefix through the same `pickById`.

Prompt guidance, `orchestrator/workspace/prompt.ts`, appended by `prompt.ts`:

- The workspace is where the user is working: tabs of sessions, some split side by side. Tracking is "watch this"; a tab is "I am working here". Do not open tabs for sessions you start unless asked.
- Only arrange the workspace in the conversation where the user asked. Never from a watch, job or background turn.
- When you open or arrange, say which tab and give its link; the user chooses when to look. You cannot change what a device shows.
- "This session", "the one I am looking at": the You-are-looking-at line names it.

World (`world/render.ts`): a short `Workspace tabs:` section after Tracked sessions, one line per tab (name, panes by short id and state), capped at 8 tabs. `WorldState` gains nothing: the section reads the workspace service directly, since the workspace is not snapshotted or diffed.

The message renderer: orchestrator replies already turn session mentions into links; tab paths (`/tabs/<id>`) render as in-app links the same way (verify how `PortalMessage` matches session links before building this).

## Web

### State

- `WorkspaceProvider` (`components/WorkspaceProvider.tsx`), mounted beside `SessionsProvider` in `Chat.tsx`. Loads `GET /api/workspace`, follows the portal stream's `workspace` event (the stream's copy wins over a slower REST read, the `tracked` pattern), and exposes `apply(op)`: runs the shared reducer optimistically, posts the op, adopts the server's answer, rolls back on failure with the server's message. `useWorkspace()` also answers `locate(sessionId)`.
- Focus is the URL. `lib/session-routes.ts` gains `tabPath(tabId, paneId?)`, `tabFromPath`, and marks `/sessions/<id>` and `/new` as resolvers. `ChatShell` resolves them once the workspace has loaded: `locate` or `apply(open)`, then `replaceState` to the tab path.
- Unread: an in-memory set of tab ids in the provider. The session-list stream patches `turnEndedAt` and `awaitingPermission`; when either advances for a session whose tab is not focused (or whose pane is hidden on mobile), the tab is marked. Focusing clears it. No persistence.

### The workspace view

`components/workspace/WorkspaceView.tsx` replaces the `SessionPane` branch of `ChatShell` (`Chat.tsx:698`): the tab strip, then the focused tab's layout. Also used when the path is a tab, `/sessions/<id>` (while resolving), or `/new`.

- **Tab strip** (`TabStrip.tsx`): Radix Tabs, controlled by the URL. Each trigger: the layout miniature (`TabIcon.tsx`, cells from the tree, dot tones from `sessionState`, unread ring), the name, a close button. A `…` menu per tab: rename (inline `RenameField` from `ProjectActions.tsx`), layout presets (submenu; picking one runs `arrange` with the tab's sessions in order), close, close others. A `+` at the end opens a start-page tab.
- **Layout** (`SplitTree.tsx`): renders the tree with `react-resizable-panels`. Each split is a `Group` keyed by its node id with `defaultLayout` from `sizes`, `onLayoutChanged` debounced into a `resize` op; a server push whose sizes differ from the last applied ones calls the group ref's `setLayout`. Each pane is a `Panel` holding `SessionPane` keyed by pane id. Rearranging a tab remounts its panes (round one, no dragging, so it is rare and the history cache makes it cheap); portalling pane content from a stable host is the follow-up if dragging arrives.
- **Focus**: `?pane=` names the focused pane; pointerdown or focus-within on a pane replaces the URL. The focused pane of a split gets a 1 px ring in the accent colour; a single-pane tab shows none.
- **Mounting**: the focused tab's panes render; the 3 most recently focused tabs stay mounted with `hidden`; others unmount. Hidden Radix content is force-mounted and hidden by attribute. Mounted panes share one event stream (`GET /api/sessions/streams?ids=…&since=…`, held by `lib/session-stream-hub.ts` in `SessionsProvider`): a browser allows six connections per host on plain HTTP, so the page holds three streams (list, portal, sessions) whatever the pane count.
- **Pane header**: `SessionHeader` gains a pane menu: split right, split down (both open a start-page pane beside this one), move to its own tab, close pane. The sidebar toggle stays only on the first pane of a tab.
- **Document title**: the focused session's title, else "Portal".

### `SessionPane` changes

- Terminal open state and height move from `ChatShell` into `SessionPane` (per pane, local), decision 26.
- `RoomBackground` leaves `SessionPane`; `WorkspaceView` renders one, driven by the focused pane's activity.
- Fixed DOM ids become per instance with `useId`: `sidebar-toggle`, `track-toggle`, `terminal-toggle`, `github-toggle`, `session-context`, `terminal-panel`, `terminal-new-tab`, the composer palette id. Focus-return code that looked them up gets the id through props or a ref.
- The start page renders inside a pane when `sessionId` is null; on create it runs `replace_pane` and the pane's URL updates. `initialSend` stays keyed by session id and works per pane.
- The GitHub inspector reads the focused pane's session.

### Sidebar

- `active` becomes the focused pane's session. Rows for sessions open elsewhere in the workspace show a small tab glyph (`PanelsTopLeft` from lucide) after the title.
- Row click: `locate` then focus, else `open`. Row menu gains "Open in new tab" (even when open: moves it) and "Open beside current" (splits the focused pane to the right).
- The project `+` opens a start-page tab with that project selected.

### Tracked panel

Unchanged, except "Open full page" goes through the resolver, which focuses or opens a tab.

### Mobile (below 768 px)

- `MobileWorkspace.tsx`: the flat pane list, in tab then tree order. Renders the focused pane only; the URL still names tab and pane.
- `PaneBar.tsx` under the composer: the current pane's state dot and title, "2 of 7", chevrons at both ends. Pointer-tracked horizontal swipe on the bar (threshold 40 px, vertical drift cancels) switches to the neighbour. Tap opens `PanesSheet.tsx`: every pane with icon, title, state badge, project, a close button per row, and "New session" at the bottom. The bar hides when `visualViewport.height` drops by more than 150 px (keyboard up), the way the composer hint hides on touch.
- Tablet, 768 to 1100 px: `SplitTree` renders tabs of 1 or 2 panes; larger tabs render the focused pane with `PaneBar` scoped to that tab.

### Preferences

None new. `portal.sidebar.*`, `portal.githubInspector.open`, `portal.tracked.*` stay.

## Tests

- `packages/shared`: the reducer, every op, every invariant, preset shapes, collapse on close, duplicate-session refusal, the "move overflow to new tabs" rule of `arrange`.
- Server: the store's serialised writes under concurrent ops; routes (400, 404, 409, Activity entries, the stream event); `onSessionDeleted` cascade from the delete route, the tool, and the removed-sessions purge; tools (prefix resolution, refusal to rename a user-named tab, `get_workspace` with and without a view); the You-are-looking-at line in `prepareTurn`; background turns offer no workspace tools.
- Web unit: route helpers (tab paths, resolvers), tab naming, the icon's cell list from a tree, unread derivation from list patches, mobile flat ordering.
- Playwright (`tests/ui/workspace.spec.ts`, fixtures beside `orchestrator-fixtures.ts`): open two sessions as tabs; split beside; close a pane collapses the split; rename; preset change; a `workspace` stream event from another device rearranges the view without moving focus; `/sessions/<id>` resolves to the right tab; `/new` opens a start-page pane that becomes the session. `portal-mobile.spec.ts` gains the bar, swipe, and sheet. Terminal in two panes at once.
- Live check on a scratch instance against a cloned DB (see the e2e recipe): the orchestrator arranges three review sessions into a preset from a chat turn and links the tab; the phone shows the same panes flat; closing one on the phone removes it on the desktop.

## Implementation order

1. Contract types, shared reducer with tests.
2. Server store, service, routes, stream event, Activity kinds, delete cascade. Tests.
3. Chat message `view` and the prompt line. Tests.
4. Orchestrator tools, prompt guidance, world section, tab links in replies. Tests.
5. Web: `WorkspaceProvider`, route helpers and resolvers, `SessionPane` per-instance ids and local terminal state, room background lifted. The app still shows one session, now as a one-tab workspace. No visible change beyond the strip.
6. Web: tab strip, icon, menus, presets, `SplitTree`, focus ring, mounting policy, document title, sidebar glyph and menu items, GitHub inspector follows focus.
7. Web: mobile flat view, pane bar, swipe, sheet, tablet rule.
8. Playwright specs, then the live check.

Commit per step as it lands green. Merge to main waits for Moses. The live instance needs a restart for the new routes and tools; there is no migration.

## Out of scope

- Named or multiple workspaces.
- Drag to reorder tabs, drag a pane to split, drag a session from the sidebar into a split.
- Keyboard shortcuts.
- The terminal page or Portal views inside a tab.
- Portalling pane content so rearranging never remounts.
- Per-device remembered focus beyond the URL.
- Any change to the tracked panel.
