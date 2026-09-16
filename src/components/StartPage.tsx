"use client";

import { BranchBadge } from "./ContextBar";
import WorktreePicker, { type WorktreeChoice } from "./WorktreePicker";
import { worktreeTarget } from "@/lib/branch-matching";
import { orderProjects } from "@/lib/project-tree";
import type { AgentInfo, ProjectSummary } from "@/lib/types";

export type StartPageProps = {
  projects: ProjectSummary[];
  /** Id of the project new sessions start in; "" when none is selected. */
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  onAddProject: () => void;
  /** Worktree to start in; only meaningful for git projects that are not worktrees themselves. */
  worktree: WorktreeChoice;
  onWorktreeChange: (choice: WorktreeChoice) => void;
  agents: AgentInfo[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  /** True while agents, sessions, or projects are still loading; disables the pickers. */
  loading?: boolean;
  canCreate: boolean;
  creating: boolean;
  /** Session-creation error, e.g. the server's "Project folder is missing: ~/x". */
  error: string | null;
  onCreate: () => void;
};

/** The empty-state card shown when no session is active: pick a project and an agent, then start. */
export default function StartPage({
  projects, selectedProjectId, onSelectProject, onAddProject, worktree, onWorktreeChange,
  agents, selectedAgentId, onSelectAgent, loading = false, canCreate, creating, error, onCreate,
}: StartPageProps) {
  const ordered = orderProjects(projects);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const missingFolder = !!error && /missing/i.test(error);
  const canPickWorktree = !!selectedProject?.git && !selectedProject.worktree;
  const parentName = selectedProject?.worktree
    ? projects.find((p) => p.id === selectedProject.worktree?.parentId)?.name ?? "another project"
    : null;
  const target = selectedProject && canPickWorktree ? worktreeTarget(selectedProject, worktree) : null;

  return (
    <section aria-labelledby="new-session-title" className="mx-auto mt-16 max-w-md rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 id="new-session-title" className="text-sm font-semibold text-zinc-200">Start a new session</h2>

      {projects.length === 0 ? (
        <div className="mt-3">
          <p className="text-xs text-zinc-500">Add a project folder to start a session.</p>
          <button
            type="button"
            onClick={onAddProject}
            disabled={loading}
            className="mt-3 w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium hover:bg-zinc-800 disabled:opacity-40"
          >
            + Add project
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <label htmlFor="new-session-project" className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">project</label>
          <div className="flex items-center gap-2">
            <select
              id="new-session-project"
              aria-label="Project"
              value={selectedProjectId}
              onChange={(e) => onSelectProject(e.target.value)}
              disabled={loading || creating}
              className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-50"
            >
              {!selectedProject && <option value="">Choose a project…</option>}
              {ordered.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.depth === 1 ? "  └ " : ""}{project.name}{project.exists === false ? " (missing)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onAddProject}
              disabled={loading}
              className="shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
            >
              Add project…
            </button>
          </div>
          {selectedProject && canPickWorktree && (
            <WorktreePicker project={selectedProject} value={worktree} onChange={onWorktreeChange} disabled={loading || creating} />
          )}
          {selectedProject?.worktree && (
            <p className="mt-2 text-xs text-zinc-500">
              Worktree of <span className="text-zinc-300">{parentName}</span> on <span className="font-mono text-zinc-300">{selectedProject.worktree.branch}</span>
            </p>
          )}
          {selectedProject && (
            <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
              {target && selectedProject.git ? (
                <>
                  <span className="min-w-0 truncate font-mono text-zinc-300" title={target.displayPath}>{target.displayPath}</span>
                  <BranchBadge git={{ ...selectedProject.git, branch: target.branch, detached: false }} />
                  {worktree.kind === "create" && <span>new branch and worktree, created on start</span>}
                  {worktree.kind === "branch" && !worktree.path && <span>worktree created on start</span>}
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate font-mono text-zinc-300" title={selectedProject.path}>{selectedProject.displayPath}</span>
                  <BranchBadge git={selectedProject.git} />
                </>
              )}
              {selectedProject.exists === false && <span className="text-amber-400">This folder is missing on the host.</span>}
            </p>
          )}
        </div>
      )}

      <fieldset className="mt-4" disabled={loading || creating || agents.length === 0}>
        <legend className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">agent</legend>
        <div className="flex flex-wrap gap-2">
          {agents.length === 0 && <span className="text-xs text-zinc-500">{loading ? "Loading agents…" : "Agents unavailable"}</span>}
          {agents.map((agent) => (
            <label key={agent.id} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${agent.id === selectedAgentId ? "border-indigo-500 bg-indigo-950 text-indigo-100" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>
              <input type="radio" name="new-session-agent" value={agent.id} checked={agent.id === selectedAgentId} onChange={() => onSelectAgent(agent.id)} className="sr-only" />
              {agent.name}
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        onClick={onCreate}
        disabled={!canCreate}
        className="mt-4 w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
      >
        {creating ? "Creating session…" : `New session${selectedAgent ? ` with ${selectedAgent.name}` : ""}`}
      </button>
      {projects.length > 0 && !selectedProject && !loading && (
        <p className="mt-2 text-xs text-zinc-500">Choose a project before starting a session.</p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded bg-red-950/50 px-2 py-2 text-xs text-red-300">
          {error}
          {missingFolder && <span className="mt-1 block text-red-200/80">Choose another project above, or add the folder again if it moved.</span>}
        </p>
      )}
    </section>
  );
}
