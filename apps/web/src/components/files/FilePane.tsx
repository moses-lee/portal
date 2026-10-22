"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Check, Copy, Download, Eye, FolderOpen, LayoutPanelLeft, PanelLeft, PencilLine, Save, SquareArrowOutUpRight, SquareSplitHorizontal, SquareSplitVertical, X } from "lucide-react";
import type { FileListing, FileStat } from "@portal/contracts/files";
import { MAX_EDITABLE_BYTES } from "@portal/contracts/files";
import { fileName } from "@portal/shared/workspace";
import IconButton from "../IconButton";
import PortalMarkdown from "../PortalMarkdown";
import ResponsiveDialog from "../ResponsiveDialog";
import { ContextActions, MenuItem, MenuSeparator } from "../ActionMenu";
import type { PaneMenu } from "../SessionHeader";
import DirectoryListing from "./DirectoryListing";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { copyText } from "@/lib/clipboard";
import {
  confirmDiscard,
  displayFilePath,
  formatBytes,
  homeDirectory,
  listDirectory,
  paneDraft,
  parentPath,
  rawUrl,
  readText,
  saveText,
  setPaneDirty,
  statFile,
  subscribeLines,
  takeLine,
} from "@/lib/files";

// CodeMirror is only needed once a text file is open.
const Editor = dynamic(() => import("./Editor"), {
  ssr: false,
  loading: () => <p className="p-5 text-xs text-muted-foreground">Opening editor…</p>,
});

/** How often a visible pane with no unsaved edits checks the file for changes (decision 13). */
const REFRESH_MS = 5000;

export type FilePaneProps = {
  /** The workspace pane this is. */
  paneId: string;
  /** The absolute path the pane shows (a file or a directory). */
  path: string;
  /** Only the first pane of a tab carries the sidebar toggle. */
  showSidebarToggle?: boolean;
  onOpenSidebar: (opener: HTMLElement) => void;
  /** Split, move to its own tab, close: the same menu a session pane has. */
  pane: PaneMenu;
  /** Show another path in this pane (a listing's entry, "Reveal folder"). */
  onNavigate: (path: string) => void;
};

/**
 * A file or directory in a workspace pane (docs/FILES.md, "File pane"). Keyed by path inside, so
 * browsing to another path starts clean.
 */
export default function FilePane(props: FilePaneProps) {
  return <FileView key={props.path} {...props} />;
}

/** What the pane has read of its path. */
type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** Missing: the nearest folder above it that exists, listed, so the user can find what they meant. */
  | { kind: "missing"; nearest: FileListing | null }
  | { kind: "dir"; stat: FileStat; listing: FileListing }
  /** `text` for the text and markdown views (cut at `MAX_EDITABLE_BYTES`, then `truncated`). */
  | { kind: "file"; stat: FileStat; text: string | null; truncated: boolean };

async function load(path: string, signal?: AbortSignal): Promise<Loaded> {
  const result = await statFile(path, null, signal);
  if (result.kind === "error") return { kind: "error", message: result.message };
  if (result.kind === "missing") return { kind: "missing", nearest: await nearestListing(path, signal) };
  const { stat } = result;
  try {
    if (stat.kind === "dir") return { kind: "dir", stat, listing: await listDirectory(stat.path, signal) };
    if (stat.view !== "text" && stat.view !== "markdown") return { kind: "file", stat, text: null, truncated: false };
    const { text, truncated } = await readText(stat.path, MAX_EDITABLE_BYTES, signal);
    return { kind: "file", stat, text, truncated };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "error", message: error instanceof Error ? error.message : `Could not read ${path}.` };
  }
}

/** The closest existing folder above `path`, listed; null when none can be read. */
async function nearestListing(path: string, signal?: AbortSignal): Promise<FileListing | null> {
  for (let at = parentPath(path); at !== null; at = parentPath(at)) {
    const result = await statFile(at, null, signal);
    if (result.kind === "ok" && result.stat.kind === "dir") return listDirectory(result.stat.path, signal).catch(() => null);
    if (result.kind === "error") return null;
  }
  return null;
}

