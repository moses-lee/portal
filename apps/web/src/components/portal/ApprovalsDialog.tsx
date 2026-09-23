"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, ShieldAlert } from "lucide-react";
import PortalMarkdown from "../PortalMarkdown";
import { Badge, JsonBlock, When, type Tone } from "./bits";
import { usePortalLive, useNow } from "./PortalLive";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { portalJson, portalSend } from "@/lib/orchestrator/api";
import {
  MAIN_THREAD_ID,
  type Approval,
  type ApprovalDecision,
  type ApprovalRisk,
  type ApprovalScope,
} from "@/lib/orchestrator/types";
import { portalPath } from "@/lib/session-routes";

const riskMeta: Record<ApprovalRisk, { label: string; tone: Tone }> = {
  write: { label: "Writes", tone: "amber" },
  destructive: { label: "Destructive", tone: "rose" },
  outbound: { label: "Leaves this machine", tone: "violet" },
};

const originLabels: Record<Approval["origin"], string> = {
  chat: "Asked during a chat turn",
  job: "Asked by a background job",
  card: "Asked by an item action",
};

/** The grant choices a request allows: "this job" only when a job or intent asked, "this repo" only when it names one. */
export function scopeChoices(approval: Approval): { scope: ApprovalScope; label: string; hint: string }[] {
  const choices: { scope: ApprovalScope; label: string; hint: string }[] = [
    { scope: "once", label: "Just this once", hint: "Only this exact call." },
  ];
  if (approval.jobId || approval.intentId)
    choices.push({
      scope: "job",
      label: approval.intentId ? "For this goal" : "For this job",
      hint: `Also ${approval.tool} again for the rest of this ${approval.intentId ? "goal" : "job"}.`,
    });
  if (approval.repo)
    choices.push({ scope: "repo", label: `In ${approval.repo}`, hint: `Any ${approval.tool} call on this repository.` });
  choices.push({ scope: "always", label: "Always", hint: `Any ${approval.tool} call, anywhere, until you revoke it.` });
  return choices;
}

function approveLabel(approval: Approval, scope: ApprovalScope): string {
  switch (scope) {
    case "once":
      return "Approve once";
    case "job":
      return approval.intentId ? "Approve for this goal" : "Approve for this job";
    case "repo":
      return "Approve for this repo";
    case "always":
      return "Always approve";
  }
}

/**
 * The approvals dialog, mounted once for the whole app. It opens by itself whenever a pending
 * request arrives over the stream (the only way in besides an explicit "Review request", which
 * also only shows requests the server lists as pending), so text in a transcript can neither
 * raise nor answer one. It cannot be dismissed by clicking outside; "Decide later" (or Escape)
 * tucks a request away, while the status line's pill and the sidebar badge keep it in sight and
 * bring it back.
 * Several requests queue with previous/next. Approving takes a scope; denying needs none.
 */
