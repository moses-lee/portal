"use client";

import { useEffect, useId, useRef, useState } from "react";
import ResponsiveDialog from "./ResponsiveDialog";
import { useSettings } from "./useSettings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  defaultSettings,
  gitActionKinds,
  type GitActionKind,
} from "@/lib/settings";

const promptLabels: Record<GitActionKind, string> = {
  checks: "Failing checks",
  conflicts: "Merge conflicts",
  review: "Review items",
};

type FieldStatus = { kind: "saved" } | { kind: "error"; message: string };

export default function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { settings, error, update } = useSettings();
  // Drafts exist only for fields the user has edited and not yet saved.
  const [drafts, setDrafts] = useState<Partial<Record<GitActionKind, string>>>(
    {},
  );
  const [saving, setSaving] = useState<Partial<Record<GitActionKind, boolean>>>(
    {},
  );
  const [status, setStatus] = useState<
    Partial<Record<GitActionKind, FieldStatus>>
  >({});
  const inFlight = useRef(new Set<GitActionKind>());
  const timers = useRef(
    new Map<GitActionKind, ReturnType<typeof setTimeout>>(),
  );
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const setStatusFor = (kind: GitActionKind, next: FieldStatus | null) => {
    const timer = timers.current.get(kind);
    if (timer) clearTimeout(timer);
    setStatus((prev) => ({ ...prev, [kind]: next ?? undefined }));
    if (next?.kind === "saved")
      timers.current.set(
        kind,
        setTimeout(() => {
          timers.current.delete(kind);
          setStatus((prev) =>
            prev[kind]?.kind === "saved"
              ? { ...prev, [kind]: undefined }
              : prev,
          );
        }, 1500),
      );
  };
  const clearDraft = (kind: GitActionKind) =>
    setDrafts((prev) => {
      if (!(kind in prev)) return prev;
      const next = { ...prev };
      delete next[kind];
      return next;
    });

  // Persists `value` for `kind`; "" resets the prompt to its default.
  const save = async (kind: GitActionKind, value: string) => {
    if (!settings || inFlight.current.has(kind)) return;
    const trimmed = value.trim();
    if (trimmed === settings.gitActions.prompts[kind].trim()) {
      clearDraft(kind);
      return;
    }
    inFlight.current.add(kind);
    setSaving((prev) => ({ ...prev, [kind]: true }));
    setStatusFor(kind, null);
    try {
      await update({ gitActions: { prompts: { [kind]: trimmed } } });
      clearDraft(kind);
      setStatusFor(kind, { kind: "saved" });
    } catch (e) {
      setStatusFor(kind, {
        kind: "error",
        message: e instanceof Error ? e.message : "Could not save the prompt.",
      });
    } finally {
      inFlight.current.delete(kind);
      setSaving((prev) => ({ ...prev, [kind]: false }));
    }
  };
  const flushDrafts = () => {
    for (const kind of gitActionKinds) {
      const draft = drafts[kind];
      if (draft !== undefined) void save(kind, draft);
    }
  };

  const fieldError = gitActionKinds.some(
    (kind) => status[kind]?.kind === "error",
  );
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(value) => {
        if (value) return;
        flushDrafts();
        onClose();
      }}
      title="Settings"
      description="Portal preferences, saved on this machine."
    >
      <div className="space-y-5">
        <section aria-labelledby="settings-git-actions" className="space-y-4">
          <div className="space-y-1">
            <h3 id="settings-git-actions" className="text-sm font-medium">
              Git actions
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Prompts pasted into a new conversation from the source control
              panel. The PR, checks, or conflicts are appended automatically.
            </p>
          </div>
          {error && !fieldError && (
            <p
              role="alert"
              className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          {!settings && !error && (
            <p role="status" className="text-xs text-muted-foreground">
              Loading settings…
            </p>
          )}
          {settings &&
            gitActionKinds.map((kind) => (
              <PromptField
                key={kind}
                kind={kind}
                value={drafts[kind] ?? settings.gitActions.prompts[kind]}
                dirty={drafts[kind] !== undefined}
                saving={!!saving[kind]}
                status={status[kind] ?? null}
                onChange={(value) =>
                  setDrafts((prev) => ({ ...prev, [kind]: value }))
                }
                onBlur={() => {
                  const draft = drafts[kind];
                  if (draft !== undefined) void save(kind, draft);
                }}
                onReset={() => {
                  clearDraft(kind);
                  void save(kind, "");
                }}
              />
            ))}
        </section>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => {
            flushDrafts();
            onClose();
          }}
        >
          Done
        </Button>
      </div>
    </ResponsiveDialog>
  );
}

function PromptField({
  kind,
  value,
  dirty,
  saving,
  status,
  onChange,
  onBlur,
  onReset,
}: {
  kind: GitActionKind;
  value: string;
  dirty: boolean;
  saving: boolean;
  status: FieldStatus | null;
  onChange: (value: string) => void;
  onBlur: () => void;
  onReset: () => void;
}) {
  const id = useId();
  const statusId = `${id}-status`;
  const isDefault =
    value.trim() === defaultSettings.gitActions.prompts[kind].trim();
  return (
    <div className="space-y-2">
      <div className="flex h-6 items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium">
          {promptLabels[kind]}
        </label>
        {!isDefault && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={saving}
            onClick={onReset}
            className="text-muted-foreground"
          >
            Reset to default
          </Button>
        )}
      </div>
      <Textarea
        id={id}
        rows={3}
        value={value}
        disabled={saving}
        aria-describedby={status ? statusId : undefined}
        aria-invalid={status?.kind === "error" || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={defaultSettings.gitActions.prompts[kind]}
        className="min-h-20 resize-y text-xs leading-relaxed md:text-xs"
      />
      {status?.kind === "error" ? (
        <p id={statusId} role="alert" className="text-[11px] text-destructive">
          {status.message}
        </p>
      ) : status?.kind === "saved" ? (
        <p
          id={statusId}
          role="status"
          className="text-[11px] text-muted-foreground animate-in fade-in"
        >
          Saved
        </p>
      ) : saving ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          Saving…
        </p>
      ) : dirty ? (
        <p className="text-[11px] text-muted-foreground">
          Unsaved · saves when you leave the field
        </p>
      ) : null}
    </div>
  );
}
