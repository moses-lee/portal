"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ArrowLeftRight, Bot, Castle, Database, Gauge, GitBranch, SquareTerminal, Timer, type LucideIcon } from "lucide-react";
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
  modelRoles,
  orchestratorProviders,
  type ModelRole,
  type OrchestratorProvider,
  type OrchestratorSettings,
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
  exportSettings,
  gitActionKinds,
  idleStopLimits,
  isDiskLevelGb,
  isHungAfterMinutes,
  isIdleStopMinutes,
  isLifecycleHours,
  isWatchedFolder,
  monitoringLimits,
  orchestratorLimits,
  sessionsLimits,
  type GitActionKind,
  type Settings,
  type SettingsPatch,
} from "@/lib/settings";
import type { RemovedProjectSummary } from "@/lib/types";
import { missingWatchedFolders } from "@/lib/monitoring";
import type { FolderCheckResult } from "@portal/contracts/monitoring";
import { copyText } from "@/lib/clipboard";
import { isAbort, portalJson, portalSend } from "@/lib/orchestrator/api";
import type { RoomEnvironment, RoomState, RoomWeather } from "@portal/contracts/room";
import { LAYOUT_VERSION } from "@portal/shared/room";
import { publishRoomState, useRoomFailed, useRoomState } from "@/room/useRoomState";
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
  sessions: {
    label: "Sessions",
    description:
      "How long finished work stays around, and when idle agents are let go. Portal checks every few minutes, whether or not a browser is open.",
    icon: Timer,
  },
  monitoring: {
    label: "Monitoring",
    description:
      "When free disk space counts as low, and which folders outside Portal to measure. The levels colour the Monitoring view only; Portal never acts on them.",
    icon: Gauge,
  },
  scripts: {
    label: "Scripts",
    description:
      "Shell commands Portal runs on this machine before certain actions. Leave a command empty to turn its script off.",
    icon: SquareTerminal,
  },
  data: {
    label: "Data",
    description: "Conversations Portal keeps after their project is gone.",
    icon: Database,
  },
  room: {
    label: "Room",
    description:
      "The room behind Portal: where it is, the weather through its window, and how its furniture is laid out. Portal looks the location up from the server's own address unless PORTAL_LOCATION sets it.",
    icon: Castle,
  },
  importExport: {
    label: "Import & Export",
    description:
      "Every setting as JSON, to copy elsewhere or paste back. API keys are never included; add them in Talk to Portal.",
    icon: ArrowLeftRight,
  },
};

/** The sessions section's worktree retention clock, in hours. */
type SessionsField = "removeAfterHours";
const sessionsFields: readonly SessionsField[] = ["removeAfterHours"];
const sessionsFieldMeta: Record<SessionsField, { label: string; description: string; default: number }> = {
  removeAfterHours: {
    label: "Remove an idle worktree after … hours",
    description:
      "A worktree Portal created is removed this long after all its sessions went idle, unless it is pinned or has uncommitted changes. Its branch stays unless merged, and its conversations move to Removed.",
    default: defaultSettings.sessions.worktrees.removeAfterHours,
  },
};

function sessionsValue(settings: Settings, field: SessionsField): number {
  return settings.sessions.worktrees[field];
}

/** The monitoring section's typed fields: the two disk levels in GB and the watched folders, one per line. */
type MonitoringField = "warnFreeGb" | "criticalFreeGb" | "watchedFolders";
const monitoringFields: readonly MonitoringField[] = ["warnFreeGb", "criticalFreeGb", "watchedFolders"];
type DiskLevelField = Exclude<MonitoringField, "watchedFolders">;
const diskLevelFields: readonly DiskLevelField[] = ["warnFreeGb", "criticalFreeGb"];
const monitoringFieldMeta: Record<DiskLevelField, { label: string; default: number }> = {
  warnFreeGb: { label: "Warning below … GB free", default: defaultSettings.monitoring.disk.warnFreeGb },
  criticalFreeGb: { label: "Critical below … GB free", default: defaultSettings.monitoring.disk.criticalFreeGb },
};

function monitoringValue(settings: Settings, field: MonitoringField): string {
  return field === "watchedFolders" ? settings.monitoring.watchedFolders.join("\n") : String(settings.monitoring.disk[field]);
}

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