export default function ApprovalsDialog({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { approvals, setApprovals, requestedApproval, threads } = usePortalLive();
  // A second-by-second clock only while a request is on screen (its expiry counts down).
  const now = useNow(1000, approvals.length > 0);
  /** Requests the user put off; a new request (a new id) opens the dialog again. */
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [scope, setScope] = useState<ApprovalScope>("once");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeName = useId();

  const queue = useMemo(
    () => approvals.filter((approval) => approval.status === "pending").sort((a, b) => a.requestedAt - b.requestedAt),
    [approvals],
  );
  const waiting = queue.filter((approval) => !deferred.has(approval.id));
  const current = waiting.find((approval) => approval.id === focusId) ?? waiting[0] ?? null;
  const index = current ? waiting.indexOf(current) : -1;

  // Keep the scope valid for the request on screen; a new request starts at "once".
  const [shownId, setShownId] = useState<string | null>(null);
  if ((current?.id ?? null) !== shownId) {
    setShownId(current?.id ?? null);
    setScope("once");
    setError(null);
  }

  // "Review request": bring that request forward even if it was put off; when the server no
  // longer lists it as pending, say so instead of showing anything.
  const [handledRequest, setHandledRequest] = useState<number | null>(null);
  /** A requested id the stream has not delivered (an action just raised it): looked up over REST. */
  const [lookup, setLookup] = useState<string | null>(null);
  const show = (id: string) => {
    setDeferred((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setFocusId(id);
    setMissing(false);
  };
  if (requestedApproval && requestedApproval.at !== handledRequest) {
    setHandledRequest(requestedApproval.at);
    if (approvals.some((approval) => approval.id === requestedApproval.id)) show(requestedApproval.id);
    else setLookup(requestedApproval.id);
  }
  useEffect(() => {
    if (!lookup) return;
    const controller = new AbortController();
    portalJson<{ approvals: Approval[] }>("/api/portal/approvals?status=pending", { signal: controller.signal })
      .then(({ approvals: fresh }) => {
        setApprovals(() => fresh);
        if (fresh.some((approval) => approval.id === lookup)) {
          setDeferred((prev) => {
            if (!prev.has(lookup)) return prev;
            const next = new Set(prev);
            next.delete(lookup);
            return next;
          });
          setFocusId(lookup);
        } else setMissing(true);
        setLookup(null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setMissing(true);
        setLookup(null);
      });
    return () => controller.abort();
  }, [lookup, setApprovals]);

  const decide = async (approve: boolean) => {
    if (!current) return;
    setPending(approve ? "approve" : "deny");
    setError(null);
    const body: ApprovalDecision = approve ? { approve, scope } : { approve };
    try {
      await portalSend<{ approval: Approval }>(
        `/api/portal/approvals/${encodeURIComponent(current.id)}/decide`,
        "POST",
        body,
        "Could not record the decision.",
      );
      setApprovals((list) => list.filter((approval) => approval.id !== current.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the decision.");
    } finally {
      setPending(null);
    }
  };

  const later = () => {
    if (current) setDeferred((prev) => new Set(prev).add(current.id));
  };

  if (missing)
    return (
      <Dialog open onOpenChange={(open) => !open && setMissing(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>Nothing to approve</DialogTitle>
          <DialogDescription>That request is no longer waiting: it was decided, cancelled, or it expired.</DialogDescription>
          <Button type="button" variant="secondary" onClick={() => setMissing(false)}>
            OK
          </Button>
        </DialogContent>
      </Dialog>
    );
  if (!current) return null;

  const expired = current.expiresAt <= now;
  const risk = riskMeta[current.risk] ?? riskMeta.write;
  const threadTitle =
    current.threadId === null
      ? null
      : current.threadId === MAIN_THREAD_ID
        ? "Main thread"
        : threads.find((thread) => thread.id === current.threadId)?.title ?? "Side thread";
  const go = (path: string) => {
    later();
    onNavigate(path);
  };
  const choices = scopeChoices(current);
  return (
    <Dialog open onOpenChange={(open) => !open && later()}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        // Focus the dialog itself, not its first button: a stray Enter must never decide.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        aria-describedby={undefined}
        className="flex max-h-[min(90dvh,760px)] flex-col gap-0 overflow-hidden p-0 ring-amber-300/30 sm:max-w-xl"
      >
        <div className="flex items-center gap-2 border-b border-white/8 bg-amber-300/[.07] px-5 py-3">
          <ShieldAlert className="size-4 text-amber-300" />
          <p className="flex-1 text-xs font-medium text-amber-100">Portal needs your approval</p>
          {waiting.length > 1 && (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Previous request" disabled={index <= 0} onClick={() => setFocusId(waiting[index - 1].id)}>
                <ChevronLeft />
              </Button>
              <span>
                {index + 1} of {waiting.length}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Next request"
                disabled={index >= waiting.length - 1}
                onClick={() => setFocusId(waiting[index + 1].id)}
              >
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <DialogTitle className="text-[15px] leading-snug">{current.title}</DialogTitle>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={risk.tone}>{risk.label}</Badge>
              <code className="rounded bg-white/8 px-1.5 font-mono text-[11px] leading-4">{current.tool}</code>
              <span className="text-[11px] text-muted-foreground">{originLabels[current.origin]}</span>
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">What will happen</p>
            <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3" data-testid="approval-summary">
              <PortalMarkdown text={current.summary} compact />
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {current.repo && (
              <>
                <dt className="text-muted-foreground">Repository</dt>
                <dd className="font-mono text-[11px]">{current.repo}</dd>
              </>
            )}
            {threadTitle && (
              <>
                <dt className="text-muted-foreground">Thread</dt>
                <dd>
                  <button type="button" className="hover:underline" onClick={() => go(portalPath({ view: "chat", threadId: current.threadId! }))}>
                    {threadTitle}
                  </button>
                </dd>
              </>
            )}
            {(current.jobId || current.intentId) && (
              <>
                <dt className="text-muted-foreground">{current.intentId ? "Goal" : "Job"}</dt>
                <dd>
                  <button type="button" className="hover:underline" onClick={() => go(portalPath("goals"))}>
                    View in Goals
                  </button>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Requested</dt>
            <dd>
              <When at={current.requestedAt} now={now} past />
            </dd>
            <dt className="text-muted-foreground">Expires</dt>
            <dd className={expired ? "text-destructive" : current.expiresAt - now < 5 * 60_000 ? "text-amber-200" : ""}>
              {expired ? "Expired; it will not run" : <When at={current.expiresAt} now={now} />}
            </dd>
          </dl>
          <JsonBlock label="Recorded input (exactly what runs)" value={current.input} />
          {!expired && (
            <fieldset>
              <legend className="mb-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">If approved</legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {choices.map((choice) => (
                  <label
                    key={choice.scope}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 text-xs transition-colors ${
                      scope === choice.scope ? "border-foreground/30 bg-white/6" : "border-white/8 hover:bg-white/[.03]"
                    }`}
                  >
                    <input
                      type="radio"
                      name={scopeName}
                      value={choice.scope}
                      checked={scope === choice.scope}
                      onChange={() => setScope(choice.scope)}
                      className="mt-0.5 accent-[var(--primary)]"
                    />
                    <span>
                      <span className="block font-medium">{choice.label}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">{choice.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-white/8 px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={later} className="text-xs text-muted-foreground">
            Decide later
          </Button>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={pending !== null} onClick={() => void decide(false)}>
              {pending === "deny" && <LoaderCircle className="animate-spin" />}
              Deny
            </Button>
            <Button type="button" size="sm" disabled={pending !== null || expired} onClick={() => void decide(true)}>
              {pending === "approve" && <LoaderCircle className="animate-spin" />}
              {approveLabel(current, scope)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
