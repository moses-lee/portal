import { expect, test, type Page, type Request } from "@playwright/test";
import type { Attachment, FileEntry, FileStat, FileView } from "@portal/contracts/files";
import type { StoredEvent } from "../../src/lib/types";
import { emit, setupPortal, tabUrl } from "./fixtures";
import { filePane, tab, workspaceOf } from "./workspace-fixtures";

/**
 * Files (docs/FILES.md): attachments in the composer, file links in replies, and the file pane.
 * `setupPortal` mocks the rest of `/api/**`; `mockFiles` answers the files routes and uploads from an
 * in-memory host file system, registered after it so it is asked first (Playwright tries the most
 * recently added route first) and falls back to the fixture for everything else.
 */

const HOME = "/home/tester";
/** Session s1's working directory in the fixtures (the worktree project). */
const CWD = "/workspace/portal-worktree";
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const NOTES = "# Notes\n\nSome **bold** words.\n\nLine five.\n";

type Node = { kind: "file"; data: Buffer; mtimeMs: number } | { kind: "dir"; mtimeMs: number };

function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function viewOf(path: string): FileView {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md") return "markdown";
  if (ext === "png") return "image";
  if (ext === "pdf") return "pdf";
  return "text";
}

const mimeOf = (path: string) =>
  ({ markdown: "text/markdown", image: "image/png", pdf: "application/pdf", text: "text/plain", binary: "application/octet-stream" })[viewOf(path)];

/**
 * The host's files as the routes in `@portal/contracts/files` see them. Paths resolve like the server's
 * `resolveFilePath`: `~` against HOME, relative against `cwd`. Parent directories are implied.
 */
async function mockFiles(page: Page, files: Record<string, string | Buffer>) {
  const fs = new Map<string, Node>();
  let clock = 1_700_000_000_000;
  const addDirs = (path: string) => {
    for (let at = path; at !== "/"; ) {
      at = at.slice(0, at.lastIndexOf("/")) || "/";
      if (!fs.has(at)) fs.set(at, { kind: "dir", mtimeMs: clock });
    }
  };
  const write = (path: string, content: string | Buffer) => {
    clock += 1000;
    fs.set(path, { kind: "file", data: Buffer.isBuffer(content) ? content : Buffer.from(content), mtimeMs: clock });
    addDirs(path);
  };
  fs.set(HOME, { kind: "dir", mtimeMs: clock });
  addDirs(HOME);
  for (const [path, content] of Object.entries(files)) write(path, content);

  const resolve = (input: string, cwd: string | null): string | null => {
    let path = input;
    if (path === "~" || path.startsWith("~/")) path = HOME + path.slice(1);
    if (path.startsWith("/")) return normalize(path);
    return cwd ? normalize(`${cwd}/${path}`) : null;
  };
  const statOf = (path: string): FileStat | null => {
    const node = fs.get(path);
    if (!node) return null;
    const size = node.kind === "file" ? node.data.byteLength : 64;
    return {
      path,
      kind: node.kind,
      size,
      mtimeMs: node.mtimeMs,
      version: `${node.mtimeMs}-${size}`,
      mimeType: node.kind === "dir" ? "inode/directory" : mimeOf(path),
      view: node.kind === "dir" ? null : viewOf(path),
    };
  };

  const log = {
    stats: [] as string[],
    exists: [] as { cwd?: string; paths: string[] }[],
    puts: [] as { path: string; ifMatch: string | null; body: string; status: number }[],
    uploads: [] as { sessionId: string; name: string; contentType: string | null; body: Buffer }[],
  };
  let uploadCount = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const target = () => resolve(url.searchParams.get("path") ?? "", url.searchParams.get("cwd"));

    const upload = path.match(/^\/api\/sessions\/([^/]+)\/uploads$/);
    if (upload && method === "POST") {
      const name = url.searchParams.get("name") ?? "file";
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      log.uploads.push({ sessionId: decodeURIComponent(upload[1]), name, contentType: request.headers()["content-type"] ?? null, body });
      const stored = `${HOME}/.portal/uploads/${upload[1]}/${String(++uploadCount).padStart(8, "0")}-${name}`;
      write(stored, body);
      const attachment: Attachment = { path: stored, name, mimeType: mimeOf(name), size: body.byteLength };
      return json({ attachment }, 201);
    }
    if (!path.startsWith("/api/files/")) return route.fallback();

    if (path === "/api/files/exists" && method === "POST") {
      const body = request.postDataJSON() as { cwd?: string; paths: string[] };
      log.exists.push(body);
      return json({ existing: body.paths.filter((p) => { const at = resolve(p, body.cwd ?? null); return !!at && fs.has(at); }) });
    }
    const at = target();
    if (path === "/api/files/stat") {
      log.stats.push(at ?? "");
      const stat = at ? statOf(at) : null;
      return stat ? json(stat) : json({ error: "Not found." }, 404);
    }
    if (path === "/api/files/list") {
      const node = at ? fs.get(at) : null;
      if (!at || !node) return json({ error: "Not found." }, 404);
      if (node.kind !== "dir") return json({ error: "Not a directory." }, 400);
      const prefix = at === "/" ? "/" : `${at}/`;
      const entries: FileEntry[] = [...fs.entries()]
        .filter(([p]) => p.startsWith(prefix) && p !== at && !p.slice(prefix.length).includes("/"))
        .map(([p, n]) => ({ name: p.slice(prefix.length), kind: n.kind, size: n.kind === "file" ? n.data.byteLength : 64, mtimeMs: n.mtimeMs }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
      return json({ path: at, entries, truncated: false });
    }
    if (path === "/api/files/raw" && method === "GET") {
      const node = at ? fs.get(at) : null;
      if (!at || !node || node.kind !== "file") return json({ error: "Not found." }, 404);
      return route.fulfill({ status: 200, contentType: mimeOf(at), body: node.data });
    }
    if (path === "/api/files/raw" && method === "PUT") {
      const ifMatch = request.headers()["if-match"] ?? null;
      const body = request.postData() ?? "";
      const current = at ? statOf(at) : null;
      const conflict = ifMatch ? current?.version !== ifMatch : !!current;
      log.puts.push({ path: at ?? "", ifMatch, body, status: conflict ? 409 : 200 });
      if (conflict) return json({ error: "The file changed on disk.", version: current?.version ?? null }, 409);
      write(at!, body);
      return json({ version: statOf(at!)!.version });
    }
    return json({ error: `Unexpected files request: ${method} ${path}` }, 400);
  });

  return {
    log,
    /** Something else (an agent) writes the file on disk. */
    write,
    stat: (path: string) => statOf(path),
  };
}