/** A save refused because the file changed on disk since it was loaded (decision 12): its version now, null when it is gone. */
type Conflict = { version: string | null };

function FileView({ paneId, path, showSidebarToggle = false, onOpenSidebar, pane, onNavigate }: FilePaneProps) {
  const root = useRef<HTMLDivElement>(null);
  /** Edits this pane held when it last unmounted (a split or collapse remounts it): taken back once the file loads. */
  const [restored] = useState(() => paneDraft(paneId, path));
  const [home, setHome] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  /** Bumped to remount the editor on a newly loaded version. */
  const [docKey, setDocKey] = useState(0);
  const [dirty, setDirty] = useState(restored !== null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /** Markdown shows rendered first (decision 11); a requested line, or edits taken back, open the editor instead. */
  const [mode, setMode] = useState<"preview" | "edit">(restored ? "edit" : "preview");
  /** The markdown editor stays mounted (hidden) once opened, so toggling keeps its undo history. */
  const [editorOpened, setEditorOpened] = useState(restored !== null);
  const [preview, setPreview] = useState<string | null>(null);
  /** A line to show, until the editor has shown it (a later reload must not jump back to it). */
  const [goTo, setGoTo] = useState<{ line: number; nonce: number } | null>(null);
  /** Reads the editor's document; the loaded text until the first edit. */
  const textOf = useRef<() => string>(() => restored?.text ?? "");
  // What the async paths (refresh, save) read after an await: the state as of now, not of their render.
  const current = useRef<Loaded>(loaded);
  const versionOf = useRef<string | null>(restored?.version ?? null);
  const dirtyNow = useRef(dirty);
  const savingNow = useRef(false);
  const conflictNow = useRef(false);
  /** Bumped by every load taken and save done, so a refresh that started before one drops what it read. */
  const generation = useRef(0);
  const show = useCallback((next: Loaded) => {
    current.current = next;
    versionOf.current = next.kind === "file" || next.kind === "dir" ? next.stat.version : null;
    setLoaded(next);
  }, []);
  const markDirty = useCallback((value: boolean) => {
    dirtyNow.current = value;
    setDirty(value);
  }, []);
  const markSaving = (value: boolean) => {
    savingNow.current = value;
    setSaving(value);
  };
  const markConflict = (value: Conflict | null) => {
    conflictNow.current = value !== null;
    setConflict(value);
  };

  useEffect(() => {
    let live = true;
    void homeDirectory().then((dir) => live && setHome(dir));
    return () => {
      live = false;
    };
  }, []);

  /**
   * Take what was just read: a new version remounts the editor with it, edits gone (only reached
   * with none, or on Reload). With `keep` (edits taken back after a remount), the editor opens on
   * them instead, still unsaved and over the version they were made on.
   */
  const adopt = useCallback(
    (read: Loaded, keep: { text: string; version: string | null } | null = null) => {
      generation.current++;
      const kept = keep && read.kind === "file" && read.text !== null && !read.truncated ? keep : null;
      const next =
        kept && read.kind === "file" ? { ...read, text: kept.text, stat: { ...read.stat, version: kept.version ?? read.stat.version } } : read;
      show(next);
      if (next.kind === "file" && next.text !== null) {
        const text = next.text;
        textOf.current = () => text;
        setPreview(text);
      }
      markDirty(kept !== null);
      setDocKey((key) => key + 1);
    },
    [show, markDirty],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(path, controller.signal).then((next) => adopt(next, restored), () => {});
    return () => controller.abort();
  }, [path, adopt, restored]);

  // A line asked for this path (a link like `PLAN.md:42`), now or later while the pane is open.
  useEffect(() => {
    let nonce = 0;
    const take = () => {
      const line = takeLine(path);
      if (line === null) return;
      setGoTo({ line, nonce: ++nonce });
      setMode("edit");
      setEditorOpened(true);
    };
    take();
    return subscribeLines((asked) => {
      if (asked === path) take();
    });
  }, [path]);

  // Unsaved edits: closing this pane asks first, and so does leaving the page. They are not
  // dropped on unmount: a layout change remounts the pane, which takes them back (`restored`).
  const owner = useRef(paneId);
  useEffect(() => {
    // The server replaced an optimistic pane id: the edits move with the pane.
    if (owner.current !== paneId) setPaneDirty(owner.current, null);
    owner.current = paneId;
    setPaneDirty(paneId, dirty ? { path, text: () => textOf.current(), version: () => versionOf.current } : null);
  }, [paneId, path, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Decision 13: while the pane shows and holds no edits, a cheap stat on window focus and every
  // 5 s; a new version (or the file appearing or going) reloads it. Edits typed, a save, or a load
  // taken while it waits make what it read stale: checked again after each await.
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    const held = () => dirtyNow.current || savingNow.current || conflictNow.current;
    if (held() || refreshing.current) return;
    if (document.visibilityState !== "visible" || !(root.current?.checkVisibility?.() ?? true)) return;
    refreshing.current = true;
    const started = generation.current;
    const stale = () => held() || generation.current !== started;
    try {
      const result = await statFile(path);
      if (stale()) return;
      const changed =
        result.kind === "ok"
          ? result.stat.version !== versionOf.current
          : result.kind === "missing"
            ? current.current.kind !== "missing"
            : false;
      if (!changed) return;
      const next = await load(path);
      if (!stale()) adopt(next);
    } finally {
      refreshing.current = false;
    }
  }, [path, adopt]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const focused = () => void refresh();
    window.addEventListener("focus", focused);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focused);
    };
  }, [refresh]);

  const editable = loaded.kind === "file" && loaded.text !== null && !loaded.truncated;
  const canSave = editable && dirty && !saving;

  /** PUT over `over` (the loaded version, or the one a conflict reported); a 409 opens the Reload / Overwrite dialog. */
  const save = async (over: string | null = versionOf.current) => {
    const saved = current.current;
    if (saved.kind !== "file" || savingNow.current) return;
    markSaving(true);
    setSaveError(null);
    const text = textOf.current();
    const result = await saveText(saved.stat.path, text, over);
    markSaving(false);
    if (result.kind === "conflict") return markConflict({ version: result.version });
    if (result.kind === "error") return setSaveError(result.message);
    markConflict(null);
    // The saved text is what the file holds now; edits made while the save ran stay unsaved.
    generation.current++;
    const unchanged = textOf.current() === text;
    const now = current.current.kind === "file" ? current.current : saved;
    show({ ...now, stat: { ...now.stat, version: result.version, size: new TextEncoder().encode(text).byteLength } });
    if (unchanged) markDirty(false);
  };
  const reload = async () => {
    markConflict(null);
    adopt(await load(path));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    if (canSave) void save();
  };

  const navigate = (to: string) => {
    if (to !== path && confirmDiscard([paneId])) onNavigate(to);
  };
  const folder = parentPath(loaded.kind === "file" || loaded.kind === "dir" ? loaded.stat.path : path);
  const markdown = loaded.kind === "file" && loaded.stat.view === "markdown" && editable;
  const toggleMode = () => {
    if (mode === "edit") {
      setPreview(textOf.current());
      setMode("preview");
    } else {
      setMode("edit");
      setEditorOpened(true);
    }
  };

  const editor = (wrap: boolean) =>
    loaded.kind === "file" && loaded.text !== null ? (
      <Editor
        key={docKey}
        initial={loaded.text}
        fileName={fileName(path)}
        readOnly={!editable}
        wrap={wrap}
        goTo={goTo}
        onWentTo={() => setGoTo(null)}
        onChange={(read) => {
          textOf.current = read;
          markDirty(true);
        }}
        onSave={() => {
          if (canSave) void save();
        }}
      />
    ) : null;

  let body: ReactNode;
  if (loaded.kind === "loading") body = <p className="p-5 text-xs text-muted-foreground">Loading…</p>;
  else if (loaded.kind === "error") body = <Notice title="Could not open this" detail={loaded.message} />;
  else if (loaded.kind === "missing")
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Notice title="Not found" detail={displayFilePath(path, home)} />
        {loaded.nearest && (
          <div className="px-2">
            <p className="px-3 pt-2 text-[11px] text-muted-foreground">Nearest folder: {displayFilePath(loaded.nearest.path, home)}</p>
            <DirectoryListing listing={loaded.nearest} onOpen={navigate} />
          </div>
        )}
      </div>
    );
  else if (loaded.kind === "dir")
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <DirectoryListing listing={loaded.listing} onOpen={navigate} />
      </div>
    );
  else {
    const { stat } = loaded;
    const raw = rawUrl(stat.path, { version: stat.version });
    const download = rawUrl(stat.path, { download: true });
    if (stat.view === "image") body = <ImageView src={raw} alt={fileName(stat.path)} />;
    else if (stat.view === "pdf") body = <iframe src={raw} title={fileName(stat.path)} className="min-h-0 w-full flex-1 bg-white" />;
    else if (stat.view === "binary" || loaded.text === null)
      body = (
        <Notice title="No preview for this file" detail={`${stat.mimeType}, ${formatBytes(stat.size)}`}>
          <Button asChild variant="secondary" size="sm" className="mt-3">
            <a href={download} download>
              <Download />
              Download
            </a>
          </Button>
        </Notice>
      );
    else
      body = (
        <>
          {loaded.truncated && (
            <p className="flex items-center gap-2 border-b border-white/5 px-5 py-1.5 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1">
                Too large to edit here ({formatBytes(stat.size)}): showing the first {formatBytes(MAX_EDITABLE_BYTES)}, read-only.
              </span>
              <a href={download} download className="shrink-0 underline underline-offset-2 hover:text-foreground">
                Download
              </a>
            </p>
          )}
          {markdown ? (
            <>
              {mode === "preview" && (
                <div data-file-preview className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8">
                  <div className="mx-auto max-w-3xl">
                    <PortalMarkdown text={preview ?? ""} cwd={folder} />
                  </div>
                </div>
              )}
              {editorOpened && <div className={mode === "edit" ? "min-h-0 flex-1" : "hidden"}>{editor(true)}</div>}
            </>
          ) : (
            <div className="min-h-0 flex-1">{editor(stat.view === "markdown" || !/\.[^/]+$/.test(stat.path) || /\.(txt|log)$/i.test(stat.path))}</div>
          )}
        </>
      );
  }

  return (
    <div ref={root} data-file-pane={path} onKeyDown={onKeyDown} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FileHeader
        path={path}
        shownPath={displayFilePath(path, home)}
        dirty={dirty}
        showSidebarToggle={showSidebarToggle}
        onOpenSidebar={onOpenSidebar}
        pane={pane}
        mode={markdown ? mode : null}
        onToggleMode={toggleMode}
        canSave={canSave}
        saving={saving}
        onSave={editable ? () => void save() : null}
        download={loaded.kind === "file" ? rawUrl(loaded.stat.path, { download: true }) : null}
        onReveal={folder !== null && loaded.kind !== "dir" ? () => navigate(folder) : null}
      />
      {saveError && (
        <p role="alert" className="border-b border-white/5 px-5 py-1.5 text-[11px] text-destructive">
          {saveError}
        </p>
      )}
      {body}
      <ResponsiveDialog
        open={conflict !== null}
        onOpenChange={(open) => !open && markConflict(null)}
        title="The file changed on disk"
        description={
          conflict?.version === null
            ? `${fileName(path)} was deleted since you opened it. Overwrite saves your version as a new file.`
            : `${fileName(path)} was changed since you opened it, probably by an agent. Reload drops your edits; Overwrite replaces the file with your version.`
        }
      >
        <div className="flex justify-end gap-2 pb-2">
          <Button variant="ghost" onClick={() => markConflict(null)}>
            Keep editing
          </Button>
          <Button variant="secondary" onClick={() => void reload()}>
            Reload
          </Button>
          <Button variant="destructive" disabled={saving} onClick={() => void save(conflict?.version ?? null)}>
            Overwrite
          </Button>
        </div>
      </ResponsiveDialog>
    </div>
  );
}