/** What the Settings dialog shows and saves for each model role. */
const roleFields: Record<
  ModelRole,
  {
    modelField: OrchestratorTextField;
    providerKey: "provider" | "bookkeepingProvider" | "watchProvider";
    title: string;
    about: string;
    providerLabel: string;
  }
> = {
  chat: {
    modelField: "model",
    providerKey: "provider",
    title: "Chat and curation",
    about: "Talks with you, runs helper turns, and curates memory. A frontier model works best.",
    providerLabel: "Chat provider",
  },
  bookkeeping: {
    modelField: "bookkeepingModel",
    providerKey: "bookkeepingProvider",
    title: "Bookkeeping",
    about: "Runs cheap background helpers. A fast, inexpensive model is enough.",
    providerLabel: "Bookkeeping provider",
  },
  watch: {
    modelField: "watchModel",
    providerKey: "watchProvider",
    title: "Watches",
    about: "Runs a watch when something it watches happens, with every tool the chat has.",
    providerLabel: "Watch provider",
  },
};

/** The provider and model a role uses: chat is the top-level pair, the others their own. */
const roleChoiceOf = (orchestrator: OrchestratorSettings, role: ModelRole) =>
  role === "chat"
    ? { provider: orchestrator.provider, model: orchestrator.model }
    : orchestrator[role];

/** Talk to Portal fields that are typed into and saved when the user leaves them. */
type OrchestratorTextField =
  | "model"
  | "bookkeepingModel"
  | "watchModel"
  | ConsolidationField
  | "hungAfterMinutes";
