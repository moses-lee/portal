"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import ResponsiveDialog from "./ResponsiveDialog";
import { useSettings, type SettingsSection } from "./useSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  orchestratorProviders,
  type OrchestratorProvider,
} from "@/lib/orchestrator/types";
import {
  defaultSettings,
  gitActionKinds,
  orchestratorLimits,
  type GitActionKind,
  type SettingsPatch,
} from "@/lib/settings";

const promptLabels: Record<GitActionKind, string> = {
  checks: "Failing checks",
  conflicts: "Merge conflicts",
  review: "Review items",
};

const providerLabels: Record<OrchestratorProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/** Talk to Portal fields that are typed into and saved when the user leaves them. */
type OrchestratorTextField = "model" | "intervalMinutes" | "idleIntervalMinutes";
const orchestratorTextFields: readonly OrchestratorTextField[] = [
  "model",
  "intervalMinutes",
  "idleIntervalMinutes",
];
const orchestratorTextLabels: Record<OrchestratorTextField, string> = {
  model: "Model",
  intervalMinutes: "Check every … minutes while Portal is open",
  idleIntervalMinutes: "Check every … minutes while no browser is connected",
};

/** Every field with its own save state. */
type FieldKey =
  | GitActionKind
  | "provider"
  | OrchestratorTextField
  | `apiKey.${OrchestratorProvider}`;

type FieldStatus = { kind: "saved" } | { kind: "error"; message: string };

/**
 * Per-field save state shared by every section: one save at a time per field, "Saved" shown for
 * a moment on success, the server's message kept on failure.
 */
