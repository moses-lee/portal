"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ExternalLink, LoaderCircle, RefreshCw, ShieldOff, TriangleAlert } from "lucide-react";
import type { PortalLinks } from "../PortalPage";
import { At, Badge, Empty, ErrorLine, Loading, SectionTitle, ViewBody, When, type Tone } from "./bits";
import { usePortalEvents, useNow } from "./PortalLive";
import { Button } from "@/components/ui/button";
import { portalJson, portalSend } from "@/lib/orchestrator/api";
import { formatTokens } from "@/lib/orchestrator/format";
import type { ApprovalGrant, CoreDocument, WorldResponse, WorldSession } from "@/lib/orchestrator/types";

/** The exact text the model is given, in a scrollable monospace block with its size. */
function PromptText({ label, text }: { label: string; text: string }) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="max-h-[28rem] overflow-auto rounded-2xl border border-white/8 bg-black/25 p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground/85"
    >
      {text || "(empty)"}
    </pre>
  );
}

function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/8 bg-white/[.02]">
      <table aria-label={label} className="w-full min-w-[560px] text-left text-xs">
        <thead>
          <tr className="border-b border-white/5 text-[10px] tracking-wider text-muted-foreground uppercase">
            {head.map((cell) => (
              <th key={cell} scope="col" className="px-3 py-2 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">{children}</tbody>
      </table>
    </div>
  );
}

const activityTone: Record<WorldSession["activity"], Tone> = {
  idle: "neutral",
  working: "sky",
  waiting: "amber",
  connecting: "neutral",
  error: "rose",
};

function WorldTables({ world, now, onOpenSession }: { world: WorldResponse["world"]; now: number; onOpenSession: (id: string) => void }) {
  const projectNames = new Map(world.projects.map((project) => [project.id, project.name]));
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Repositories and projects</h3>
        {world.projects.length === 0 ? (
          <Empty>No projects.</Empty>
        ) : (
          <Table label="Projects" head={["Project", "Repository", "Branch", "State"]}>
            {world.projects.map((project) => (
              <tr key={project.id}>
                <td className="px-3 py-2">
                  <span className={project.worktree ? "pl-3 text-foreground/80" : "font-medium"}>{project.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">{project.path}</span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">{project.repo ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{project.worktree?.branch ?? project.branch ?? "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {project.missing && <Badge tone="rose">Missing</Badge>}
                    {project.worktree && <Badge>Worktree</Badge>}
                    {project.worktree?.merged && <Badge tone="violet">Merged</Badge>}
                    {project.worktree?.dirty && <Badge tone="amber">Dirty</Badge>}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Sessions</h3>
        {world.sessions.length === 0 ? (
          <Empty>No sessions.</Empty>
        ) : (
          <Table label="Sessions" head={["Session", "Project", "Agent", "State", "Last active"]}>
            {world.sessions.map((session) => (
              <tr key={session.id}>
                <td className="max-w-[260px] px-3 py-2">
                  <button type="button" onClick={() => onOpenSession(session.id)} className="truncate text-left hover:underline">
                    {session.title ?? "Untitled session"}
                  </button>
                </td>
                <td className="px-3 py-2">{projectNames.get(session.projectId) ?? session.projectId}</td>
                <td className="px-3 py-2">{session.agentName}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <Badge tone={activityTone[session.activity]}>{session.activity}</Badge>
                    {session.link !== "live" && <Badge>{session.link}</Badge>}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  <When at={session.lastActiveAt} now={now} past />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Pull requests</h3>
        {world.pulls.length === 0 ? (
          <Empty>No pull requests need you.</Empty>
        ) : (
          <Table label="Pull requests" head={["Pull request", "Role", "State", "Checks", "Review", "Merge"]}>
            {world.pulls.map((pull) => (
              <tr key={pull.url}>
                <td className="max-w-[320px] px-3 py-2">
                  <a href={pull.url} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-1 hover:underline">
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {pull.repo}#{pull.number}
                    </span>
                    <span className="truncate">{pull.title}</span>
                    <ExternalLink className="size-2.5 shrink-0 opacity-50" />
                  </a>
                </td>
                <td className="px-3 py-2">{pull.roles.join(", ")}</td>
                <td className="px-3 py-2">
                  <Badge tone={pull.state === "merged" ? "violet" : pull.state === "closed" ? "neutral" : "emerald"}>
                    {pull.draft ? "draft" : pull.state}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  {pull.checks ? <Badge tone={pull.checks === "failing" ? "rose" : pull.checks === "passing" ? "emerald" : "amber"}>{pull.checks}</Badge> : "—"}
                </td>
                <td className="px-3 py-2">{pull.reviewDecision?.replace(/_/g, " ") ?? "—"}</td>
                <td className="px-3 py-2">{pull.mergeable === "conflicting" ? <Badge tone="rose">conflicts</Badge> : pull.mergeable}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </div>
  );
}

function GrantScope({ grant }: { grant: ApprovalGrant }) {
  switch (grant.scope) {
    case "always":
      return <>Everywhere</>;
    case "repo":
      return <>In {grant.repo ?? "one repository"}</>;
    case "job":
      return <>For {grant.intentId ? "one goal" : "one job"}</>;
  }
}

/**
 * What the model is shown, for auditing: CORE.md (pinned directives and the entity index, as it is
 * injected into every turn) and the world state, both the rendered text exactly as the model sees
 * it and readable tables of projects, sessions, and PRs, with a rebuild button. Below them, the
 * approval grants in force, each revocable.
 */
export default function SystemView({ links }: { links: PortalLinks }) {
  const now = useNow(30_000);
  const [core, setCore] = useState<CoreDocument | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [world, setWorld] = useState<WorldResponse | null>(null);
  const [worldError, setWorldError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [grants, setGrants] = useState<ApprovalGrant[] | null>(null);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [worldRequest, setWorldRequest] = useState(0);
  const [coreRequest, setCoreRequest] = useState(0);
  const [grantsRequest, setGrantsRequest] = useState(0);
  const [worldTab, setWorldTab] = useState<"tables" | "prompt">("tables");

  useEffect(() => {
    const controller = new AbortController();
    portalJson<CoreDocument>("/api/portal/memory/core", { signal: controller.signal })
      .then((doc) => {
        setCore(doc);
        setCoreError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setCoreError(e instanceof Error ? e.message : "Could not load CORE.md.");
      });
    return () => controller.abort();
  }, [coreRequest]);

  useEffect(() => {
    const controller = new AbortController();
    portalJson<WorldResponse>("/api/portal/world", { signal: controller.signal })
      .then((result) => {
        setWorld(result);
        setWorldError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setWorldError(e instanceof Error ? e.message : "Could not load the world state.");
      });
    return () => controller.abort();
  }, [worldRequest]);

  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ grants: ApprovalGrant[] }>("/api/portal/approvals/grants", { signal: controller.signal })
      .then(({ grants }) => {
        setGrants(grants);
        setGrantsError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setGrantsError(e instanceof Error ? e.message : "Could not load the grants.");
      });
    return () => controller.abort();
  }, [grantsRequest]);

  usePortalEvents((event) => {
    if (event.type === "world" && (!world || event.at > world.world.at)) setWorldRequest((n) => n + 1);
    else if (event.type === "memory") setCoreRequest((n) => n + 1);
    else if (event.type === "approvals") setGrantsRequest((n) => n + 1);
    else if (event.type === "reconnected") {
      setWorldRequest((n) => n + 1);
      setCoreRequest((n) => n + 1);
      setGrantsRequest((n) => n + 1);
    }
  });

  const refresh = async () => {
    setRefreshing(true);
    setWorldError(null);
    try {
      setWorld(await portalSend<WorldResponse>("/api/portal/world/refresh", "POST", undefined, "Could not rebuild the world state."));
    } catch (e) {
      setWorldError(e instanceof Error ? e.message : "Could not rebuild the world state.");
    } finally {
      setRefreshing(false);
    }
  };

  const revoke = async (grant: ApprovalGrant) => {
    setRevoking(grant.id);
    setGrantsError(null);
    try {
      await portalSend(`/api/portal/approvals/grants/${encodeURIComponent(grant.id)}`, "DELETE");
      setGrants((prev) => (prev ?? []).filter((row) => row.id !== grant.id));
    } catch (e) {
      setGrantsError(e instanceof Error ? e.message : "Could not revoke the grant.");
    } finally {
      setRevoking(null);
    }
  };

  const liveGrants = useMemo(() => (grants ?? []).filter((grant) => grant.revokedAt === null), [grants]);

  return (
    <ViewBody label="System" wide>
      <section aria-labelledby="system-core">
        <SectionTitle
          id="system-core"
          actions={core && <span className="text-[11px] text-muted-foreground">{formatTokens(core.tokens)} tokens · generated <When at={core.generatedAt} now={now} past /></span>}
        >
          CORE.md
        </SectionTitle>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Pinned directives and one line per memory entity, placed at the top of every turn exactly as below.
        </p>
        <ErrorLine>{coreError}</ErrorLine>
        {!core && !coreError && <Loading>Loading CORE.md…</Loading>}
        {core && <PromptText label="CORE.md contents" text={core.text} />}
      </section>

      <section aria-labelledby="system-world">
        <SectionTitle
          id="system-world"
          actions={
            <>
              {world && (
                <span className="mr-1 text-[11px] text-muted-foreground">
                  {formatTokens(world.tokens)} tokens · built <When at={world.world.at} now={now} past />
                </span>
              )}
              <Button type="button" size="xs" variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
                {refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Refresh
              </Button>
            </>
          }
        >
          World
        </SectionTitle>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          What Portal knows about your projects, sessions, and pull requests. It is rebuilt on every
          check and shown to the model as the rendered text.
        </p>
        <ErrorLine>{worldError}</ErrorLine>
        {!world && !worldError && <Loading>Building the world state…</Loading>}
        {world && (
          <>
            {world.world.errors.length > 0 && (
              <div role="status" className="mb-3 flex items-start gap-2 rounded-xl bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>Could not read {world.world.errors.join(", ")} this time; the previous values were kept.</span>
              </div>
            )}
            <div role="tablist" aria-label="World views" className="mb-3 flex gap-1">
              {(["tables", "prompt"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={worldTab === tab}
                  onClick={() => setWorldTab(tab)}
                  className={`h-7 rounded-full px-3 text-xs ${worldTab === tab ? "bg-white/12 text-foreground" : "text-muted-foreground hover:bg-white/6 hover:text-foreground"}`}
                >
                  {tab === "tables" ? "Tables" : "As the model sees it"}
                </button>
              ))}
            </div>
            {worldTab === "tables" ? (
              <WorldTables world={world.world} now={now} onOpenSession={links.openSession} />
            ) : (
              <PromptText label="World as the model sees it" text={world.rendered} />
            )}
          </>
        )}
      </section>

      <section aria-labelledby="system-grants">
        <SectionTitle id="system-grants" count={grants ? liveGrants.length : undefined}>
          Approval grants
        </SectionTitle>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Standing permissions you gave when approving a request. Revoke one and Portal asks again next time.
        </p>
        <ErrorLine>{grantsError}</ErrorLine>
        {!grants && !grantsError && <Loading>Loading grants…</Loading>}
        {grants && liveGrants.length === 0 && <Empty>No standing grants. Every gated action asks first.</Empty>}
        {liveGrants.length > 0 && (
          <ul className="divide-y divide-white/5 rounded-2xl border border-white/8 bg-white/[.02]">
            {liveGrants.map((grant) => (
              <li key={grant.id} aria-label={`Grant for ${grant.tool}`} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px]">
                    <code className="font-mono text-[12px]">{grant.tool}</code>
                    <span className="ml-2 text-muted-foreground">
                      <GrantScope grant={grant} />
                    </span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    granted <At at={grant.createdAt} now={now} />
                  </p>
                </div>
                <Button type="button" size="xs" variant="ghost" disabled={revoking !== null} onClick={() => void revoke(grant)} className="text-muted-foreground">
                  {revoking === grant.id ? <LoaderCircle className="animate-spin" /> : <ShieldOff />}
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </ViewBody>
  );
}