const orchestratorTextFields: readonly OrchestratorTextField[] = [
  "model",
  "bookkeepingModel",
  "watchModel",
  ...consolidationFields,
  "hungAfterMinutes",
];
const orchestratorTextLabels: Record<OrchestratorTextField, string> = {
  model: "Chat model",
  bookkeepingModel: "Bookkeeping model",
  watchModel: "Watch model",
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
  | "watchProvider"
  | OrchestratorTextField
  | "reviews.answerReadOnly"
  | SessionsField
  | "idleStop.enabled"
  | "idleStop.afterMinutes"
  | `monitoring.${MonitoringField}`
  | "monitoring.disk"
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
  onRemovedDeleted,
}: {
  open: boolean;
  /** The section to show and focus when opening; null reopens the last one viewed. */
  section?: SettingsSection | null;
  onClose: () => void;
  /** Removed sessions were deleted for good (the Data section): the sidebar's Removed list is stale. */
  onRemovedDeleted?: () => void;
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
  const [sessionsDrafts, setSessionsDrafts] = useState<
    Partial<Record<SessionsField, string>>
  >({});
  const [idleStopDraft, setIdleStopDraft] = useState<string | undefined>(undefined);
  const [monitoringDrafts, setMonitoringDrafts] = useState<
    Partial<Record<MonitoringField, string>>
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
      setSessionsDrafts({});
      setIdleStopDraft(undefined);
      setMonitoringDrafts({});
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
          : field === "watchModel"
            ? settings.orchestrator.watch.model
            : settings.orchestrator.bookkeeping.model;
      if (trimmed === current) {
        clearOrchestratorDraft(field);
        return;
      }
      patch =
        field === "model"
          ? { model: trimmed }
          : field === "watchModel"
            ? { watch: { model: trimmed } }
            : { bookkeeping: { model: trimmed } };
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
    const current = roleChoiceOf(settings.orchestrator, role).provider;
    if (provider === current) return;
    const { modelField, providerKey } = roleFields[role];
    const typed = orchestratorDrafts[modelField]?.trim();
    const model =
      typed && typed.length <= orchestratorLimits.modelLength ? typed : undefined;
    const patch: SettingsPatch["orchestrator"] =
      role === "chat"
        ? { provider, ...(model ? { model } : {}) }
        : { [role]: { provider, ...(model ? { model } : {}) } };
    const ok = await run(
      providerKey,
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

  const clearSessionsDraft = (field: SessionsField) =>
    setSessionsDrafts((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  /** Checks a typed lifecycle clock client-side, then persists it. Blank puts the default back. */
  const saveSessionsField = async (field: SessionsField, value: string) => {
    if (!settings) return;
    const trimmed = value.trim();
    const hours = trimmed ? Number(trimmed) : sessionsFieldMeta[field].default;
    if (!/^\d*$/.test(trimmed) || !isLifecycleHours(hours)) {
      setStatusFor(field, {
        kind: "error",
        message: `Enter a whole number of hours from ${sessionsLimits.minHours} to ${sessionsLimits.maxHours}.`,
      });
      return;
    }
    if (hours === sessionsValue(settings, field)) {
      clearSessionsDraft(field);
      return;
    }
    const patch: SettingsPatch["sessions"] = { worktrees: { removeAfterHours: hours } };
    const ok = await run(
      field,
      () => update({ sessions: patch }),
      "Could not save the setting.",
    );
    if (ok) clearSessionsDraft(field);
  };

  /** Turns the idle CLI stop on or off; saves as it is flipped. */
  const saveIdleStopEnabled = async (enabled: boolean) => {
    if (!settings || enabled === settings.sessions.idleStop.enabled) return;
    await run(
      "idleStop.enabled",
      () => update({ sessions: { idleStop: { enabled } } }),
      "Could not save the setting.",
    );
  };

  /** Checks the typed idle time client-side, then persists it. Blank puts the default back. */
  const saveIdleStopMinutes = async (value: string) => {
    if (!settings) return;
    const trimmed = value.trim();
    const minutes = trimmed ? Number(trimmed) : defaultSettings.sessions.idleStop.afterMinutes;
    if (!/^\d*$/.test(trimmed) || !isIdleStopMinutes(minutes)) {
      setStatusFor("idleStop.afterMinutes", {
        kind: "error",
        message: `Enter a whole number of minutes from ${idleStopLimits.minMinutes} to ${idleStopLimits.maxMinutes}.`,
      });
      return;
    }
    if (minutes === settings.sessions.idleStop.afterMinutes) {
      setIdleStopDraft(undefined);
      return;
    }
    const ok = await run(
      "idleStop.afterMinutes",
      () => update({ sessions: { idleStop: { afterMinutes: minutes } } }),
      "Could not save the setting.",
    );
    if (ok) setIdleStopDraft(undefined);
  };

  const clearMonitoringDraft = (field: MonitoringField) =>
    setMonitoringDrafts((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  /**
   * Checks the typed watched folders client-side, then persists them. One per line, blank lines
   * dropped; a malformed one refuses the whole list rather than vanish.
   */
  const saveWatchedFolders = async (value: string) => {
    if (!settings) return;
    const key: FieldKey = "monitoring.watchedFolders";
    const folders = [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
    const bad = folders.filter((folder) => !isWatchedFolder(folder));
    if (bad.length > 0) {
      setStatusFor(key, {
        kind: "error",
        message: `Use absolute paths or paths under ~ (not ${bad.map((folder) => `"${folder}"`).join(", ")}).`,
      });
      return;
    }
    if (folders.length > monitoringLimits.watchedFolders) {
      setStatusFor(key, { kind: "error", message: `Watch at most ${monitoringLimits.watchedFolders} folders.` });
      return;
    }
    if (folders.join("\n") === settings.monitoring.watchedFolders.join("\n")) {
      clearMonitoringDraft("watchedFolders");
      return;
    }
    const ok = await run(key, () => update({ monitoring: { watchedFolders: folders } }), "Could not save the folders.");
    if (ok) clearMonitoringDraft("watchedFolders");
  };

  /**
   * Saves the disk levels as the pair the server takes: each from its pending draft, else as saved.
   * A blank level puts its default back. Each is checked on its own (the error goes under it), then
   * warning above critical (the error goes under `edited`, the field just left); a valid pair goes
   * in one PATCH and both drafts clear. So lowering both levels works in either order: the first
   * field waits, with a reason, until the second makes the pair valid.
   */
  const saveDiskLevels = async (edited: DiskLevelField) => {
    if (!settings) return;
    const disk = { ...settings.monitoring.disk };
    let valid = true;
    for (const field of diskLevelFields) {
      const draft = monitoringDrafts[field];
      if (draft === undefined) continue;
      const trimmed = draft.trim();
      const gb = trimmed ? Number(trimmed) : monitoringFieldMeta[field].default;
      if (!/^\d*$/.test(trimmed) || !isDiskLevelGb(gb)) {
        setStatusFor(`monitoring.${field}`, {
          kind: "error",
          message: `Enter a whole number of GB from ${monitoringLimits.minGb} to ${monitoringLimits.maxGb.toLocaleString("en-US")}.`,
        });
        valid = false;
      } else disk[field] = gb;
    }
    if (!valid) return;
    if (disk.warnFreeGb <= disk.criticalFreeGb) {
      const other: DiskLevelField = edited === "warnFreeGb" ? "criticalFreeGb" : "warnFreeGb";
      setStatusFor(`monitoring.${other}`, null);
      setStatusFor(`monitoring.${edited}`, {
        kind: "error",
        message: edited === "warnFreeGb"
          ? `The warning level must be above the critical level (${disk.criticalFreeGb} GB).`
          : `The critical level must be below the warning level (${disk.warnFreeGb} GB).`,
      });
      return;
    }
    for (const field of diskLevelFields) setStatusFor(`monitoring.${field}`, null);
    const clearLevelDrafts = () => diskLevelFields.forEach(clearMonitoringDraft);
    if (disk.warnFreeGb === settings.monitoring.disk.warnFreeGb && disk.criticalFreeGb === settings.monitoring.disk.criticalFreeGb) {
      clearLevelDrafts();
      return;
    }
    const ok = await run("monitoring.disk", () => update({ monitoring: { disk } }), "Could not save the levels.");
    if (ok) clearLevelDrafts();
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
    for (const field of sessionsFields) {
      const draft = sessionsDrafts[field];
      if (draft !== undefined) void saveSessionsField(field, draft);
    }
    if (idleStopDraft !== undefined) void saveIdleStopMinutes(idleStopDraft);
    // The disk levels go as one pair, whichever of them has a draft.
    const levelDraft = diskLevelFields.find((field) => monitoringDrafts[field] !== undefined);
    if (levelDraft) void saveDiskLevels(levelDraft);
    if (monitoringDrafts.watchedFolders !== undefined) void saveWatchedFolders(monitoringDrafts.watchedFolders);
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
              {modelRoles.map((role) => {
                const { modelField, providerKey, title, about, providerLabel } = roleFields[role];
                const choice = roleChoiceOf(settings.orchestrator, role);
                return (
                  <div key={role} className="space-y-3 rounded-xl border border-border/60 p-4">
                    <div className="space-y-1">
                      <p className="text-xs font-medium">{title}</p>
                      <p className="text-xs leading-relaxed text-muted-foreground">{about}</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ProviderField
                        label={providerLabel}
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

      {active === "sessions" && (
        <section aria-labelledby="settings-sessions" className="space-y-4">
          <SectionHeading id="settings-sessions" section="sessions" />
          {settings &&
            sessionsFields.map((field) => (
              <HoursField
                key={field}
                field={field}
                value={sessionsDrafts[field] ?? String(sessionsValue(settings, field))}
                dirty={sessionsDrafts[field] !== undefined}
                saving={!!saving[field]}
                status={status[field] ?? null}
                onChange={(value) =>
                  setSessionsDrafts((prev) => ({ ...prev, [field]: value }))
                }
                onBlur={() => {
                  const draft = sessionsDrafts[field];
                  if (draft !== undefined) void saveSessionsField(field, draft);
                }}
              />
            ))}
          {settings && (
            <IdleStopField
              enabled={settings.sessions.idleStop.enabled}
              value={idleStopDraft ?? String(settings.sessions.idleStop.afterMinutes)}
              dirty={idleStopDraft !== undefined}
              saving={{ enabled: !!saving["idleStop.enabled"], minutes: !!saving["idleStop.afterMinutes"] }}
              status={{ enabled: status["idleStop.enabled"] ?? null, minutes: status["idleStop.afterMinutes"] ?? null }}
              onToggle={(enabled) => void saveIdleStopEnabled(enabled)}
              onChange={setIdleStopDraft}
              onBlur={() => {
                if (idleStopDraft !== undefined) void saveIdleStopMinutes(idleStopDraft);
              }}
            />
          )}
        </section>
      )}

      {active === "monitoring" && (
        <section aria-labelledby="settings-monitoring" className="space-y-4">
          <SectionHeading id="settings-monitoring" section="monitoring" />
          {settings && (
            <MonitoringSettings
              values={Object.fromEntries(monitoringFields.map((field) => [field, monitoringDrafts[field] ?? monitoringValue(settings, field)])) as Record<MonitoringField, string>}
              saved={settings.monitoring.watchedFolders}
              dirty={(field) => monitoringDrafts[field] !== undefined}
              saving={(field) => !!saving[`monitoring.${field}`]}
              status={(field) => status[`monitoring.${field}`] ?? null}
              onChange={(field, value) => setMonitoringDrafts((prev) => ({ ...prev, [field]: value }))}
              onBlur={(field) => {
                if (field === "watchedFolders") {
                  if (monitoringDrafts.watchedFolders !== undefined) void saveWatchedFolders(monitoringDrafts.watchedFolders);
                } else if (monitoringDrafts[field] !== undefined) void saveDiskLevels(field);
              }}
            />
          )}
        </section>
      )}

      {active === "data" && (
        <section aria-labelledby="settings-data" className="space-y-4">
          <SectionHeading id="settings-data" section="data" />
          <DeleteRemovedSessions onDeleted={onRemovedDeleted} />
        </section>
      )}

      {active === "room" && (
        <section aria-labelledby="settings-room" className="space-y-4">
          <SectionHeading id="settings-room" section="room" />
          <RoomSettings />
        </section>
      )}

      {active === "importExport" && (
        <section aria-labelledby="settings-import-export" className="space-y-4">
          <SectionHeading id="settings-import-export" section="importExport" />
          {settings && (
            <ImportExportSettings
              settings={settings}
              onImported={() => {
                // Unsaved edits from before the import must not overwrite it when the dialog closes.
                resetFeedback();
                setDrafts({});
                setOrchestratorDrafts({});
                setScriptDrafts({});
                setSessionsDrafts({});
                setIdleStopDraft(undefined);
                setMonitoringDrafts({});
              }}
            />
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

/** One lifecycle clock: a whole number of hours, the default as the placeholder; blank saves the default. */
function HoursField({
  field,
  value,
  dirty,
  saving,
  status,
  onChange,
  onBlur,
}: {
  field: SessionsField;
  value: string;
  dirty: boolean;
  saving: boolean;
  status: FieldStatus | null;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  const statusId = `${id}-status`;
  const descriptionId = `${id}-description`;
  const meta = sessionsFieldMeta[field];
  return (
    <div className="space-y-2 rounded-xl border border-border/60 p-4">
      <label htmlFor={id} className="text-xs font-medium">
        {meta.label}
      </label>
      <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
        {meta.description}
      </p>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          // Text, not number: a number input reads an unparsable entry ("5e") as "", which would save
          // the default; as text, saveSessionsField's digits check rejects it.
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          placeholder={String(meta.default)}
          disabled={saving}
          aria-describedby={status ? `${descriptionId} ${statusId}` : descriptionId}
          aria-invalid={status?.kind === "error" || undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="w-28 text-xs md:text-xs"
        />
        <span className="text-xs text-muted-foreground">hours</span>
      </div>
      <FieldStatusText id={statusId} status={status} saving={saving} dirty={dirty} />
    </div>
  );
}

/** The idle CLI stop (docs/MONITORING.md): on or off, and after how many idle minutes. The toggle saves as it is flipped, the minutes when the field is left. */
function IdleStopField({
  enabled,
  value,
  dirty,
  saving,
  status,
  onToggle,
  onChange,
  onBlur,
}: {
  enabled: boolean;
  value: string;
  dirty: boolean;
  saving: { enabled: boolean; minutes: boolean };
  status: { enabled: FieldStatus | null; minutes: FieldStatus | null };
  onToggle: (enabled: boolean) => void;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  const switchId = `${id}-switch`;
  const statusId = `${id}-status`;
  return (
    <div className="space-y-2 rounded-xl border border-border/60 p-4">
      <div className="flex h-8 items-center gap-2.5">
        <Switch
          id={switchId}
          checked={enabled}
          disabled={saving.enabled}
          aria-describedby={`${id}-description`}
          onCheckedChange={onToggle}
        />
        <label htmlFor={switchId} className="text-xs font-medium">
          Stop idle agent CLIs
        </label>
        <span className="text-[11px] text-muted-foreground" aria-live="polite">
          {status.enabled?.kind === "error" ? status.enabled.message : status.enabled?.kind === "saved" ? "Saved" : ""}
        </span>
      </div>
      <p id={`${id}-description`} className="text-xs leading-relaxed text-muted-foreground">
        A session&apos;s agent CLI is stopped once the session has been idle this long, counted from no
        earlier than when it was last opened. Nothing is deleted: the next prompt, or opening the
        session, starts it again. Each stop is logged in Activity.
      </p>
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Stop after … minutes idle
        </label>
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          placeholder={String(defaultSettings.sessions.idleStop.afterMinutes)}
          disabled={saving.minutes || !enabled}
          aria-describedby={status.minutes ? statusId : undefined}
          aria-invalid={status.minutes?.kind === "error" || undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="w-28 text-xs md:text-xs"
        />
        <span className="text-xs text-muted-foreground">minutes idle</span>
      </div>
      <FieldStatusText id={statusId} status={status.minutes} saving={saving.minutes} dirty={dirty} />
    </div>
  );
}

/**
 * The Monitoring section: the disk levels and the watched folders. A folder that is not there is
 * flagged but kept (it may be mounted later); `POST /api/monitoring/folders/check` is asked when
 * the section opens and again whenever the saved list changes.
 */
function MonitoringSettings({
  values,
  saved,
  dirty,
  saving,
  status,
  onChange,
  onBlur,
}: {
  values: Record<MonitoringField, string>;
  /** The folders as stored: only these can have been surveyed. */
  saved: string[];
  dirty: (field: MonitoringField) => boolean;
  /** Per field, or `"disk"` for the pair of levels, which saves as one. */
  saving: (field: MonitoringField | "disk") => boolean;
  status: (field: MonitoringField | "disk") => FieldStatus | null;
  onChange: (field: MonitoringField, value: string) => void;
  onBlur: (field: MonitoringField) => void;
}) {
  const id = useId();
  const [check, setCheck] = useState<FolderCheckResult | null>(null);
  const savedKey = saved.join("\n");
  useEffect(() => {
    // No folders: nothing to ask, and an older answer names none of them (only saved folders are flagged).
    if (!savedKey) return;
    const paths = savedKey.split("\n");
    const controller = new AbortController();
    portalJson<FolderCheckResult>("/api/monitoring/folders/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
      signal: controller.signal,
    })
      .then(setCheck)
      // No answer means no warnings; the folders still save.
      .catch((e: unknown) => {
        if (!isAbort(e)) setCheck(null);
      });
    return () => controller.abort();
  }, [savedKey]);
  const missing = missingWatchedFolders(saved, check);
  const savingLevels = saving("disk");
  return (
    <>
      <div className="space-y-3 rounded-xl border border-border/60 p-4">
        <div className="space-y-1">
          <p className="text-xs font-medium">Disk levels</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Free space on the volume holding Portal&apos;s home. Below the warning level the disk shows
            amber in Monitoring, below the critical level red. Leave a field empty for its default.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {(["warnFreeGb", "criticalFreeGb"] as const).map((field) => {
            const fieldId = `${id}-${field}`;
            const statusId = `${fieldId}-status`;
            const fieldStatus = status(field);
            return (
              <div key={field} className="space-y-2">
                <label htmlFor={fieldId} className="text-xs font-medium">
                  {monitoringFieldMeta[field].label}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id={fieldId}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={values[field]}
                    placeholder={String(monitoringFieldMeta[field].default)}
                    disabled={savingLevels}
                    aria-describedby={fieldStatus ? statusId : undefined}
                    aria-invalid={fieldStatus?.kind === "error" || undefined}
                    onChange={(e) => onChange(field, e.target.value)}
                    onBlur={() => onBlur(field)}
                    className="w-28 text-xs md:text-xs"
                  />
                  <span className="text-xs text-muted-foreground">GB</span>
                </div>
                <FieldStatusText id={statusId} status={fieldStatus} saving={false} dirty={dirty(field)} />
              </div>
            );
          })}
        </div>
        <FieldStatusText id={`${id}-levels-status`} status={status("disk")} saving={savingLevels} />
      </div>
      <div className="space-y-2 rounded-xl border border-border/60 p-4">
        <label htmlFor={`${id}-folders`} className="text-xs font-medium">
          Watched folders
        </label>
        <p id={`${id}-folders-description`} className="text-xs leading-relaxed text-muted-foreground">
          Folders outside Portal whose size Monitoring shows, with their ten largest items. One
          absolute path (or ~/…) per line, up to {monitoringLimits.watchedFolders}. For example
          ~/Library/Caches/bazel, ~/.codex, ~/.claude.
        </p>
        <Textarea
          id={`${id}-folders`}
          rows={4}
          value={values.watchedFolders}
          disabled={saving("watchedFolders")}
          spellCheck={false}
          placeholder={"~/Library/Caches/bazel\n~/.codex"}
          aria-describedby={`${id}-folders-description${status("watchedFolders") ? ` ${id}-folders-status` : ""}`}
          aria-invalid={status("watchedFolders")?.kind === "error" || undefined}
          onChange={(e) => onChange("watchedFolders", e.target.value)}
          onBlur={() => onBlur("watchedFolders")}
          className="min-h-20 resize-y font-mono text-xs leading-relaxed md:text-xs"
        />
        {missing.length > 0 && (
          <p role="status" className="text-[11px] text-amber-300">
            Not found: {missing.join(", ")}. Kept in the list; it is measured once it exists.
          </p>
        )}
        <FieldStatusText id={`${id}-folders-status`} status={status("watchedFolders")} saving={saving("watchedFolders")} dirty={dirty("watchedFolders")} />
      </div>
    </>
  );
}

async function errorOf(r: Response, fallback: string): Promise<Error> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(j.error || fallback);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Rule 3: Removed is emptied by hand. Counts the conversations of removed projects
 * (`GET /api/projects/removed`), asks once inline, then `DELETE /api/sessions/removed` and says how many went.
 */
function DeleteRemovedSessions({ onDeleted }: { onDeleted?: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects/removed", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw await errorOf(r, "Could not count removed sessions.");
        const { removed } = (await r.json()) as { removed: RemovedProjectSummary[] };
        setCount(removed.reduce((n, row) => n + row.sessionCount, 0));
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          e instanceof Error && e.message !== "Failed to fetch"
            ? e.message
            : "Could not reach the server. Check the connection and try again.",
        );
      });
    return () => controller.abort();
  }, [reload]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/sessions/removed", { method: "DELETE" });
      if (!r.ok) throw await errorOf(r, "Could not delete removed sessions. Try again.");
      const { deleted } = (await r.json()) as { deleted: number };
      setResult(`Deleted ${plural(deleted, "session", "sessions")}.`);
      setConfirming(false);
      setReload((n) => n + 1);
      onDeleted?.();
    } catch (e) {
      setError(
        e instanceof Error && e.message !== "Failed to fetch"
          ? e.message
          : "Could not reach the server. Check the connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const none = count === 0;
  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-4">
      <div className="space-y-1">
        <p className="text-xs font-medium">Delete removed sessions</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Permanently deletes every conversation whose project was removed, transcripts included,
          and empties the Removed list. Conversations in listed projects are never touched.
        </p>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {loadError
          ? null
          : count === null
            ? "Counting removed sessions…"
            : none
              ? "No removed sessions."
              : `${plural(count, "removed session", "removed sessions")}.`}
      </p>
      {loadError && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-[11px] text-destructive">
            {loadError}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setLoadError(null);
              setReload((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {confirming ? (
        <div
          role="group"
          aria-label="Delete removed sessions?"
          className="space-y-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs"
        >
          <p className="leading-relaxed">
            Delete {count === null ? "all removed sessions" : plural(count, "removed session", "removed sessions")} for good?
            This cannot be undone.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={none || count === null}
          onClick={() => {
            setResult(null);
            setError(null);
            setConfirming(true);
          }}
        >
          Delete removed sessions
        </Button>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-[11px] text-muted-foreground">
          {result}
        </p>
      )}
    </div>
  );
}

const roomSources: Record<RoomEnvironment["source"], string> = {
  config: "set by PORTAL_LOCATION",
  ip: "from the server's public IP address",
  none: "not resolved yet; the browser's time zone stands in",
};

const roomConditions: Record<RoomWeather["condition"], string> = {
  clear: "Clear",
  "partly-cloudy": "Partly cloudy",
  overcast: "Overcast",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  "heavy-rain": "Heavy rain",
  snow: "Snow",
  thunderstorm: "Thunderstorm",
};

/**
 * The Room section (docs/PALACE.md, Settings): the room's location to two decimals with where it
 * came from, the weather with the provider's credit, a Refresh that looks both up again
 * (`POST /api/room/refresh`) and shows the answer, and the layout version.
 */
function RoomSettings() {
  const room = useRoomState();
  const unavailable = useRoomFailed();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const environment = room?.environment ?? null;
  const weather = environment?.weather ?? null;

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setRefreshed(false);
    try {
      publishRoomState(await portalSend<RoomState>("/api/room/refresh", "POST", undefined, "Could not refresh the room. Try again."));
      setRefreshed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh the room. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const located = environment && environment.latitude !== null && environment.longitude !== null;
  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-4 text-xs">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
        <dt className="text-muted-foreground">Location</dt>
        <dd data-room-location>
          {!room
            ? unavailable
              ? "Unavailable"
              : "Loading…"
            : located
              ? `${environment.latitude!.toFixed(2)}, ${environment.longitude!.toFixed(2)}`
              : "Unknown"}
          {environment && <span className="text-muted-foreground"> · {roomSources[environment.source]}</span>}
          {environment?.timezone && <span className="block text-muted-foreground">{environment.timezone}</span>}
        </dd>
        <dt className="text-muted-foreground">Weather</dt>
        <dd data-room-weather>
          {weather
            ? `${roomConditions[weather.condition]}, ${Math.round(weather.temperature)}°C, ${weather.isDay ? "day" : "night"}`
            : room
              ? "Not known yet; the window shows a clear sky"
              : unavailable
                ? "Unavailable"
                : "Loading…"}
          {weather && (
            <span className="block text-muted-foreground">
              Updated {new Date(weather.fetchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <a
            href="https://open-meteo.com/"
            target="_blank"
            rel="noreferrer"
            className="mt-1 block text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Weather data by Open-Meteo.com
          </a>
        </dd>
        <dt className="text-muted-foreground">Layout version</dt>
        <dd data-room-layout>{room?.layoutVersion ?? LAYOUT_VERSION}</dd>
      </dl>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
        <p role="status" className="text-[11px] text-muted-foreground">
          {refreshed ? "Location and weather looked up again." : "Looks the location and weather up again."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A section pane's heading: the same label as its nav entry, then what the section is for. */
/**
 * The Import & Export section: every setting as JSON to copy, and a box to paste one into. Apply
 * checks the paste is JSON; the server then refuses anything but a full export with valid values
 * (`PUT /api/settings`) before replacing every setting. API keys are part of neither.
 */
function ImportExportSettings({
  settings,
  onImported,
}: {
  settings: Settings;
  onImported: () => void;
}) {
  const { importSettings } = useSettings();
  const id = useId();
  const exported = JSON.stringify(exportSettings(settings), null, 2);
  const [copyResult, setCopyResult] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const copy = async () => {
    setCopyResult(
      (await copyText(exported))
        ? "Copied."
        : "Could not copy. Select the text and copy it instead.",
    );
  };

  const apply = async () => {
    setError(null);
    setApplied(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(true);
    try {
      await importSettings(parsed);
      setText("");
      setApplied(true);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import settings. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-border/60 p-4">
        <div className="space-y-1">
          <label htmlFor={`${id}-export`} className="text-xs font-medium">
            Export
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The current settings, defaults included.
          </p>
        </div>
        <Textarea
          id={`${id}-export`}
          rows={10}
          readOnly
          value={exported}
          spellCheck={false}
          wrap="off"
          className="max-h-64 font-mono text-[11px]"
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
            Copy
          </Button>
          {copyResult && (
            <p role="status" className="text-[11px] text-muted-foreground">
              {copyResult}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-border/60 p-4">
        <div className="space-y-1">
          <label htmlFor={`${id}-import`} className="text-xs font-medium">
            Import
          </label>
          <p id={`${id}-import-description`} className="text-xs leading-relaxed text-muted-foreground">
            Paste a full export. Apply replaces every setting with it; nothing changes unless all of it is valid.
          </p>
        </div>
        <Textarea
          id={`${id}-import`}
          rows={10}
          value={text}
          disabled={busy}
          spellCheck={false}
          placeholder={'{\n  "version": 1,\n  …\n}'}
          wrap="off"
          className="max-h-64 font-mono text-[11px]"
          aria-describedby={`${id}-import-description${error ? ` ${id}-import-error` : ""}`}
          aria-invalid={!!error || undefined}
          onChange={(e) => {
            setText(e.target.value);
            setApplied(false);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || !text.trim()}
          onClick={() => void apply()}
        >
          {busy ? "Applying…" : "Apply"}
        </Button>
        {error && (
          <p id={`${id}-import-error`} role="alert" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
        {applied && (
          <p role="status" className="text-[11px] text-muted-foreground">
            Settings imported.
          </p>
        )}
      </div>
    </div>
  );
}

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
