"use client";

import { FolderGit2, Plus } from "lucide-react";
import WorktreePicker, { type WorktreeChoice } from "./WorktreePicker";
import ContextBar from "./ContextBar";
import AgentLogo from "./AgentLogo";
import ChatComposer from "./ChatComposer";
import SessionControls from "./SessionControls";
import { useDraft } from "./useDraft";
import { worktreeLabel } from "./WorktreeBadge";
import { worktreeTarget } from "@/lib/branch-matching";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AgentInfo,
  ProjectSummary,
  SessionState,
  SetConfigRequest,
} from "@/lib/types";

export type StartPageProps = {
  projects: ProjectSummary[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  onAddProject: () => void;
  worktree: WorktreeChoice;
  onWorktreeChange: (choice: WorktreeChoice) => void;
  agents: AgentInfo[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  /** Agent settings for the new session, seeded from the agent's latest session; null when none are known yet. */
  settings: SessionState | null;
  onSettingsChange: (request: SetConfigRequest) => void;
  loading?: boolean;
  canCreate: boolean;
  creating: boolean;
  error: string | null;
  onCreate: (firstPrompt?: string) => void;
};

export default function StartPage({
  projects,
  selectedProjectId,
  onSelectProject,
  onAddProject,
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
}: StartPageProps) {
  const [draft, setDraft] = useDraft("new");
  const project = projects.find((item) => item.id === selectedProjectId);
  const target = project ? worktreeTarget(project, worktree) : null;
  const git =
    target && project?.git
      ? { ...project.git, branch: target.branch, detached: false }
      : (project?.git ?? null);
  const ready = canCreate && project?.exists !== false;
  return (
    <section
      aria-labelledby="new-session-title"
      className="mx-auto flex w-full max-w-[780px] flex-col px-6 pb-12 pt-[clamp(48px,13vh,160px)] sm:px-10"
    >
      <div className="mb-9 text-center">
        <span
          className="glass mx-auto mb-6 flex size-14 items-center justify-center rounded-[20px]"
          aria-hidden="true"
        >
          <span className="size-7 rounded-full border-[3px] border-indigo-200/70 shadow-[0_0_24px_#a5b4fc25]" />
        </span>
        <h2
          id="new-session-title"
          className="text-[clamp(26px,3vw,34px)] font-medium tracking-[-.045em]"
        >
          What would you like to work on?
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Choose a project and an agent to get started.
        </p>
      </div>
      {projects.length === 0 ? (
        <div className="glass flex flex-col items-center gap-4 rounded-3xl p-8 text-center">
          <FolderGit2 className="size-7 text-muted-foreground" />
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            Add a local project folder to give your agent a place to work.
          </p>
          <Button
            onClick={onAddProject}
            disabled={loading}
            className="h-10 rounded-full px-5"
          >
            <Plus className="size-4" />
            Add your first project
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-white/5 bg-white/[.015] p-4 sm:flex-row sm:items-start sm:gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <label
                htmlFor="new-session-project"
                className="text-[11px] text-muted-foreground"
              >
                Project
              </label>
              <div className="flex gap-1">
                <Select
                  value={selectedProjectId}
                  onValueChange={onSelectProject}
                  disabled={loading || creating}
                >
                  <SelectTrigger
                    id="new-session-project"
                    className="h-9 min-w-0 flex-1 border-white/5 !bg-white/[.025] text-xs"
                  >
                    <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                        {worktreeLabel(item, projects)
                          ? ` · ${worktreeLabel(item, projects)}`
                          : ""}
                        {item.exists === false ? " (missing)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Add project"
                  onClick={onAddProject}
                  disabled={creating}
                >
                  <Plus className="size-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
            {project?.git && (
              <div className="start-worktree min-w-0 flex-1">
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
                    name="new-session-agent"
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
            placeholder="What would you like to build?"
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
        </>
      )}
      {projects.length === 0 && error && (
        <p role="alert" className="mt-4 text-center text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
