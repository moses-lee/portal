# Files: attachments to agents, and a file viewer/editor

Date: 2026-10-22. Status: built on branch `file-viewer` (uncommitted), reviewed, and live-checked with Claude and Codex; see "As built". Not merged.

## Why

Portal is used over Tailscale from other devices, often a phone. There is no way to read a file an agent wrote (a plan, a report, a screenshot it saved), and no way to hand an agent a file (a screenshot of a bug, a PDF, a CSV). Today the only file content Portal shows is what an agent puts in a tool result: diffs and inline images in tool cards.

## Decisions on record

Moses's calls (2026-10-22):

| # | Decision |
|---|---|
| 1 | The viewer opens **any path** on the host, not only the session's worktree. |
| 2 | A file opens as a **workspace tab** (a pane like a session's). |
| 3 | The viewer **edits** as well as reads. |
| 4 | Uploads are stored in **`~/.portal/uploads/<sessionId>/`**, outside the worktree (git stays clean). |
| 5 | Attachments are **agent-agnostic**: Claude and Codex on day one, any ACP agent after. |

My calls (open to change in review):

| # | Decision | Why |
|---|---|---|
| 6 | Images go to the agent as ACP `image` blocks when it advertises `promptCapabilities.image`; every attachment (images included) also goes as a `resource_link` to its stored path. | ACP requires every agent to accept `text` and `resource_link`, so the link is the agent-agnostic floor, and the agent can `cp` the file into the repo. Both bundled adapters advertise `image: true` (claude-agent-acp 0.81, codex-acp 2.2). |
| 7 | Files upload **on send**, not on attach. The composer holds them as `File`s with local previews. | A start page has no session id yet, and decision 4 files uploads by session. One path for both. Attachments do not survive a reload (drafts stay text-only). |
| 8 | The upload body is raw bytes (`fetch(url, { body: file })`), one file per request. | No `@fastify/multipart` needed, and progress and failure are per file. |
| 9 | Limits: 25 MB per file, 10 files per prompt. Before uploading, images larger than 3.75 MB (5 MB once base64-encoded) or longer than 2576 px on any edge are re-encoded to JPEG in the browser. | Phone photos are 3 to 12 MB. The Claude API refuses images over 5 MB and downsizes past ~1568 px anyway. The original is not needed for "look at this". |
| 10 | The editor is **CodeMirror 6**, lazy-loaded. | It is small, handles touch well, and has language modes. Monaco is heavy and poor on phones. |
| 11 | Markdown opens in a rendered **Preview** (via `PortalMarkdown`) with an **Edit** toggle. Code and text open straight in the editor. | The main case is "read the .md the agent wrote". |
| 12 | Saving is guarded: `PUT` carries the version the editor loaded, and a file changed on disk since then returns 409. The pane then offers **Reload** (drop my edits) or **Overwrite**. | Agents write files while you look at them. Silent clobbering either way loses work. |
| 13 | A file pane that is visible and has no unsaved edits refreshes on window focus and every 5 s, using a cheap `stat`. | It follows an agent that is still writing, with no file watcher to manage. |
| 14 | Paths in agent text become links **only when they exist**. The client batches candidate paths to `POST /api/files/exists`. | Linking everything that looks like a path gives broken links and false positives (`a/b` in prose). |
| 15 | Opening a directory shows a listing; entries open in the same pane. | Gives browsing for "anything" (decision 1) without building a tree. |
| 16 | A path opens in at most one pane, the same as a session. Opening it again focuses that pane. | Matches the existing workspace rule, and avoids two editors on one file. |
| 17 | Uploads are removed when their session is deleted or purged. | They belong to the session (decision 4). |

## Server

### Paths

`resolveFilePath(input, cwd?)` in `apps/server/src/lib/fs-paths.ts`:
- expands `~` (`expandHome`);
- resolves a relative path against `cwd`, which is the session's cwd that the client sends; it is required when `input` is relative;
- realpaths the parent of a file that does not exist yet.

There is no allow-list (decision 1). Portal's terminals already give the same reach to anyone on the tailnet.

### Routes (`apps/server/src/files/routes.ts`)

Every write route calls `rejectCrossOrigin`.

| Route | Does |
|---|---|
| `GET /api/files/stat?path=&cwd=` | `{ path, kind: "file" \| "dir", size, mtimeMs, version, mimeType, view: "text" \| "markdown" \| "image" \| "pdf" \| "binary" }`. `version` is `${mtimeMs}-${size}`. 404 when missing. |
| `GET /api/files/raw?path=&cwd=&download=1` | Streams the bytes with their MIME type. `download=1` adds `Content-Disposition: attachment`. `ETag` is the `version`. |
| `GET /api/files/list?path=&cwd=` | Lists a directory: `{ entries: [{ name, kind, size, mtimeMs }] }`, directories first. Hidden files are included, capped at 2,000 entries. |
| `PUT /api/files/raw?path=&cwd=` | Saves a text body (up to 2 MB) with `If-Match: <version>`. Answers 409 `{ version }` on a mismatch, 200 `{ version }` on success. Without `If-Match` it creates the file and refuses to overwrite one that exists. |
| `POST /api/files/exists` | Takes `{ cwd, paths: string[] }` (up to 200) and answers `{ existing: string[] }`. Used for linkifying (decision 14). |
| `POST /api/sessions/:id/uploads?name=` | Takes raw body bytes. Writes `~/.portal/uploads/<id>/<random8>-<safeName>` and answers `{ attachment }`. 413 over 25 MB. |

The view kind comes from the extension, with a sniff of the first 8 KB for NUL bytes, which marks a file as binary. Text over 2 MB is read-only and shows the first 2 MB with a download link.

A FIFO, socket or device is never opened: `stat` reports it as `kind: "file"`, `view: "binary"`, and `raw` (GET and PUT) answers 400 "Not a regular file". A save writes a temporary file and renames it over the old one (keeping its mode, and its owner when allowed), except for a file with other hard links or in a folder Portal cannot create files in: that one is overwritten in place, so links keep sharing it. Either way the version is checked again just before the write.

### Prompts

```ts
// packages/contracts/src/types.ts
type Attachment = { path: string; name: string; mimeType: string; size: number };
```

- `POST /api/sessions/:id/prompt` and the queue `PATCH` take `attachments?: Attachment[]`. A prompt may have empty `text` when it has attachments. Each `path` must be under `uploads/<id>/`; anything else gets a 400.
- `QueuedPrompt` and the `user` event both gain `attachments?: Attachment[]`, so transcripts, the queue and search backfill carry them. Search indexes attachment names.
- `acp-runtime.ts` (`session/prompt`, currently line 1286) builds the blocks in this order:
  1. `text`, when present;
  2. for each image, when `promptCapabilities.image` is set, `{ type: "image", data, mimeType }`;
  3. for every attachment, `{ type: "resource_link", uri: "file://<path>", name, mimeType, size }`.

  The capabilities are already stored on `instance.capabilities`.
- During the build I will check live that both adapters really pass `resource_link` through to the model. Any adapter that drops it gets a text fallback line instead: `Attached: <path>`.

## Web

### Composer (`ChatComposer.tsx`)

- Attach files three ways:
  - 📎 button: a file `<input multiple>`; on iOS it offers Photo Library, Take Photo and Files;
  - paste: images or files from the clipboard;
  - drag-drop onto the composer, with a drop highlight.
- Attachments show as a row above the text: thumbnails for images, name and size chips for other files, ✕ to remove.
- On send:
  1. resize (decision 9);
  2. upload each file with progress on its chip;
  3. send the prompt.

  A failed upload keeps the composer intact and marks the chip.
- Session panes and the start page both support this. The start page uploads after it creates the session (`Chat.tsx`).
- Queued prompts show their attachments. Editing a queued prompt can remove them but not add new ones (kept simple).

### Transcript

- User bubbles show their attachments: thumbnails served from `/api/files/raw`, and chips for other files. Tapping opens a file pane.
- Agent markdown links: today `Conversation.tsx` opens every link in a new browser tab, so `[notes](/tmp/file.txt)` loads `<portal>/tmp/file.txt` and 404s. Session replies and `PortalMarkdown` will both classify `href` as follows, first match wins:
  1. `http(s):`, `mailto:` and other schemes go to a new browser tab, as now;
  2. a Portal route (`inAppLinkPath`: `/tabs/…`, `/sessions/…`) navigates in place, as `PortalMarkdown` does now;
  3. `file://…`, `/abs/path`, `~/…` and relative paths (`docs/PLAN.md`, `./x`) open a **file pane**, with relative paths resolved against the session cwd.

  A line suffix (`:42`, `:42:7`, `#L42`) is stripped from the path and scrolls the editor to that line. These links are not checked for existence: the agent linked them on purpose, and a missing file opens a pane saying "Not found", with its path and a listing of the nearest parent that exists. Middle-click and ⌘-click open the raw file (`/api/files/raw`) in a browser tab.
- Agent text: inline code and bare tokens that look like paths (contain `/` or end in a known extension) are checked once per message through `/api/files/exists`, against the session cwd. Existing ones render as links that open a file pane.
- Tool cards: the paths in `locations` and in `DiffView` headers become the same links.

### File pane

- Workspace model:
  - a new leaf `{ kind: "file"; id: string; path: string }` beside `PaneNode` in `packages/contracts/src/workspace.ts`;
  - a new op `{ op: "open_file"; path; target? }` with the same semantics as `open`;
  - the reducer's walkers and `validateWorkspace` are updated for the new leaf.
- `FilePane.tsx` header:
  - path, with the home directory shown as `~`;
  - Preview/Edit toggle for markdown;
  - Save button, enabled when there are unsaved edits; ⌘S also saves;
  - Download;
  - Copy path;
  - "Reveal folder", which opens the parent directory listing.
- Body by view:
  - markdown: Preview or CodeMirror;
  - text: CodeMirror with the language picked from the extension;
  - image: fit to the pane, tap for actual size;
  - pdf: `<iframe>` of the raw URL (Safari and Chrome render it);
  - binary: size and Download;
  - dir: the listing.
- The tab icon and title use the file name. Closing a pane with unsaved edits asks first. Unsaved edits are kept by pane outside the component, so a layout change that remounts the pane (a split, a collapse) brings them back; they go once saved, discarded, or the pane closes.
- An "Open file…" item in a session's pane menu takes a path, relative to the session's cwd or absolute, and lands on the cwd's listing.
- Mobile: the same pane, full screen, like sessions. CodeMirror's touch editing; Save stays in the header.

## Tests

- Server unit tests:
  - `resolveFilePath`: `~`, relative paths with and without `cwd`, symlinks, missing files;
  - view-kind detection;
  - uploads: name sanitizing, the 413 cap, rejecting attachment paths outside `uploads/<id>`;
  - the 409 on version mismatch;
  - prompt block building for each capability combination.
- Reducer tests for the file leaf and `open_file`, including dedupe and splits.
- Playwright:
  - attach an image by picker and by paste, send, and see the thumbnail in the bubble;
  - a fake agent's message linkifies an existing path;
  - a markdown link to `/tmp/<file>:3`, to a relative path and to a missing path each open a file pane, at the line or showing "Not found", never a 404 browser tab;
  - open it, edit, save, then change it on disk and see the 409 dialog.
- A live check with real Claude and Codex sessions: send a screenshot and a PDF, and confirm each agent describes the image and reads the PDF by path.

## Implementation order

1. Server: path resolution, the files routes, and uploads with tests.
2. Contract and runtime: `Attachment`, prompt blocks, queue and transcript fields.
3. Composer: attach, preview, resize, upload, send; attachments in bubbles.
4. Workspace: file leaf, `open_file`, `FilePane` (preview, viewer, CodeMirror editor with guarded save, directory listing).
5. Links: paths in agent text, tool-card paths, "Open file…".
6. Cleanup of uploads when a session is deleted or purged; docs "As built"; Playwright; the live check.

## Out of scope (round one)

- Attachments in the Agent (orchestrator) composer.
- A file tree sidebar, fuzzy file search, git changed-files list.
- Orchestrator tools to open files in the workspace.
- Image annotation, multi-file diff/review UI.

## As built (2026-10-22)

Built by four parallel agents (server, composer, workspace/file pane, links), reviewed by two more, fixed, then checked live. Calls made during the build:

**Server**
- **Raw responses:**
  - Images, PDFs, audio and video are served with their real types.
  - HTML is served as HTML, and HTML and SVG get `Content-Security-Policy: sandbox`.
  - Other text, code included, is served as `text/plain`.
  - Every response has `nosniff`, `no-cache` and a quoted ETag, and `If-None-Match` gets a 304.
  - There is no Range support.
- **Saving:** `If-Match` takes the bare or the quoted version. A save to a file deleted since it was opened returns 409 with `version: null`.
- **Uploads:**
  - They live in `<portalHome>/uploads/<sessionId>/<random8>-<ascii-name>`; the original name is kept in the attachment.
  - Paths are canonical (`/private/tmp/...` on macOS).
  - `application/octet-stream` uploads take their MIME type from the extension.
- **Images sent to the agent:** only png, jpeg, gif and webp up to `MAX_PROMPT_IMAGE_BYTES` (3.75 MB) go inline. Larger ones go as a link only, which is why the browser resizes at that size (decision 9 amended).
- **`resource_link`:** both adapters render it as `[@name](file://…)` text and neither reads the file, so the agent opens it by path. No `Attached:` fallback was needed.
- **Prompt text:** whitespace-only text with attachments sends no text block, and `sendPrompt`/`sendOrQueue` trim.
- **Prompt to an unknown session:** still 409, which an existing test expects.
- **Queue `PATCH`:** without `attachments` it keeps the existing ones; with a list it keeps the matching subset, and adding one is a 400.
- **Upload cleanup:** uploads are removed on the shared delete path (the delete route, purge, project removal and the orchestrator's `delete_session`).

**Workspace**
- **Helpers:** `panesOf`/`allPanes` still mean session and start panes. `leavesOf`/`allLeaves`/`locateFile` include file panes. Caps, focus, `?pane=` and unread count every leaf.
- **New op `replace_file { paneId, path }`:**
  - It points a file pane at another path; directory listings and Reveal folder use it.
  - If the path is already open elsewhere, it focuses that pane.
  - It is not logged to Activity.
- **Paths:** they are normalized (`//`, `/./`, `..`, trailing `/`) in ops, so they dedupe. `validateWorkspace` stays exact, so stored workspaces still load.
- **`arrange`:** it moves file panes from a rebuilt tab to their own tabs after it.
- **Orchestrator:**
  - `get_workspace` lists file panes as `{ paneId, file }`.
  - The world view shows `file <path>`.
  - "You are looking at" names the file.
  - There are no new tools.

**Web**
- **`useOpenFile`:** the server resolves the path. A missing path is built locally, with `~` resolved by the server once. The line is handed over in memory, not in the URL. A link with a line opens markdown in Edit.
- **Unsaved edits:**
  - They live in a module store keyed by pane id, holding the path, text and base version, so a remount from a split or collapse restores them.
  - They are cleared on save, Reload, or when the pane closes.
  - Close, close-others, move-to-own-tab, arrange and in-pane navigation ask first with a plain `confirm`, and `beforeunload` warns.
  - Panes with unsaved edits stay mounted (hidden) where they would otherwise unmount.
- **Background refresh:** it re-checks dirty, saving and version after every await, so typing or a save during a refresh is never overwritten.
- **Editor:** One Dark on an opaque background. Unlike the glass panes, it does not let the room show through; this can be polished later.
- **Links:**
  - `classifyHref` leaves `localhost:3000`, `host:port`, `?q` and `C:\…` as plain text, drops `#section` from file paths, and keeps `#L<n>`.
  - react-markdown's URL filter is widened to keep `file://` and `name:line` hrefs; `javascript:` is still dropped.
  - Bare path words in prose are linked too, not only inline code, but only when they exist. The exists cache lasts for the page's life.
  - Agent (orchestrator) replies link absolute and `~` paths only, and check only once a reply settles.
- **Attachments:**
  - Pending attachments are held per draft key in memory, so every view of a session shares them.
  - The start page hands them to the new session, including through "Start an empty conversation".
  - Uploads already in flight are shared, so two sends never upload twice.
  - Stop gives back queued prompts' attachments, including those of a prompt being edited.
- **Browser tab title:** the focused file's name.

**Verification**
- Unit tests: shared 126, web 251, server 866. One server test fails, room-routes "the portal stream opens with the room's state…"; it predates this branch (Agent queue commit `cba8617`) and is untouched here.
- Playwright: `files.spec.ts` 9/9; with the workspace, prompt-queue and portal-mobile specs, 45/45.
- Live check (scratch server and fresh DB): Claude Code and Codex each got a PNG and a PDF. Both described the image without tools, read the PDF's codeword from its path, and wrote `notes/summary.md`. Codex replied with a `/private/tmp/…/summary.md` markdown link. In a real browser, clicking it opened a file tab (no 404), and editing plus ⌘S saved the file to disk.

**Known gaps**
- A remounted pane with unsaved edits loses them if the reload after the remount fails.
- Cancelling the discard prompt when closing a tab from the strip still moves keyboard focus to the neighbouring tab.
- DNS rebinding (from review; it predates this work): `rejectCrossOrigin` compares Origin with Host, and GET routes have no check, so a rebinding page could read files. Terminals already allowed as much. A Host allow-list would close it.