function useFieldFeedback() {
  const [saving, setSaving] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [status, setStatus] = useState<
    Partial<Record<FieldKey, FieldStatus>>
  >({});
  const inFlight = useRef(new Set<FieldKey>());
  const timers = useRef(new Map<FieldKey, ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const setStatusFor = (key: FieldKey, next: FieldStatus | null) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    setStatus((prev) => ({ ...prev, [key]: next ?? undefined }));
    if (next?.kind === "saved")
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setStatus((prev) =>
            prev[key]?.kind === "saved" ? { ...prev, [key]: undefined } : prev,
          );
        }, 1500),
      );
  };

  /** Runs `save` for `key` unless one is already running; resolves true when it succeeded. */
  const run = async (
    key: FieldKey,
    save: () => Promise<unknown>,
    fallback: string,
  ): Promise<boolean> => {
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setSaving((prev) => ({ ...prev, [key]: true }));
    setStatusFor(key, null);
    try {
      await save();
      setStatusFor(key, { kind: "saved" });
      return true;
    } catch (e) {
      setStatusFor(key, {
        kind: "error",
        message: e instanceof Error ? e.message : fallback,
      });
      return false;
    } finally {
      inFlight.current.delete(key);
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  /**
   * Forget every field's status; in-flight saves still report when they finish. Pending "Saved"
   * fade-outs need no clearing: they only remove a status that is still "saved", so they are no-ops after this.
   */
  const reset = useCallback(() => setStatus({}), []);

  const anyError = Object.values(status).some((s) => s?.kind === "error");
  return { saving, status, run, setStatusFor, reset, anyError };
}

export default function SettingsDialog({
  open,
  section = null,
  onClose,
}: {
  open: boolean;
  /** The section to scroll to and focus when opening; null opens at the top. */
  section?: SettingsSection | null;
  onClose: () => void;
}) {
  const { settings, error, update } = useSettings();
  const {
    saving,
    status,
    run,
    setStatusFor,
    reset: resetFeedback,
    anyError,
  } = useFieldFeedback();
  // Drafts exist only for fields the user has edited and not yet saved.
  const [drafts, setDrafts] = useState<Partial<Record<GitActionKind, string>>>(
    {},
  );
  const [orchestratorDrafts, setOrchestratorDrafts] = useState<
    Partial<Record<OrchestratorTextField, string>>
  >({});
  // API key drafts live here rather than in the field so closing the dialog can save them like
  // every other unsaved field. A draft (even "") also means the field is in its editing state:
  // Replace opens one, and Cancel, a successful save, or a reopen drops it.
  const [apiKeyDrafts, setApiKeyDrafts] = useState<
    Partial<Record<OrchestratorProvider, string>>
  >({});
  const gitActionsRef = useRef<HTMLElement>(null);
  const orchestratorRef = useRef<HTMLElement>(null);

  // The dialog stays mounted while closed, so a save that failed after closing (flushDrafts runs in
  // the background) would otherwise greet the next open with a stale error and the draft behind it.
  // Done while rendering rather than in an effect (the React pattern for resetting state when a
  // prop changes) so the first frame of the reopened dialog is already clean.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      resetFeedback();
      setDrafts({});
      setOrchestratorDrafts({});
      setApiKeyDrafts({});
    }
  }

  // Land on the requested section once the dialog and its fields are on screen. Keyed on whether
  // settings have loaded, not on their value, so a save while open does not yank focus back.
  const loaded = settings !== null;
  useEffect(() => {
    if (!open || !section || !loaded) return;
    const target =
      section === "orchestrator"
        ? orchestratorRef.current
        : gitActionsRef.current;
    if (!target) return;
    // Radix focuses the dialog on mount; wait a frame so this focus wins.
    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({ block: "start" });
      target
        .querySelector<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
        )
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, section, loaded]);

  const clearDraft = (kind: GitActionKind) =>
    setDrafts((prev) => {
      if (!(kind in prev)) return prev;
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  const clearOrchestratorDraft = (field: OrchestratorTextField) =>
    setOrchestratorDrafts((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  const clearApiKeyDraft = (provider: OrchestratorProvider) =>
    setApiKeyDrafts((prev) => {
      if (!(provider in prev)) return prev;
      const next = { ...prev };
      delete next[provider];
      return next;
    });

  // Persists `value` for `kind`; "" resets the prompt to its default.
  const savePrompt = async (kind: GitActionKind, value: string) => {
    if (!settings) return;
    const trimmed = value.trim();
    if (trimmed === settings.gitActions.prompts[kind].trim()) {
      clearDraft(kind);
      return;
    }
    const ok = await run(
      kind,
      () => update({ gitActions: { prompts: { [kind]: trimmed } } }),
      "Could not save the prompt.",
    );
    if (ok) clearDraft(kind);
  };

  /** Checks a typed Talk to Portal value client-side, then persists it. Unlike prompts, blank is an error, not a reset. */
  const saveOrchestratorField = async (
    field: OrchestratorTextField,
    value: string,
  ) => {
    if (!settings) return;
    const trimmed = value.trim();
    let patch: SettingsPatch["orchestrator"];
    if (field === "model") {
      if (!trimmed) {
        setStatusFor(field, { kind: "error", message: "Enter a model id." });
        return;
      }
      if (trimmed.length > orchestratorLimits.modelLength) {
        setStatusFor(field, {
          kind: "error",
          message: `The model id is too long (the limit is ${orchestratorLimits.modelLength} characters).`,
        });
        return;
      }
      if (trimmed === settings.orchestrator.model) {
        clearOrchestratorDraft(field);
        return;
      }
      patch = { model: trimmed };
    } else {
      const max = orchestratorLimits[field];
      const minutes = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
      if (!(minutes >= 1 && minutes <= max)) {
        setStatusFor(field, {
          kind: "error",
          message: `Enter a whole number of minutes between 1 and ${max}.`,
        });
        return;
      }
      if (minutes === settings.orchestrator[field]) {
        clearOrchestratorDraft(field);
        return;
      }
      patch = { [field]: minutes };
    }
    const ok = await run(
      field,
      () => update({ orchestrator: patch }),
      "Could not save the setting.",
    );
    if (ok) clearOrchestratorDraft(field);
  };

  const saveProvider = (provider: OrchestratorProvider) => {
    if (!settings || provider === settings.orchestrator.provider) return;
    void run(
      "provider",
      () => update({ orchestrator: { provider } }),
      "Could not save the provider.",
    );
  };

  /** Stores (or, with "", clears) the key for `provider`. Resolves true on success so the field can reset. */
  const saveApiKey = (provider: OrchestratorProvider, key: string) =>
    run(
      `apiKey.${provider}`,
      () => update({ orchestrator: { apiKeys: { [provider]: key } } }),
      key ? "Could not save the API key." : "Could not clear the API key.",
    );

  /** Saves the typed key and, when that works, leaves the editing state. A blank draft has nothing to save and just leaves it. */
  const submitApiKey = async (provider: OrchestratorProvider, draft: string) => {
    const trimmed = draft.trim();
    if (!trimmed) {
      clearApiKeyDraft(provider);
      return;
    }
    if (await saveApiKey(provider, trimmed)) clearApiKeyDraft(provider);
  };

  const flushDrafts = () => {
    for (const kind of gitActionKinds) {
      const draft = drafts[kind];
      if (draft !== undefined) void savePrompt(kind, draft);
    }
    for (const field of orchestratorTextFields) {
      const draft = orchestratorDrafts[field];
      if (draft !== undefined) void saveOrchestratorField(field, draft);
    }
    for (const provider of orchestratorProviders) {
      const draft = apiKeyDrafts[provider];
      if (draft !== undefined) void submitApiKey(provider, draft);
    }
  };

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
      <div className="space-y-6">
        {error && !anyError && (
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

        <section
          ref={gitActionsRef}
          aria-labelledby="settings-git-actions"
          className="scroll-mt-4 space-y-4"
        >
          <div className="space-y-1">
            <h3 id="settings-git-actions" className="text-sm font-medium">
              Git actions
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Prompts pasted into a new conversation from the source control
              panel. The PR, checks, or conflicts are appended automatically.
            </p>
          </div>
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
                  if (draft !== undefined) void savePrompt(kind, draft);
                }}
                onReset={() => {
                  clearDraft(kind);
                  void savePrompt(kind, "");
                }}
              />
            ))}
        </section>

        <section
          ref={orchestratorRef}
          aria-labelledby="settings-orchestrator"
          className="scroll-mt-4 space-y-4"
        >
          <div className="space-y-1">
            <h3 id="settings-orchestrator" className="text-sm font-medium">
              Talk to Portal
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The assistant that keeps an eye on your sessions and pull
              requests. Choose the model it runs on, how often it checks in,
              and the API key it uses. Keys never leave this machine.
            </p>
          </div>
          {settings && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <ProviderField
                  value={settings.orchestrator.provider}
                  saving={!!saving.provider}
                  status={status.provider ?? null}
                  onChange={saveProvider}
                />
                <OrchestratorTextInput
                  field="model"
                  value={
                    orchestratorDrafts.model ?? settings.orchestrator.model
                  }
                  dirty={orchestratorDrafts.model !== undefined}
                  saving={!!saving.model}
                  status={status.model ?? null}
                  onChange={(value) =>
                    setOrchestratorDrafts((prev) => ({ ...prev, model: value }))
                  }
                  onBlur={() => {
                    const draft = orchestratorDrafts.model;
                    if (draft !== undefined)
                      void saveOrchestratorField("model", draft);
                  }}
                />
              </div>
              {(["intervalMinutes", "idleIntervalMinutes"] as const).map(
                (field) => (
                  <OrchestratorTextInput
                    key={field}
                    field={field}
                    value={
                      orchestratorDrafts[field] ??
                      String(settings.orchestrator[field])
                    }
                    dirty={orchestratorDrafts[field] !== undefined}
                    saving={!!saving[field]}
                    status={status[field] ?? null}
                    onChange={(value) =>
                      setOrchestratorDrafts((prev) => ({
                        ...prev,
                        [field]: value,
                      }))
                    }
                    onBlur={() => {
                      const draft = orchestratorDrafts[field];
                      if (draft !== undefined)
                        void saveOrchestratorField(field, draft);
                    }}
                  />
                ),
              )}
              <div className="space-y-3">
                <p className="text-xs font-medium">API keys</p>
                {orchestratorProviders.map((provider) => (
                  <ApiKeyField
                    key={provider}
                    provider={provider}
                    stored={settings.orchestrator.apiKeys[provider]}
                    draft={apiKeyDrafts[provider]}
                    saving={!!saving[`apiKey.${provider}`]}
                    status={status[`apiKey.${provider}`] ?? null}
                    onChange={(value) =>
                      setApiKeyDrafts((prev) => ({ ...prev, [provider]: value }))
                    }
                    onSubmit={() => {
                      const draft = apiKeyDrafts[provider];
                      if (draft !== undefined) void submitApiKey(provider, draft);
                    }}
                    onCancel={() => clearApiKeyDraft(provider)}
                    onClear={() => void saveApiKey(provider, "")}
                  />
                ))}
              </div>
            </>
          )}
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