function Notice({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-6">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{detail}</p>
      {children}
    </div>
  );
}

/** An image fitted to the pane; a tap shows it at its actual size (scrolling), another fits it again. */
function ImageView({ src, alt }: { src: string; alt: string }) {
  const [actual, setActual] = useState(false);
  return (
    <div className={`min-h-0 flex-1 overflow-auto p-4 ${actual ? "" : "flex items-center justify-center"}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a host file, not an optimisable asset */}
      <img
        src={src}
        alt={alt}
        onClick={() => setActual((value) => !value)}
        className={actual ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
      />
    </div>
  );
}

function FileHeader({
  path,
  shownPath,
  dirty,
  showSidebarToggle,
  onOpenSidebar,
  pane,
  mode,
  onToggleMode,
  canSave,
  saving,
  onSave,
  download,
  onReveal,
}: {
  path: string;
  /** The path as shown, home as `~`. */
  shownPath: string;
  dirty: boolean;
  showSidebarToggle: boolean;
  onOpenSidebar: (opener: HTMLElement) => void;
  pane: PaneMenu;
  /** Markdown's Preview/Edit state; null for anything else. */
  mode: "preview" | "edit" | null;
  onToggleMode: () => void;
  canSave: boolean;
  saving: boolean;
  /** Null when the file cannot be edited here (not text, too large, a directory). */
  onSave: (() => void) | null;
  download: string | null;
  onReveal: (() => void) | null;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const paneItems = (
    <>
      <MenuItem disabled={!pane.canSplitRight} onSelect={pane.onSplitRight}>
        <SquareSplitHorizontal />
        Split right
      </MenuItem>
      <MenuItem disabled={!pane.canSplitDown} onSelect={pane.onSplitDown}>
        <SquareSplitVertical />
        Split down
      </MenuItem>
      {pane.onMoveToTab && (
        <MenuItem onSelect={pane.onMoveToTab}>
          <SquareArrowOutUpRight />
          Move to its own tab
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem onSelect={pane.onClose}>
        <X />
        Close pane
      </MenuItem>
    </>
  );
  return (
    <ContextActions items={paneItems}>
      <header className="workspace-header">
        {showSidebarToggle && (
          <IconButton label="Toggle sidebar" onClick={(event) => onOpenSidebar(event.currentTarget)} className="text-muted-foreground">
            <PanelLeft className="size-4" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-snug tracking-[-.01em]">
            <span className="truncate">{fileName(path)}</span>
            {dirty && (
              <span className="size-1.5 shrink-0 rounded-full bg-amber-300/90" role="img" aria-label="Unsaved changes" />
            )}
          </h1>
          <p title={path} className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
            {shownPath}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {mode && (
            <IconButton label={mode === "preview" ? "Edit" : "Preview"} aria-pressed={mode === "edit"} onClick={onToggleMode} className="text-muted-foreground">
              {mode === "preview" ? <PencilLine className="size-4" /> : <Eye className="size-4" />}
            </IconButton>
          )}
          {onSave && (
            <IconButton label={saving ? "Saving…" : "Save (⌘S)"} disabled={!canSave} onClick={onSave} className={canSave ? "text-foreground" : "text-muted-foreground"}>
              <Save className="size-4" />
            </IconButton>
          )}
          {download && (
            <IconButton label="Download" asChild className="text-muted-foreground">
              <a href={download} download>
                <Download className="size-4" />
              </a>
            </IconButton>
          )}
          <IconButton label={copied ? "Copied" : "Copy path"} onClick={() => void copyText(path).then(setCopied)} className="text-muted-foreground">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </IconButton>
          {onReveal && (
            <IconButton label="Reveal folder" onClick={onReveal} className="text-muted-foreground">
              <FolderOpen className="size-4" />
            </IconButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Pane options" className="text-muted-foreground">
                <LayoutPanelLeft className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{paneItems}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
    </ContextActions>
  );
}
