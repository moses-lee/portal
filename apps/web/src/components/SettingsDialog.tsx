"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Bot, GitBranch, SquareTerminal, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  consolidationFields,
  consolidationInput,
  parseConsolidationInput,
  type ConsolidationField,
} from "@/lib/orchestrator/curation";
import {
  defaultModels,
  orchestratorProviders,
  type ModelRole,
  type OrchestratorProvider,
} from "@/lib/orchestrator/types";
import {
  isScriptEnabled,
  scriptDefinitions,
  scriptKinds,
  scriptLimits,
  type ScriptKind,
  type ScriptSettings,
} from "@/lib/scripts";
import {
  defaultSettings,
  gitActionKinds,
  isHungAfterMinutes,
  orchestratorLimits,
  type GitActionKind,
  type SettingsPatch,
} from "@/lib/settings";
import { useMediaQuery } from "./useMediaQuery";
import { usePreference } from "./usePreference";
import {
  isSettingsSection,
  settingsSections,
  useSettings,
  type SettingsSection,
} from "./useSettings";

/** Each section's nav entry and the heading of its pane. */
const sectionMeta: Record<
  SettingsSection,
  { label: string; description: string; icon: LucideIcon }
> = {
  gitActions: {
    label: "Git actions",
    description:
      "Prompts pasted into a new conversation from the source control panel. The PR, checks, or conflicts are appended automatically.",
    icon: GitBranch,
  },
  orchestrator: {
    label: "Talk to Portal",
    description:
      "The assistant that keeps an eye on your sessions and pull requests. Choose the models it runs on and the API keys it uses. Keys never leave this machine.",
    icon: Bot,
  },
  scripts: {
    label: "Scripts",
    description:
      "Shell commands Portal runs on this machine before certain actions. Leave a command empty to turn its script off.",
    icon: SquareTerminal,
  },
};

/** The section shown when nothing asked for one and none is remembered. */
const defaultSection: SettingsSection = "gitActions";
/** localStorage key for the last section viewed, so Settings reopens where it was left. */
const SECTION_PREFERENCE = "portal.settings.section";

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
type OrchestratorTextField =
  | "model"
  | "bookkeepingModel"
  | ConsolidationField
  | "hungAfterMinutes";
const orchestratorTextFields: readonly OrchestratorTextField[] = [
  "model",
  "bookkeepingModel",
  ...consolidationFields,
  "hungAfterMinutes",
];
const orchestratorTextLabels: Record<OrchestratorTextField, string> = {
  model: "Chat model",
  bookkeepingModel: "Bookkeeping model",
  nightlyAt: "Curate every night at",
  inboxThreshold: "Also curate when the inbox holds … proposals",
  minIntervalMinutes: "At most one inbox-started run every … minutes",
  hungAfterMinutes: "Call a session hung after … minutes with no CPU or output",
};

const isConsolidationField = (
  field: OrchestratorTextField,
): field is ConsolidationField =>
  (consolidationFields as readonly string[]).includes(field);

/** Script fields that are typed into and saved when the user leaves them; the toggle saves on its own. */
type ScriptTextField = "command" | "timeoutSeconds";
const scriptTextFields: readonly ScriptTextField[] = [
  "command",
  "timeoutSeconds",
];
type ScriptTextKey = `${ScriptKind}.${ScriptTextField}`;
const scriptTextKey = (
  kind: ScriptKind,
  field: ScriptTextField,
): ScriptTextKey => `${kind}.${field}`;

/** Every field with its own save state. */
type FieldKey =
  | GitActionKind
  | "provider"
  | "bookkeepingProvider"
  | OrchestratorTextField
  | "reviews.answerReadOnly"
  | `apiKey.${OrchestratorProvider}`
  | `script.${ScriptKind}.${keyof ScriptSettings}`;

type FieldStatus = { kind: "saved" } | { kind: "error"; message: string };

/**
 * Per-field save state shared by every section: one save at a time per field, "Saved" shown for
 * a moment on success, the server's message kept on failure.
 */