/** The line under a field: the error, "Saved", "Saving…", or the unsaved-draft hint. */
function FieldStatusText({
  id,
  status,
  saving,
  dirty,
  dirtyHint = "Unsaved · saves when you leave the field",
}: {
  id: string;
  status: FieldStatus | null;
  saving: boolean;
  dirty?: boolean;
  /** What "unsaved" means for this field, when it is not saved on blur. */
  dirtyHint?: string;
}) {
  if (status?.kind === "error")
    return (
      <p id={id} role="alert" className="text-[11px] text-destructive">
        {status.message}
      </p>
    );
  if (status?.kind === "saved")
    return (
      <p
        id={id}
        role="status"
        className="text-[11px] text-muted-foreground animate-in fade-in"
      >
        Saved
      </p>
    );
  if (saving)
    return (
      <p role="status" className="text-[11px] text-muted-foreground">
        Saving…
      </p>
    );
  if (dirty)
    return <p className="text-[11px] text-muted-foreground">{dirtyHint}</p>;
  return null;
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
      <FieldStatusText
        id={statusId}
        status={status}
        saving={saving}
        dirty={dirty}
      />
    </div>
  );
}

function ProviderField({
  value,
  saving,
  status,
  onChange,
}: {
  value: OrchestratorProvider;
  saving: boolean;
  status: FieldStatus | null;
  onChange: (provider: OrchestratorProvider) => void;
}) {
  const id = useId();
  const statusId = `${id}-status`;
  return (
    <div className="space-y-2">
      <div className="flex h-6 items-center">
        <label htmlFor={id} className="text-xs font-medium">
          Provider
        </label>
      </div>
      <Select
        value={value}
        disabled={saving}
        onValueChange={(next) => onChange(next as OrchestratorProvider)}
      >
        <SelectTrigger
          id={id}
          aria-describedby={status ? statusId : undefined}
          aria-invalid={status?.kind === "error" || undefined}
          className="w-full text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {orchestratorProviders.map((provider) => (
            <SelectItem key={provider} value={provider}>
              {providerLabels[provider]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldStatusText id={statusId} status={status} saving={saving} />
    </div>
  );
}

function OrchestratorTextInput({
  field,
  value,
  dirty,
  saving,
  status,
  onChange,
  onBlur,
}: {
  field: OrchestratorTextField;
  value: string;
  dirty: boolean;
  saving: boolean;
  status: FieldStatus | null;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  const statusId = `${id}-status`;
  const numeric = field !== "model";
  return (
    <div className="space-y-2">
      <div className="flex h-6 items-center">
        <label htmlFor={id} className="text-xs font-medium">
          {orchestratorTextLabels[field]}
        </label>
      </div>
      <Input
        id={id}
        type={numeric ? "number" : "text"}
        inputMode={numeric ? "numeric" : undefined}
        min={numeric ? 1 : undefined}
        max={numeric ? orchestratorLimits[field] : undefined}
        step={numeric ? 1 : undefined}
        maxLength={numeric ? undefined : orchestratorLimits.modelLength}
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={saving}
        aria-describedby={status ? statusId : undefined}
        aria-invalid={status?.kind === "error" || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={
          numeric
            ? String(defaultSettings.orchestrator[field])
            : defaultSettings.orchestrator.model
        }
        className="text-xs md:text-xs"
      />
      <FieldStatusText
        id={statusId}
        status={status}
        saving={saving}
        dirty={dirty}
      />
    </div>
  );
}

/**
 * One provider's API key. The key is write-only: once stored the field shows "Key saved" with
 * Replace and Clear, never the key itself, since the server only reports whether one exists.
 * The draft belongs to the dialog (see `apiKeyDrafts`): `draft === undefined` means "not editing".
 */
function ApiKeyField({
  provider,
  stored,
  draft,
  saving,
  status,
  onChange,
  onSubmit,
  onCancel,
  onClear,
}: {
  provider: OrchestratorProvider;
  stored: boolean;
  draft: string | undefined;
  saving: boolean;
  status: FieldStatus | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onClear: () => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const statusId = `${id}-status`;
  const editing = !stored || draft !== undefined;
  const value = draft ?? "";
  const trimmed = value.trim();

  return (
    <div className="space-y-2">
      <div className="flex h-6 items-center justify-between gap-2">
        <span id={labelId} className="text-xs font-medium">
          {providerLabels[provider]}
        </span>
        {stored && !editing && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={saving}
              onClick={() => onChange("")}
              className="text-muted-foreground"
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={saving}
              onClick={onClear}
              className="text-muted-foreground"
            >
              Clear
            </Button>
          </div>
        )}
        {stored && editing && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={saving}
            onClick={onCancel}
            className="text-muted-foreground"
          >
            Cancel
          </Button>
        )}
      </div>
      {editing ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && !saving) onSubmit();
          }}
        >
          <Input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={orchestratorLimits.apiKeyLength}
            value={value}
            disabled={saving}
            aria-labelledby={labelId}
            aria-describedby={status ? statusId : undefined}
            aria-invalid={status?.kind === "error" || undefined}
            onChange={(e) => onChange(e.target.value)}
            placeholder={stored ? "Paste the new key" : "Paste your API key"}
            className="text-xs md:text-xs"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={saving || !trimmed}
          >
            Save
          </Button>
        </form>
      ) : (
        <p
          aria-labelledby={labelId}
          className="flex h-8 items-center rounded-lg border border-dashed border-input px-2.5 text-xs text-muted-foreground"
        >
          Key saved
        </p>
      )}
      <FieldStatusText
        id={statusId}
        status={status}
        saving={saving}
        dirty={trimmed !== ""}
        dirtyHint="Unsaved · saves when you press Save or close settings"
      />
    </div>
  );
}
