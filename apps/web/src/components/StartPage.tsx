"use client";

import { useId } from "react";
import WorktreePicker, { type WorktreeChoice } from "./WorktreePicker";
import ProjectPicker from "./ProjectPicker";
import ContextBar from "./ContextBar";
import AgentLogo from "./AgentLogo";
import PortalMark from "./PortalMark";
import ChatComposer from "./ChatComposer";
import SessionControls from "./SessionControls";
import { useDraft } from "./useDraft";
import { worktreeTarget } from "@/lib/branch-matching";
import type { PinMap } from "@/lib/pins";
import { Button } from "@/components/ui/button";
import type {
  AgentInfo,
  ProjectSummary,
  SessionListState,
  SetConfigRequest,
} from "@/lib/types";

export type StartPageProps = {
  /** In display order: pinned projects first, then the most recently worked in. */
  projects: ProjectSummary[];
  projectPins: PinMap;
  /** The chosen project, or "" for none yet (the worktree control waits for one). */
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  /** Add a host folder as a project and select it; rejects with the message to show. */
  onAddFolder: (path: string) => Promise<void>;
  worktree: WorktreeChoice;
  onWorktreeChange: (choice: WorktreeChoice) => void;
  agents: AgentInfo[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  /** Agent settings for the new session, seeded from the agent's latest session; null when none are known yet. */
  settings: SessionListState | null;
  onSettingsChange: (request: SetConfigRequest) => void;
  loading?: boolean;
  canCreate: boolean;
  creating: boolean;
  error: string | null;
  onCreate: (firstPrompt?: string) => void;
  /** Where the first message is drafted (`startKey`): one per start-page pane, so two open at once do not share a draft. */
  draftKey?: string;
};

export default function StartPage({
  projects,
  projectPins,
  selectedProjectId,
  onSelectProject,
  onAddFolder,
  worktree,
  onWorktreeChange,
  agents,
  selectedAgentId,
  onSelectAgent,
  settings,
  onSettingsChange,
  loading = false,
  canCreate,
  creating,
  error,
  onCreate,
  draftKey = "new",
}: StartPageProps) {
  const [draft, setDraft] = useDraft(draftKey);
  /** Per instance: two start pages may be open at once (one per pane), and ids and radio group names must not collide. */
  const uid = useId();
  const titleId = `${uid}-title`;
  const project = projects.find((item) => item.id === selectedProjectId);
  const target = project ? worktreeTarget(project, worktree) : null;
  const git =
    target && project?.git
      ? { ...project.git, branch: target.branch, detached: false }
      : (project?.git ?? null);
  const ready = canCreate && !!project && project.exists !== false;
  return (
    <section
      aria-labelledby={titleId}
      className="mx-auto flex w-full max-w-[780px] flex-col px-6 pb-12 pt-[clamp(48px,13vh,160px)] sm:px-10"
    >
      <div className="mb-9 text-center">
        <PortalMark className="mx-auto mb-6 size-14" />
        <h2
          id={titleId}
          className="text-[clamp(26px,3vw,34px)] font-medium tracking-[-.045em]"
        >
          What would you like to work on?
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Choose a project and an agent to get started.
        </p>
      </div>
      <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-white/5 bg-white/[.015] p-4 sm:flex-row sm:items-start sm:gap-4">
        <div className="start-picker min-w-0 flex-1">
          <ProjectPicker
            projects={projects}
            pins={projectPins}
            value={selectedProjectId}
            onChange={onSelectProject}
            onAddFolder={onAddFolder}
            disabled={loading || creating}
          />
        </div>
        {project?.git && (
          <div className="start-picker min-w-0 flex-1">
            <WorktreePicker
              project={project}
              value={worktree}
              onChange={onWorktreeChange}
              disabled={loading || creating}
            />
          </div>
        )}
      </div>
      <fieldset disabled={loading || creating} className="mb-5">
        <legend className="sr-only">Agent</legend>
        <div className="flex justify-center gap-2">
          {agents.map((agent) => (
            <label key={agent.id} className="relative cursor-pointer">
              <input
                type="radio"
                name={`${uid}-agent`}
                value={agent.id}
                checked={agent.id === selectedAgentId}
                onChange={() => onSelectAgent(agent.id)}
                className="peer sr-only"
              />
              <span className="flex items-center gap-2.5 rounded-full border border-transparent px-4 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground peer-checked:border-white/10 peer-checked:bg-white/5 peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50">
                <AgentLogo agentId={agent.id} className="!size-4" />
                {agent.name}
              </span>
            </label>
          ))}
          {agents.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {loading ? "Loading agents…" : "Agents unavailable"}
            </p>
          )}
        </div>
      </fieldset>
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => onCreate(draft)}
        sending={creating}
        disabled={!ready && !creating}
        label="First message"
        placeholder={project ? "What would you like to build?" : "Choose a project to begin"}
        paletteId={`${uid}-palette`}
        error={error}
        settings={
          settings && (
            <SessionControls
              state={settings}
              disabled={loading || creating}
              onChange={onSettingsChange}
            />
          )
        }
        context={
          <ContextBar
            cwd={target?.displayPath ?? project?.path}
            displayCwd={target?.displayPath ?? project?.displayPath}
            git={git}
            note={
              project?.exists === false
                ? "Project folder is missing"
                : worktree.kind === "create"
                  ? "A new branch and worktree will be created"
                  : undefined
            }
          />
        }
      />
      <div className="mt-5 text-center">
        <Button
          variant="ghost"
          size="sm"
          disabled={!ready}
          onClick={() => onCreate()}
          className="text-[11px] text-muted-foreground/80"
        >
          Start an empty conversation
        </Button>
      </div>
    </section>
  );
}