function useFieldFeedback() {
  const [saving, setSaving] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [status, setStatus] = useState<Partial<Record<FieldKey, FieldStatus>>>(
    {},
  );
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
  /** The section to show and focus when opening; null reopens the last one viewed. */
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
  const [scriptDrafts, setScriptDrafts] = useState<
    Partial<Record<ScriptTextKey, string>>
  >({});
  const paneRef = useRef<HTMLDivElement>(null);

  // The section on screen. The last one viewed is remembered in this browser; an explicit request
  // (the Talk to Portal page's "Add API key", say) wins over it for that opening.
  const [remembered, setRemembered] = usePreference(
    SECTION_PREFERENCE,
    defaultSection,
  );
  const rememberedSection = isSettingsSection(remembered)
    ? remembered
    : defaultSection;
  const [active, setActive] = useState<SettingsSection>(
    section ?? rememberedSection,
  );
  const showSection = (next: SettingsSection) => {
    setActive(next);
    setRemembered(next);
  };

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
      setScriptDrafts({});
      setActive(section ?? rememberedSection);
    }
  }

  // A section asked for by name counts as viewed, so the next plain open returns to it too. In an
  // effect rather than the reset above because remembering writes localStorage.
  useEffect(() => {
    if (open && section) setRemembered(section);
  }, [open, section, setRemembered]);

  // Land in the requested section's first field once the dialog and its fields are on screen. Keyed
  // on whether settings have loaded, not on their value, so a save while open does not yank focus back.
  const loaded = settings !== null;
  useEffect(() => {
    if (!open || !section || !loaded) return;
    const pane = paneRef.current;
    if (!pane) return;
    // Radix focuses the dialog on mount; wait a frame so this focus wins.
    const frame = requestAnimationFrame(() => {
      pane
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
  const clearScriptDraft = (key: ScriptTextKey) =>
    setScriptDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
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
    if (isConsolidationField(field)) {
      const parsed = parseConsolidationInput(field, trimmed);
      if ("error" in parsed) {
        setStatusFor(field, { kind: "error", message: parsed.error });
        return;
      }
      if (parsed.value === settings.orchestrator.consolidation[field]) {
        clearOrchestratorDraft(field);
        return;
      }
      patch = { consolidation: { [field]: parsed.value } };
    } else if (field === "hungAfterMinutes") {
      const minutes = Number(trimmed);
      if (!trimmed || !isHungAfterMinutes(minutes)) {
        setStatusFor(field, {
          kind: "error",
          message: `Enter a whole number of minutes from 1 to ${orchestratorLimits.hungAfterMinutes}.`,
        });
        return;
      }
      if (minutes === settings.orchestrator.stalls.hungAfterMinutes) {
        clearOrchestratorDraft(field);
        return;
      }
      patch = { stalls: { hungAfterMinutes: minutes } };
    } else {
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
      const current =
        field === "model"
          ? settings.orchestrator.model
          : settings.orchestrator.bookkeeping.model;
      if (trimmed === current) {
        clearOrchestratorDraft(field);
        return;
      }
      patch =
        field === "model" ? { model: trimmed } : { bookkeeping: { model: trimmed } };
    }
    const ok = await run(
      field,
      () => update({ orchestrator: patch }),
      "Could not save the setting.",
    );
    if (ok) clearOrchestratorDraft(field);
  };

  /** Whether Portal answers read-only permission requests of the review sessions it starts. */
  const saveAnswerReadOnly = async (answerReadOnly: boolean) => {
    if (!settings || answerReadOnly === settings.orchestrator.reviews.answerReadOnly) return;
    await run(
      "reviews.answerReadOnly",
      () => update({ orchestrator: { reviews: { answerReadOnly } } }),
      "Could not save the setting.",
    );
  };

  /**
   * Changes a role's provider. The server resets that role's model to the provider's default
   * unless a model comes with the change, so a model the user has typed (and not yet saved) is
   * sent along and kept; otherwise the default takes over.
   */
  const saveProvider = async (role: ModelRole, provider: OrchestratorProvider) => {
    if (!settings) return;
    const chat = role === "chat";
    const current = chat
      ? settings.orchestrator.provider
      : settings.orchestrator.bookkeeping.provider;
    if (provider === current) return;
    const modelField: OrchestratorTextField = chat ? "model" : "bookkeepingModel";
    const typed = orchestratorDrafts[modelField]?.trim();
    const model =
      typed && typed.length <= orchestratorLimits.modelLength ? typed : undefined;
    const patch: SettingsPatch["orchestrator"] = chat
      ? { provider, ...(model ? { model } : {}) }
      : { bookkeeping: { provider, ...(model ? { model } : {}) } };
    const ok = await run(
      chat ? "provider" : "bookkeepingProvider",
      () => update({ orchestrator: patch }),
      "Could not save the provider.",
    );
    // Only the draft that went out with the change: a model typed while it saved stays unsaved.
    if (ok)
      setOrchestratorDrafts((prev) => {
        if (!(modelField in prev) || prev[modelField]?.trim() !== typed) return prev;
        const next = { ...prev };
        delete next[modelField];
        return next;
      });
  };

  /** Stores (or, with "", clears) the key for `provider`. Resolves true on success so the field can reset. */
  const saveApiKey = (provider: OrchestratorProvider, key: string) =>
    run(
      `apiKey.${provider}`,
      () => update({ orchestrator: { apiKeys: { [provider]: key } } }),
      key ? "Could not save the API key." : "Could not clear the API key.",
    );

  /** Saves the typed key and, when that works, leaves the editing state. A blank draft has nothing to save and just leaves it. */
  const submitApiKey = async (
    provider: OrchestratorProvider,
    draft: string,
  ) => {
    const trimmed = draft.trim();
    if (!trimmed) {
      clearApiKeyDraft(provider);
      return;
    }
    if (await saveApiKey(provider, trimmed)) clearApiKeyDraft(provider);
  };

  /** Checks a typed script value client-side, then persists it. A blank command is a valid value: it turns the script off. */
  const saveScriptField = async (
    kind: ScriptKind,
    field: ScriptTextField,
    value: string,
  ) => {
    if (!settings) return;
    const key = scriptTextKey(kind, field);
    const feedbackKey: FieldKey = `script.${kind}.${field}`;
    const current = settings.scripts[kind];
    const trimmed = value.trim();
    let patch: SettingsPatch["scripts"];
    if (field === "command") {
      if (trimmed.length > scriptLimits.commandLength) {
        setStatusFor(feedbackKey, {
          kind: "error",
          message: `The command is too long (the limit is ${scriptLimits.commandLength} characters).`,
        });
        return;
      }
      if (trimmed === current.command) {
        clearScriptDraft(key);
        return;
      }
      patch = { [kind]: { command: trimmed } };
    } else {
      const max = scriptLimits.timeoutSeconds;
      const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
      if (!(seconds >= 1 && seconds <= max)) {
        setStatusFor(feedbackKey, {
          kind: "error",
          message: `Enter a whole number of seconds between 1 and ${max}.`,
        });
        return;
      }
      if (seconds === current.timeoutSeconds) {
        clearScriptDraft(key);
        return;
      }
      patch = { [kind]: { timeoutSeconds: seconds } };
    }
    const ok = await run(
      feedbackKey,
      () => update({ scripts: patch }),
      "Could not save the script.",
    );
    if (ok) clearScriptDraft(key);
  };

  const saveScriptToggle = (kind: ScriptKind, abortOnFailure: boolean) => {
    if (!settings || abortOnFailure === settings.scripts[kind].abortOnFailure)
      return;
    void run(
      `script.${kind}.abortOnFailure`,
      () => update({ scripts: { [kind]: { abortOnFailure } } }),
      "Could not save the setting.",
    );
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
    for (const kind of scriptKinds) {
      for (const field of scriptTextFields) {
        const draft = scriptDrafts[scriptTextKey(kind, field)];
        if (draft !== undefined) void saveScriptField(kind, field, draft);
      }
    }
  };

  const close = () => {
    flushDrafts();
    onClose();
  };

  const notices = (
    <>
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
    </>
  );

  const pane = (
    <div ref={paneRef} className="space-y-6">
      {notices}
      {active === "gitActions" && (
        <section aria-labelledby="settings-git-actions" className="space-y-4">
          <SectionHeading id="settings-git-actions" section="gitActions" />
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
      )}

      {active === "orchestrator" && (
        <section aria-labelledby="settings-orchestrator" className="space-y-4">
          <SectionHeading id="settings-orchestrator" section="orchestrator" />
          {settings && (
            <>
              {(["chat", "bookkeeping"] as const).map((role) => {
                const chat = role === "chat";
                const modelField: OrchestratorTextField = chat
                  ? "model"
                  : "bookkeepingModel";
                const providerKey = chat ? "provider" : "bookkeepingProvider";
                const choice = chat
                  ? {
                      provider: settings.orchestrator.provider,
                      model: settings.orchestrator.model,
                    }
                  : settings.orchestrator.bookkeeping;
                return (
                  <div key={role} className="space-y-3 rounded-xl border border-border/60 p-4">
                    <div className="space-y-1">
                      <p className="text-xs font-medium">
                        {chat ? "Chat and curation" : "Bookkeeping"}
                      </p>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {chat
                          ? "Talks with you, runs helper turns, and curates memory. A frontier model works best."
                          : "Turns what changed between checks into items. A fast, inexpensive model is enough."}
                      </p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ProviderField
                        label={chat ? "Chat provider" : "Bookkeeping provider"}
                        value={choice.provider}
                        saving={!!saving[providerKey]}
                        status={status[providerKey] ?? null}
                        onChange={(provider) => void saveProvider(role, provider)}
                      />
                      <OrchestratorTextInput
                        field={modelField}
                        value={orchestratorDrafts[modelField] ?? choice.model}
                        placeholder={defaultModels[choice.provider][role]}
                        dirty={orchestratorDrafts[modelField] !== undefined}
                        saving={!!saving[modelField]}
                        status={status[modelField] ?? null}
                        onChange={(value) =>
                          setOrchestratorDrafts((prev) => ({
                            ...prev,
                            [modelField]: value,
                          }))
                        }
                        onBlur={() => {
                          const draft = orchestratorDrafts[modelField];
                          if (draft !== undefined)
                            void saveOrchestratorField(modelField, draft);
                        }}
                      />
                    </div>
                  </div>
                );
              })}
              <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium">Memory curation</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Promotes recurring observations, drops duplicates, expires stale claims, and
                    rewrites entity summaries. Leave a trigger empty to turn it off; Run now in
                    Memory always works. The time is the server&apos;s local time.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  {consolidationFields.map((field) => (
                    <OrchestratorTextInput
                      key={field}
                      field={field}
                      value={
                        orchestratorDrafts[field] ??
                        consolidationInput(settings.orchestrator.consolidation, field)
                      }
                      placeholder={field === "minIntervalMinutes" ? undefined : "Off"}
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
                  ))}
                </div>
              </div>
              <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium">Review sessions</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Reviews run unattended. With this on, Portal answers their permission requests
                    for read-only steps (reading files, searching, commands its read-only checker
                    vouches for) with &ldquo;allow once&rdquo;, and marks each answer as its own in the
                    transcript. Anything that writes still waits for you.
                  </p>
                </div>
                <div className="flex h-8 items-center gap-2.5">
                  <Switch
                    id="reviews-answer-read-only"
                    checked={settings.orchestrator.reviews.answerReadOnly}
                    disabled={!!saving["reviews.answerReadOnly"]}
                    aria-describedby="reviews-answer-read-only-status"
                    onCheckedChange={(checked) => void saveAnswerReadOnly(checked)}
                  />
                  <label htmlFor="reviews-answer-read-only" className="text-xs">
                    Answer read-only permission requests in review sessions
                  </label>
                  <span id="reviews-answer-read-only-status" className="text-[11px] text-muted-foreground" aria-live="polite">
                    {status["reviews.answerReadOnly"]?.kind === "error"
                      ? status["reviews.answerReadOnly"]?.message
                      : status["reviews.answerReadOnly"]?.kind === "saved"
                        ? "Saved"
                        : ""}
                  </span>
                </div>
              </div>
              <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium">Stalled sessions</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    A session is hung when its turn is open but neither its processes used CPU nor
                    the agent produced output for this long. A long build or test run that keeps
                    working is busy, not hung. Portal tells you about hung sessions and ones whose
                    agent died.
                  </p>
                </div>
                <OrchestratorTextInput
                  field="hungAfterMinutes"
                  value={
                    orchestratorDrafts.hungAfterMinutes ??
                    String(settings.orchestrator.stalls.hungAfterMinutes)
                  }
                  dirty={orchestratorDrafts.hungAfterMinutes !== undefined}
                  saving={!!saving.hungAfterMinutes}
                  status={status.hungAfterMinutes ?? null}
                  onChange={(value) =>
                    setOrchestratorDrafts((prev) => ({
                      ...prev,
                      hungAfterMinutes: value,
                    }))
                  }
                  onBlur={() => {
                    const draft = orchestratorDrafts.hungAfterMinutes;
                    if (draft !== undefined)
                      void saveOrchestratorField("hungAfterMinutes", draft);
                  }}
                />
              </div>
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
                      setApiKeyDrafts((prev) => ({
                        ...prev,
                        [provider]: value,
                      }))
                    }
                    onSubmit={() => {
                      const draft = apiKeyDrafts[provider];
                      if (draft !== undefined)
                        void submitApiKey(provider, draft);
                    }}
                    onCancel={() => clearApiKeyDraft(provider)}
                    onClear={() => void saveApiKey(provider, "")}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {active === "scripts" && (
        <section aria-labelledby="settings-scripts" className="space-y-6">
          <SectionHeading id="settings-scripts" section="scripts" />
          {settings &&
            scriptKinds.map((kind) => (
              <ScriptField
                key={kind}
                kind={kind}
                settings={settings.scripts[kind]}
                commandDraft={scriptDrafts[scriptTextKey(kind, "command")]}
                timeoutDraft={
                  scriptDrafts[scriptTextKey(kind, "timeoutSeconds")]
                }
                saving={{
                  command: !!saving[`script.${kind}.command`],
                  abortOnFailure: !!saving[`script.${kind}.abortOnFailure`],
                  timeoutSeconds: !!saving[`script.${kind}.timeoutSeconds`],
                }}
                status={{
                  command: status[`script.${kind}.command`] ?? null,
                  abortOnFailure:
                    status[`script.${kind}.abortOnFailure`] ?? null,
                  timeoutSeconds:
                    status[`script.${kind}.timeoutSeconds`] ?? null,
                }}
                onChange={(field, value) =>
                  setScriptDrafts((prev) => ({
                    ...prev,
                    [scriptTextKey(kind, field)]: value,
                  }))
                }
                onBlur={(field) => {
                  const draft = scriptDrafts[scriptTextKey(kind, field)];
                  if (draft !== undefined)
                    void saveScriptField(kind, field, draft);
                }}
                onToggle={(value) => saveScriptToggle(kind, value)}
              />
            ))}
        </section>
      )}

      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={close}
      >
        Done
      </Button>
    </div>
  );

  const onOpenChange = (value: boolean) => {
    if (!value) close();
  };

  const desktop = useMediaQuery("(min-width: 640px)", true);
  if (!desktop)
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[90dvh] rounded-t-3xl pb-[max(24px,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="px-6 pt-6">
            <SheetTitle>Settings</SheetTitle>
            <SheetDescription>
              Portal preferences, saved on this machine.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-5 overflow-y-auto px-6">
            <SectionSelect value={active} onChange={showSection} />
            {pane}
          </div>
        </SheetContent>
      </Sheet>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85dvh,640px)] flex-row gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogDescription className="sr-only">
          Portal preferences, saved on this machine.
        </DialogDescription>
        <SidebarProvider
          className="h-full w-full flex-row items-stretch"
          style={{ "--sidebar-width": "12rem", minHeight: 0 } as CSSProperties}
        >
          <Sidebar collapsible="none" className="border-r">
            <SidebarHeader className="px-4 pt-6 pb-2">
              <DialogTitle>Settings</DialogTitle>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <nav aria-label="Settings sections">
                    <SidebarMenu>
                      {settingsSections.map((entry) => {
                        const Icon = sectionMeta[entry].icon;
                        return (
                          <SidebarMenuItem key={entry}>
                            <SidebarMenuButton
                              isActive={entry === active}
                              onClick={() => showSection(entry)}
                              aria-current={
                                entry === active ? "page" : undefined
                              }
                            >
                              <Icon />
                              <span>{sectionMeta[entry].label}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </nav>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <div className="min-w-0 flex-1 overflow-y-auto p-7 pt-6">{pane}</div>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}

/** A section pane's heading: the same label as its nav entry, then what the section is for. */
function SectionHeading({
  id,
  section,
}: {
  id: string;
  section: SettingsSection;
}) {
  return (
    <div className="space-y-1">
      <h3 id={id} className="text-sm font-medium">
        {sectionMeta[section].label}
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {sectionMeta[section].description}
      </p>
    </div>
  );
}

/** The mobile stand-in for the section sidebar. */
function SectionSelect({
  value,
  onChange,
}: {
  value: SettingsSection;
  onChange: (section: SettingsSection) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium">
        Section
      </label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (isSettingsSection(next)) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {settingsSections.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {sectionMeta[entry].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * One script: its command (blank means off), whether a failure stops the action, and how long it
 * may run. The command and timeout save when the field is left; the toggle saves as it is flipped.
 */
function ScriptField({
  kind,
  settings,
  commandDraft,
  timeoutDraft,
  saving,
  status,
  onChange,
  onBlur,
  onToggle,
}: {
  kind: ScriptKind;
  settings: ScriptSettings;
  commandDraft: string | undefined;
  timeoutDraft: string | undefined;
  saving: Record<keyof ScriptSettings, boolean>;
  status: Record<keyof ScriptSettings, FieldStatus | null>;
  onChange: (field: ScriptTextField, value: string) => void;
  onBlur: (field: ScriptTextField) => void;
  onToggle: (abortOnFailure: boolean) => void;
}) {
  const id = useId();
  const commandId = `${id}-command`;
  const commandStatusId = `${id}-command-status`;
  const toggleId = `${id}-abort`;
  const toggleStatusId = `${id}-abort-status`;
  const timeoutId = `${id}-timeout`;
  const timeoutStatusId = `${id}-timeout-status`;
  const stateId = `${id}-state`;
  const toggleMeaningId = `${id}-abort-meaning`;
  const definition = scriptDefinitions[kind];
  const command = commandDraft ?? settings.command;
  const enabled = isScriptEnabled(settings);
  return (
    <div className="space-y-4 rounded-xl border border-border/60 p-4">
      <div className="space-y-1">
        <div className="flex h-6 items-center justify-between gap-2">
          <label htmlFor={commandId} className="text-xs font-medium">
            {definition.label}
          </label>
          <span
            id={stateId}
            className={
              enabled
                ? "rounded-full bg-emerald-500/15 px-2 text-[10px] font-medium leading-5 text-emerald-300"
                : "rounded-full bg-white/8 px-2 text-[10px] font-medium leading-5 text-muted-foreground"
            }
          >
            <span className="sr-only">Script is </span>
            {enabled ? "On" : "Off"}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {definition.description}
        </p>
      </div>
      <div className="space-y-2">
        <Textarea
          id={commandId}
          rows={2}
          value={command}
          disabled={saving.command}
          aria-describedby={
            status.command ? `${stateId} ${commandStatusId}` : stateId
          }
          aria-invalid={status.command?.kind === "error" || undefined}
          onChange={(e) => onChange("command", e.target.value)}
          onBlur={() => onBlur("command")}
          placeholder={definition.placeholder}
          autoComplete="off"
          spellCheck={false}
          className="min-h-14 resize-y font-mono text-xs leading-relaxed md:text-xs"
        />
        <FieldStatusText
          id={commandStatusId}
          status={status.command}
          saving={saving.command}
          dirty={commandDraft !== undefined}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="flex h-6 items-center">
            <label htmlFor={toggleId} className="text-xs font-medium">
              If the script fails
            </label>
          </div>
          <div className="flex h-8 items-center gap-2.5">
            <Switch
              id={toggleId}
              checked={settings.abortOnFailure}
              disabled={saving.abortOnFailure}
              aria-describedby={
                status.abortOnFailure
                  ? `${toggleMeaningId} ${toggleStatusId}`
                  : toggleMeaningId
              }
              onCheckedChange={onToggle}
            />
            <span
              id={toggleMeaningId}
              className="text-xs text-muted-foreground"
            >
              {settings.abortOnFailure
                ? definition.onFailure.abort
                : definition.onFailure.carryOn}
            </span>
          </div>
          <FieldStatusText
            id={toggleStatusId}
            status={status.abortOnFailure}
            saving={saving.abortOnFailure}
          />
        </div>
        <div className="space-y-2">
          <div className="flex h-6 items-center">
            <label htmlFor={timeoutId} className="text-xs font-medium">
              Timeout (seconds)
            </label>
          </div>
          <Input
            id={timeoutId}
            type="number"
            inputMode="numeric"
            min={1}
            max={scriptLimits.timeoutSeconds}
            step={1}
            autoComplete="off"
            value={timeoutDraft ?? String(settings.timeoutSeconds)}
            disabled={saving.timeoutSeconds}
            aria-describedby={
              status.timeoutSeconds ? timeoutStatusId : undefined
            }
            aria-invalid={status.timeoutSeconds?.kind === "error" || undefined}
            onChange={(e) => onChange("timeoutSeconds", e.target.value)}
            onBlur={() => onBlur("timeoutSeconds")}
            className="text-xs md:text-xs"
          />
          <FieldStatusText
            id={timeoutStatusId}
            status={status.timeoutSeconds}
            saving={saving.timeoutSeconds}
            dirty={timeoutDraft !== undefined}
          />
        </div>
      </div>
    </div>
  );
}

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
  label,
  value,
  saving,
  status,
  onChange,
}: {
  label: string;
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
          {label}
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
  placeholder,
  dirty,
  saving,
  status,
  onChange,
  onBlur,
}: {
  field: OrchestratorTextField;
  value: string;
  /** Shown while the field is empty; numeric fields default to their stored default. */
  placeholder?: string;
  dirty: boolean;
  saving: boolean;
  status: FieldStatus | null;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  const statusId = `${id}-status`;
  const numeric =
    field === "inboxThreshold" ||
    field === "minIntervalMinutes" ||
    field === "hungAfterMinutes";
  const time = field === "nightlyAt";
  return (
    <div className="space-y-2">
      <div className="flex h-6 items-center">
        <label htmlFor={id} className="text-xs font-medium">
          {orchestratorTextLabels[field]}
        </label>
      </div>
      <Input
        id={id}
        type={numeric ? "number" : time ? "time" : "text"}
        inputMode={numeric ? "numeric" : undefined}
        min={numeric ? 1 : undefined}
        max={
          numeric
            ? orchestratorLimits[
                field as "inboxThreshold" | "minIntervalMinutes" | "hungAfterMinutes"
              ]
            : undefined
        }
        step={numeric ? 1 : undefined}
        maxLength={numeric || time ? undefined : orchestratorLimits.modelLength}
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={saving}
        aria-describedby={status ? statusId : undefined}
        aria-invalid={status?.kind === "error" || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={
          placeholder ??
          (field === "minIntervalMinutes"
            ? String(defaultSettings.orchestrator.consolidation[field])
            : undefined)
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
