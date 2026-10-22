"use client";

import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";

export type EditorProps = {
  /** The document when the editor mounts; the parent remounts it (a new `key`) to load another. */
  initial: string;
  /** The file's name: picks the language mode (`@codemirror/language-data`). */
  fileName: string;
  readOnly?: boolean;
  /** Wrap long lines (prose: markdown, plain text). */
  wrap?: boolean;
  /** A line to scroll to and put the cursor on; a new `nonce` asks again for the same line. */
  goTo?: { line: number; nonce: number } | null;
  /** `goTo` was shown: the parent clears it, so the next document (a reload) does not jump to it again. */
  onWentTo?: () => void;
  /** The document changed; `text` reads it (only when needed, it is up to 2 MB). */
  onChange: (text: () => string) => void;
  /** ⌘S / Ctrl+S inside the editor. */
  onSave: () => void;
};

/** The app is dark only (`color-scheme: dark`): One Dark's colours on the pane's own background, the app's mono font. */
const paneTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
    ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid #ffffff0d" },
    ".cm-content": { paddingBottom: "40vh" },
  },
  { dark: true },
);

/**
 * The file pane's CodeMirror 6 editor (docs/FILES.md, decision 10), loaded lazily by `FilePane`
 * through `next/dynamic`: the basic setup, One Dark, the language mode for the file's extension
 * (loaded on demand), and ⌘S. Uncontrolled: it owns the document after mount and reports changes;
 * the pane remounts it to load another version.
 */
export default function Editor({ initial, fileName, readOnly = false, wrap = false, goTo = null, onWentTo, onChange, onSave }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave, onWentTo });
  useEffect(() => {
    handlers.current = { onChange, onSave, onWentTo };
  });

  // One editor per mount; the props that shape it are read once (the parent remounts for a new document).
  useEffect(() => {
    const language = new Compartment();
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (handlers.current.onSave(), true) }])),
          basicSetup,
          oneDark,
          paneTheme,
          language.of([]),
          ...(wrap ? [EditorView.lineWrapping] : []),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(() => update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    let live = true;
    const description = LanguageDescription.matchFilename(languages, fileName);
    description
      ?.load()
      .then((support) => {
        if (live) editor.dispatch({ effects: language.reconfigure(support) });
      })
      .catch(() => {});
    return () => {
      live = false;
      view.current = null;
      editor.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !goTo) return;
    const doc = editor.state.doc;
    const line = doc.line(Math.min(Math.max(1, goTo.line), doc.lines));
    editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    handlers.current.onWentTo?.();
  }, [goTo]);

  return <div ref={host} data-file-editor className="h-full min-h-0 overflow-hidden" />;
}