/** Session s1's history: a prompt and one settled agent reply with `reply` as its text. */
function replyHistory(reply: string): StoredEvent[] {
  const ts = Date.now();
  return [
    { type: "user", text: "Where are the notes?", seq: 0, ts },
    { type: "turn_start", seq: 1, ts },
    { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } }, seq: 2, ts },
    { type: "turn_end", stopReason: "end_turn", seq: 3, ts },
  ];
}

const LINK_REPLY = "Read [notes](/tmp/notes.md:3), then the [plan](docs/PLAN.md), but not [gone](/tmp/missing.txt).";

const filePaneOf = (page: Page, path: string) => page.locator(`[data-file-pane="${path}"]`);
const composerOf = (page: Page) => page.getByLabel("Message Claude Code", { exact: true });

/** Fails the test on any navigation of the page to a host path on the Portal origin (the old 404). */
function forbidHostPathNavigation(page: Page) {
  const bad: string[] = [];
  page.on("request", (request: Request) => {
    if (request.isNavigationRequest() && /\/(tmp|workspace|home)\//.test(new URL(request.url()).pathname)) bad.push(request.url());
  });
  page.on("popup", (popup) => bad.push(`popup: ${popup.url()}`));
  return bad;
}

test.describe("attachments", () => {
  test("an image attaches by the picker and by paste, ✕ removes it, and a send uploads then prompts with the attachments", async ({ page }) => {
    const fixture = await setupPortal(page);
    const files = await mockFiles(page, {});
    await page.goto("/sessions/s1");
    const composer = composerOf(page);
    await expect(composer).toBeVisible();
    const form = page.locator("form").filter({ has: composer });
    const chips = form.getByRole("list", { name: "Attachments" });

    // The 📎 button opens a hidden file input; picking adds a thumbnail chip.
    await expect(form.getByRole("button", { name: "Attach files" })).toBeEnabled();
    await form.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await expect(chips.getByRole("img", { name: "shot.png" })).toBeVisible();
    // An image with nothing typed may be sent on its own.
    await expect(form.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();

    // ✕ removes it.
    await form.getByRole("button", { name: "Remove shot.png" }).click();
    await expect(chips).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();

    // Paste: a clipboard holding only an image file attaches it.
    await composer.focus();
    await composer.evaluate((element, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...PNG]);
    await expect(chips.getByRole("img", { name: "pasted.png" })).toBeVisible();
    await form.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await expect(chips.getByRole("listitem")).toHaveCount(2);

    await composer.fill("what is in these?");
    await composer.press("Enter");

    // One upload per file, raw bytes, in the composer's order; then the prompt names their stored copies.
    await expect.poll(() => files.log.uploads.map((upload) => [upload.sessionId, upload.name])).toEqual([
      ["s1", "pasted.png"],
      ["s1", "shot.png"],
    ]);
    for (const upload of files.log.uploads) {
      expect(upload.body.equals(PNG)).toBe(true);
      expect(upload.contentType).toBe("application/octet-stream");
    }
    const stored: Attachment[] = [
      { path: `${HOME}/.portal/uploads/s1/00000001-pasted.png`, name: "pasted.png", mimeType: "image/png", size: PNG.byteLength },
      { path: `${HOME}/.portal/uploads/s1/00000002-shot.png`, name: "shot.png", mimeType: "image/png", size: PNG.byteLength },
    ];
    await expect.poll(() => fixture.requests.filter((r) => r.path === "/api/sessions/s1/prompt").map((r) => r.body)).toEqual([
      { text: "what is in these?", queue: true, attachments: stored },
    ]);
    await expect(chips).toHaveCount(0);
    await expect(composer).toHaveValue("");

    // The server logs the prompt with its attachments; the bubble shows them as thumbnails from the stored copies.
    await emit(page, { type: "user", text: "what is in these?", attachments: stored }, "message", 200);
    const messages = page.getByRole("log", { name: "Messages" });
    const thumb = messages.getByRole("img", { name: "shot.png" });
    await expect(thumb).toBeVisible();
    await expect(thumb).toHaveAttribute("src", `/api/files/raw?path=${encodeURIComponent(stored[1].path)}`);
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect(messages.getByRole("img", { name: "pasted.png" })).toBeVisible();
  });

  test("a prompt of only an attachment sends empty text", async ({ page }) => {
    const fixture = await setupPortal(page);
    const files = await mockFiles(page, {});
    await page.goto("/sessions/s1");
    const composer = composerOf(page);
    await expect(composer).toBeVisible();
    const form = page.locator("form").filter({ has: composer });
    await form.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await form.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => fixture.requests.filter((r) => r.path === "/api/sessions/s1/prompt").map((r) => r.body)).toEqual([
      {
        text: "",
        queue: true,
        attachments: [{ path: `${HOME}/.portal/uploads/s1/00000001-shot.png`, name: "shot.png", mimeType: "image/png", size: PNG.byteLength }],
      },
    ]);
    expect(files.log.uploads).toHaveLength(1);
  });
});

test.describe("links in replies", () => {
  const cases = [
    {
      name: "an absolute path with a line opens in Edit at that line",
      link: "notes",
      opened: "/tmp/notes.md",
      check: async (page: Page) => {
        const pane = filePaneOf(page, "/tmp/notes.md");
        // Markdown, but a line was asked for: the editor, not the preview.
        await expect(pane.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
        await expect(pane.locator("[data-file-preview]")).toHaveCount(0);
        await expect(pane.locator(".cm-content")).toContainText("Some **bold** words.");
        await expect(pane.locator(".cm-activeLine")).toHaveText("Some **bold** words.");
      },
    },
    {
      name: "a relative path resolves against the session's cwd",
      link: "plan",
      opened: `${CWD}/docs/PLAN.md`,
      check: async (page: Page) => {
        const pane = filePaneOf(page, `${CWD}/docs/PLAN.md`);
        await expect(pane.locator("[data-file-preview]").getByRole("heading", { name: "The plan" })).toBeVisible();
        await expect(pane.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "false");
      },
    },
    {
      name: "a missing path opens a pane saying Not found, with the nearest folder listed",
      link: "gone",
      opened: "/tmp/missing.txt",
      check: async (page: Page) => {
        const pane = filePaneOf(page, "/tmp/missing.txt");
        await expect(pane.getByText("Not found", { exact: true })).toBeVisible();
        await expect(pane.getByText("Nearest folder: /tmp")).toBeVisible();
        await expect(pane.locator('[data-entry="notes.md"]')).toBeVisible();
      },
    },
  ];
  for (const { name, link, opened, check } of cases) {
    test(name, async ({ page }) => {
      const fixture = await setupPortal(page, { history: replyHistory(LINK_REPLY) });
      await mockFiles(page, { "/tmp/notes.md": NOTES, [`${CWD}/docs/PLAN.md`]: "# The plan\n\nShip it.\n" });
      const bad = forbidHostPathNavigation(page);
      await page.goto("/sessions/s1");
      await expect(page).toHaveURL(tabUrl);
      const anchor = page.getByRole("log", { name: "Messages" }).getByRole("link", { name: link, exact: true });
      await expect(anchor).toBeVisible();
      // ⌘-click opens the raw bytes, never a Portal route.
      await expect(anchor).toHaveAttribute("href", /^\/api\/files\/raw\?path=/);
      await anchor.click();
      // A new workspace tab holds the file pane; the page stays on the workspace.
      await expect(filePaneOf(page, opened)).toBeVisible();
      await expect(page).toHaveURL(tabUrl);
      await expect(page.getByRole("tablist", { name: "Workspace tabs" }).getByRole("tab")).toHaveCount(2);
      expect(fixture.requests.filter((r) => r.path === "/api/workspace/ops").map((r) => r.body)).toContainEqual({ op: "open_file", path: opened });
      await check(page);
      await expect(page.getByText(/could not be found/i)).toHaveCount(0);
      expect(bad).toEqual([]);
    });
  }

  test("inline code naming a file that exists becomes a link once the reply settles; one that does not stays plain", async ({ page }) => {
    await setupPortal(page, { history: replyHistory("I changed `src/app.ts` and left `src/nope.ts` alone.") });
    const files = await mockFiles(page, { [`${CWD}/src/app.ts`]: "export const app = 1;\n" });
    await page.goto("/sessions/s1");
    const messages = page.getByRole("log", { name: "Messages" });
    const link = messages.getByRole("link", { name: "src/app.ts", exact: true });
    await expect(link).toBeVisible();
    // The candidates went in one batch, against the session's cwd.
    expect(files.log.exists).toContainEqual({ cwd: CWD, paths: expect.arrayContaining(["src/app.ts", "src/nope.ts"]) });
    await expect(messages.locator("code", { hasText: "src/nope.ts" })).toBeVisible();
    await expect(messages.getByRole("link", { name: "src/nope.ts" })).toHaveCount(0);
    await link.click();
    const pane = filePaneOf(page, `${CWD}/src/app.ts`);
    await expect(pane.locator(".cm-content")).toContainText("export const app = 1;");
  });
});

test.describe("the file pane", () => {
  test("markdown previews, edits, saves with If-Match, and a change on disk asks Reload or Overwrite", async ({ page }) => {
    await setupPortal(page, { workspace: workspaceOf([tab("t1", filePane("f1", "/tmp/notes.md"))]) });
    const files = await mockFiles(page, { "/tmp/notes.md": NOTES });
    const loaded = files.stat("/tmp/notes.md")!.version;
    await page.goto("/tabs/t1");
    const pane = filePaneOf(page, "/tmp/notes.md");
    const preview = pane.locator("[data-file-preview]");
    await expect(preview.getByRole("heading", { name: "Notes" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("bold");
    const save = pane.getByRole("button", { name: "Save (⌘S)" });
    await expect(save).toBeDisabled();

    // Edit, type, save: the PUT carries the version the pane loaded.
    await pane.getByRole("button", { name: "Edit" }).click();
    const editor = pane.locator(".cm-content");
    await expect(editor).toContainText("Line five.");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Added here.");
    await expect(pane.getByRole("img", { name: "Unsaved changes" })).toBeVisible();
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => files.log.puts.length).toBe(1);
    expect(files.log.puts[0]).toEqual({ path: "/tmp/notes.md", ifMatch: loaded, body: `${NOTES}Added here.`, status: 200 });
    await expect(pane.getByRole("img", { name: "Unsaved changes" })).toHaveCount(0);
    await expect(save).toBeDisabled();
    const saved = files.stat("/tmp/notes.md")!.version;

    // Back to the preview: it shows the edit.
    await pane.getByRole("button", { name: "Preview" }).click();
    await expect(preview).toContainText("Added here.");
    await pane.getByRole("button", { name: "Edit" }).click();

    // More edits, then an agent writes the file: the save is refused and the dialog asks.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Mine.");
    files.write("/tmp/notes.md", "# Notes\n\nAn agent rewrote this.\n");
    const agentVersion = files.stat("/tmp/notes.md")!.version;
    await save.click();
    const dialog = page.getByRole("dialog", { name: "The file changed on disk" });
    await expect(dialog).toBeVisible();
    expect(files.log.puts[1]).toMatchObject({ ifMatch: saved, status: 409 });
    await expect(dialog.getByRole("button", { name: "Reload" })).toBeVisible();

    // Reload drops the edits and shows the agent's version.
    await dialog.getByRole("button", { name: "Reload" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pane.getByRole("img", { name: "Unsaved changes" })).toHaveCount(0);
    await expect(pane.getByText("An agent rewrote this.")).toBeVisible();

    // Again, this time Overwrite: it re-PUTs over the version the conflict reported.
    if (await pane.getByRole("button", { name: "Edit" }).isVisible()) await pane.getByRole("button", { name: "Edit" }).click();
    await expect(editor).toContainText("An agent rewrote this.");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("My line.");
    files.write("/tmp/notes.md", "# Notes\n\nThe agent again.\n");
    const second = files.stat("/tmp/notes.md")!.version;
    expect(second).not.toBe(agentVersion);
    await save.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Overwrite" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => files.log.puts.slice(2).map((put) => [put.ifMatch, put.status])).toEqual([
      [agentVersion, 409],
      [second, 200],
    ]);
    expect(files.log.puts[3].body).toBe("# Notes\n\nAn agent rewrote this.\nMy line.");
    await expect(pane.getByRole("img", { name: "Unsaved changes" })).toHaveCount(0);
  });

  test("a directory lists its entries; choosing one shows that file in the same pane", async ({ page }) => {
    const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", filePane("f1", `${CWD}/docs`))]) });
    await mockFiles(page, {
      [`${CWD}/docs/PLAN.md`]: "# The plan\n",
      [`${CWD}/docs/notes.txt`]: "plain text\n",
      [`${CWD}/docs/drafts/one.md`]: "# One\n",
    });
    await page.goto("/tabs/t1");
    const listing = page.getByRole("list", { name: `Contents of ${CWD}/docs` });
    await expect(listing).toBeVisible();
    // Directories first, then files; a `..` row while there is a parent.
    await expect(listing.locator("[data-entry]")).toHaveText([/^drafts\//, /^notes\.txt/, /^PLAN\.md/]);
    await expect(listing.getByRole("button", { name: ".." })).toBeVisible();
    await listing.locator('[data-entry="PLAN.md"]').click();
    await expect(filePaneOf(page, `${CWD}/docs/PLAN.md`).getByRole("heading", { name: "The plan" })).toBeVisible();
    await expect(filePaneOf(page, `${CWD}/docs`)).toHaveCount(0);
    await expect(page).toHaveURL(/\/tabs\/t1$/);
    expect(fixture.requests.filter((r) => r.path === "/api/workspace/ops").map((r) => r.body)).toEqual([
      { op: "replace_file", paneId: "f1", path: `${CWD}/docs/PLAN.md` },
    ]);
    // Reveal folder goes back to the listing in the same pane.
    await filePaneOf(page, `${CWD}/docs/PLAN.md`).getByRole("button", { name: "Reveal folder" }).click();
    await expect(page.getByRole("list", { name: `Contents of ${CWD}/docs` })).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the composer offers Attach, and a file link opens its pane full screen", async ({ page }) => {
    await setupPortal(page, { history: replyHistory(LINK_REPLY) });
    await mockFiles(page, { "/tmp/notes.md": NOTES, [`${CWD}/docs/PLAN.md`]: "# The plan\n" });
    const bad = forbidHostPathNavigation(page);
    await page.goto("/sessions/s1");
    await expect(composerOf(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach files" })).toBeInViewport();
    await page.getByRole("log", { name: "Messages" }).getByRole("link", { name: "plan", exact: true }).click();
    const pane = filePaneOf(page, `${CWD}/docs/PLAN.md`);
    await expect(pane.getByRole("heading", { name: "The plan" })).toBeVisible();
    // Full screen: the pane spans the width, and the session's composer is no longer shown.
    const box = (await pane.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(380);
    expect(box.height).toBeGreaterThan(600);
    await expect(composerOf(page)).toBeHidden();
    await expect(pane.getByRole("button", { name: "Edit" })).toBeInViewport();
    await expect(page).toHaveURL(tabUrl);
    expect(bad).toEqual([]);
  });
});
