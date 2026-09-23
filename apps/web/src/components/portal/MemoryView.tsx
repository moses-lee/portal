"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  History,
  Inbox,
  LoaderCircle,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import PortalMarkdown from "../PortalMarkdown";
import type { PortalLinks } from "../PortalPage";
import ResponsiveDialog from "../ResponsiveDialog";
import { useMediaQuery } from "../useMediaQuery";
import { At, Badge, Empty, ErrorLine, Loading, SectionTitle, When, type Tone } from "./bits";
import { usePortalEvents, usePortalLive, useNow } from "./PortalLive";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { portalJson, portalSend, query } from "@/lib/orchestrator/api";
import { authorityLabels, canPin, entityTypeLabels, groupEntities, lineage, partitionRecords } from "@/lib/orchestrator/memory";
import {
  entityTypes,
  recordTypes,
  type EntityType,
  type MemoryEntity,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemoryRevision,
  type RecordStatus,
  type RecordType,
} from "@/lib/orchestrator/types";

const statusTone: Record<RecordStatus, Tone> = {
  active: "emerald",
  proposed: "amber",
  superseded: "neutral",
  expired: "neutral",
  archived: "neutral",
  rejected: "rose",
};

const sourceLabels: Record<MemoryRecord["source"]["kind"], string> = {
  message: "From a message",
  session: "From a session",
  pull: "From a pull request",
  import: "Imported",
  tool: "From a tool result",
  consolidator: "From curation",
  ui: "Added in Portal",
};

const revisionLabels: Record<MemoryRevision["action"], string> = {
  created: "Created",
  updated: "Updated",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
  expired: "Expired",
  archived: "Archived",
  forgotten: "Forgotten",
  restored: "Restored",
  imported: "Imported",
  summarized: "Summary rewritten",
};

const recordPath = (id: string) => `/api/portal/memory/records/${encodeURIComponent(id)}`;

/** A record's revisions, oldest first, with what changed in each. */
function Revisions({ record, now }: { record: MemoryRecord; now: number }) {
  const [revisions, setRevisions] = useState<MemoryRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ revisions: MemoryRevision[] }>(`/api/portal/memory/revisions${query({ recordId: record.id })}`, { signal: controller.signal })
      .then(({ revisions }) => setRevisions([...revisions].sort((a, b) => a.at - b.at || a.id - b.id)))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the revisions.");
      });
    return () => controller.abort();
  }, [record.id, record.updatedAt]);
  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!revisions) return <Loading>Loading revisions…</Loading>;
  if (revisions.length === 0) return <p className="text-xs text-muted-foreground">No revisions recorded.</p>;
  return (
    <ol aria-label={`Revisions of ${record.key}`} className="relative space-y-3 border-l border-white/10 pl-4">
      {revisions.map((revision) => {
        const bodyChanged = revision.before && revision.after && revision.before.body !== revision.after.body;
        const statusChanged = revision.before && revision.after && revision.before.status !== revision.after.status;
        return (
          <li key={revision.id} className="relative text-xs">
            <span className="absolute top-1 -left-[21px] size-2 rounded-full bg-white/30" aria-hidden="true" />
            <p>
              <span className="font-medium">{revisionLabels[revision.action] ?? revision.action}</span>
              <span className="text-muted-foreground">
                {" "}
                by {revision.actor} · <When at={revision.at} now={now} past />
              </span>
            </p>
            {revision.reason && <p className="mt-0.5 text-muted-foreground">“{revision.reason}”</p>}
            {statusChanged && (
              <p className="mt-0.5 text-muted-foreground">
                {revision.before!.status} → {revision.after!.status}
              </p>
            )}
            {bodyChanged && (
              <div className="mt-1 space-y-1 rounded-lg bg-black/20 p-2 text-[11px] leading-relaxed">
                <p className="text-rose-300/80 line-through decoration-rose-300/40">{revision.before!.body}</p>
                <p className="text-emerald-300/90">{revision.after!.body}</p>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Where a claim came from: the kind, the words it rests on, and a link back when there is one. */
function Source({ record, links }: { record: MemoryRecord; links: PortalLinks }) {
  const { source } = record;
  const url = source.url ?? source.pull?.url;
  return (
    <div className="mt-2.5 rounded-lg bg-black/15 px-3 py-2 text-[11px] leading-relaxed">
      <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <span>{sourceLabels[source.kind] ?? source.kind}</span>
        {source.pull && (
          <span>
            · {source.pull.repo}#{source.pull.number}
          </span>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground hover:underline">
            Open <ExternalLink className="size-2.5" />
          </a>
        )}
        {source.threadId && (
          <button type="button" onClick={() => links.openThread(source.threadId!)} className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground hover:underline">
            <MessagesSquare className="size-3" /> Thread
          </button>
        )}
        {source.sessionId && (
          <button type="button" onClick={() => links.openSession(source.sessionId!)} className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground hover:underline">
            <SquareTerminal className="size-3" /> Session
          </button>
        )}
      </p>
      {source.quote && (
        <blockquote className="mt-1 border-l-2 border-white/15 pl-2 text-foreground/75 italic">{source.quote}</blockquote>
      )}
    </div>
  );
}

function RecordCard({
  record,
  byId,
  entityName,
  now,
  links,
  onChanged,
}: {
  record: MemoryRecord;
  /** Every record known alongside this one, for its lineage. */
  byId: ReadonlyMap<string, MemoryRecord>;
  /** Shown in the inbox, where records from every entity sit together. */
  entityName?: string;
  now: number;
  links: PortalLinks;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "forget" | "reject">("view");
  const [text, setText] = useState(record.body);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRevisions, setShowRevisions] = useState(false);
  const act = async (name: string, action: () => Promise<unknown>) => {
    setPending(name);
    setError(null);
    try {
      await action();
      setMode("view");
      setReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setPending(null);
    }
  };
  const chain = lineage(record, byId);
  const active = record.status === "active";
  const proposed = record.status === "proposed";
  const pinnable = canPin(record);
  const overdue = record.reviewBy !== null && record.reviewBy < now;
  return (
    <article
      aria-label={`${record.key}: ${record.body.slice(0, 80)}`}
      data-status={record.status}
      className={`rounded-2xl border border-white/8 bg-white/[.025] p-4 text-[13px] ${active || proposed ? "" : "opacity-70"}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {record.pinned && <Pin className="size-3.5 text-amber-200" aria-label="Pinned into CORE.md" />}
        <code className="font-mono text-[12px] text-foreground/90">{record.key}</code>
        <Badge>{record.type}</Badge>
        {!active && <Badge tone={statusTone[record.status]}>{record.status}</Badge>}
        <Badge tone={pinnable ? "violet" : "neutral"}>{authorityLabels[record.authority]}</Badge>
        <span className="text-[11px] text-muted-foreground" title="How far Portal relies on it">
          trust {Math.round(record.trust * 100)}%
        </span>
        {entityName && <span className="ml-auto text-[11px] text-muted-foreground">{entityName}</span>}
      </div>

      {mode === "edit" ? (
        <form
          className="mt-2.5 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const body = text.trim();
            if (!body || body === record.body) return setMode("view");
            void act("edit", () => portalSend(recordPath(record.id), "PATCH", { body }));
          }}
        >
          <Textarea
            aria-label={`Edit ${record.key}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="text-[13px] md:text-[13px]"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            Saving keeps the current record in history and replaces it with your wording.
          </p>
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" variant="secondary" disabled={pending !== null}>
              {pending === "edit" && <LoaderCircle className="animate-spin" />}
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 text-foreground/90">
          <PortalMarkdown text={record.body} compact />
        </div>
      )}

      <Source record={record} links={links} />

      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          updated <At at={record.updatedAt} now={now} />
        </span>
        {record.reviewBy !== null && (
          <span className={overdue ? "text-amber-200" : ""}>
            · {overdue ? "review overdue since" : "review by"} <At at={record.reviewBy} now={now} />
          </span>
        )}
      </p>

      {chain.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]" aria-label="Lineage">
          <History className="size-3 text-muted-foreground" />
          <span className="text-muted-foreground">Lineage:</span>
          {chain.map((version, index) => (
            <span key={version.id} className="flex items-center gap-1">
              {index > 0 && <span className="text-muted-foreground">→</span>}
              <span
                title={version.body}
                className={`rounded-full px-1.5 leading-4 ${version.id === record.id ? "bg-white/12 text-foreground" : "bg-white/5 text-muted-foreground"}`}
              >
                {version.id === record.id ? "this" : version.status}
                <span className="sr-only"> ({version.body})</span>
              </span>
            </span>
          ))}
        </div>
      )}

      {mode === "forget" || mode === "reject" ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const body = reason.trim() ? { reason: reason.trim() } : {};
            void act(mode, () => portalSend(`${recordPath(record.id)}/${mode}`, "POST", body));
          }}
        >
          <Input
            aria-label={mode === "forget" ? "Why forget it (optional)" : "Why reject it (optional)"}
            placeholder={mode === "forget" ? "Why forget it? (optional)" : "Why reject it? (optional)"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-7 min-w-0 flex-1 text-xs md:text-xs"
            autoFocus
          />
          <Button type="submit" size="sm" variant="destructive" disabled={pending !== null}>
            {pending && <LoaderCircle className="animate-spin" />}
            {mode === "forget" ? "Forget" : "Reject"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </form>
      ) : (
        mode === "view" && (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {proposed && (
              <>
                <Button type="button" size="xs" variant="secondary" disabled={pending !== null} onClick={() => void act("approve", () => portalSend(`${recordPath(record.id)}/approve`, "POST"))}>
                  {pending === "approve" ? <LoaderCircle className="animate-spin" /> : <Check />}
                  Approve
                </Button>
                <Button type="button" size="xs" variant="ghost" disabled={pending !== null} onClick={() => setMode("reject")} className="text-muted-foreground">
                  <X />
                  Reject
                </Button>
              </>
            )}
            {active && (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setText(record.body);
                    setMode("edit");
                  }}
                  className="text-muted-foreground"
                >
                  <Pencil />
                  Edit
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={pending !== null || (!pinnable && !record.pinned)}
                  title={pinnable || record.pinned ? undefined : "Only what you said or confirmed can be pinned into CORE.md"}
                  onClick={() => void act("pin", () => portalSend(recordPath(record.id), "PATCH", { pinned: !record.pinned }))}
                  className="text-muted-foreground"
                >
                  {record.pinned ? <PinOff /> : <Pin />}
                  {record.pinned ? "Unpin" : "Pin"}
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setMode("forget")} className="text-muted-foreground">
                  <Trash2 />
                  Forget
                </Button>
              </>
            )}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={showRevisions}
              onClick={() => setShowRevisions((open) => !open)}
              className="text-muted-foreground"
            >
              <History />
              Revisions
            </Button>
          </div>
        )
      )}
      <ErrorLine>{error}</ErrorLine>
      {showRevisions && (
        <div className="mt-3">
          <Revisions record={record} now={now} />
        </div>
      )}
    </article>
  );
}

/** The add-record form: the user's own statement, so it applies at once. */
function AddRecordDialog({
  open,
  onOpenChange,
  entity,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefills the entity when one is selected. */
  entity: MemoryEntity | null;
  onAdded: (record: MemoryRecord) => void;
}) {
  const id = useId();
  const [entityType, setEntityType] = useState<EntityType>(entity?.type ?? "global");
  const [entityKey, setEntityKey] = useState(entity?.key ?? "global");
  const [type, setType] = useState<RecordType>("preference");
  const [key, setKey] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [reviewBy, setReviewBy] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setEntityType(entity?.type ?? "global");
      setEntityKey(entity?.key ?? "global");
      setType("preference");
      setKey("");
      setBody("");
      setPinned(false);
      setReviewBy("");
      setError(null);
    }
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input: MemoryRecordInput = {
      entity: { type: entityType, key: entityType === "global" ? "global" : entityKey.trim() },
      type,
      key: key.trim(),
      body: body.trim(),
      pinned,
      reviewBy: reviewBy ? new Date(`${reviewBy}T09:00`).getTime() : null,
      source: { kind: "ui" },
    };
    if (!input.entity.key || !input.key || !input.body) {
      setError("Fill in the entity, a key, and what Portal should remember.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { record } = await portalSend<{ record: MemoryRecord }>("/api/portal/memory/records", "POST", input);
      onAdded(record);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the record.");
    } finally {
      setPending(false);
    }
  };
  const keyPlaceholder: Record<EntityType, string> = {
    global: "global",
    person: "GitHub login",
    repo: "owner/name",
    project: "Portal project id",
    session: "Portal session id",
    task_type: "code-review",
  };
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Add to memory" description="Something you state applies at once, with you as its source.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4 pb-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-etype`} className="text-xs font-medium">About</label>
            <Select value={entityType} onValueChange={(value) => setEntityType(value as EntityType)}>
              <SelectTrigger id={`${id}-etype`} className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entityTypes.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entityTypeLabels[entry]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-ekey`} className="text-xs font-medium">Which</label>
            <Input
              id={`${id}-ekey`}
              value={entityType === "global" ? "global" : entityKey}
              disabled={entityType === "global"}
              onChange={(e) => setEntityKey(e.target.value)}
              placeholder={keyPlaceholder[entityType]}
              className="text-xs md:text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-type`} className="text-xs font-medium">Kind</label>
            <Select value={type} onValueChange={(value) => setType(value as RecordType)}>
              <SelectTrigger id={`${id}-type`} className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {recordTypes.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-key`} className="text-xs font-medium">Key</label>
            <Input id={`${id}-key`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="review-style" className="font-mono text-xs md:text-xs" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-body`} className="text-xs font-medium">What to remember</label>
          <Textarea id={`${id}-body`} rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="One claim, in your words." className="text-[13px] md:text-[13px]" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-2.5">
            <Switch id={`${id}-pin`} checked={pinned} onCheckedChange={setPinned} />
            <label htmlFor={`${id}-pin`} className="text-xs">Pin into CORE.md</label>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-review`} className="text-xs font-medium">Review by (optional)</label>
            <Input id={`${id}-review`} type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} className="text-xs md:text-xs" />
          </div>
        </div>
        <ErrorLine>{error}</ErrorLine>
        <Button type="submit" variant="secondary" className="w-full" disabled={pending}>
          {pending && <LoaderCircle className="animate-spin" />}
          Add record
        </Button>
      </form>
    </ResponsiveDialog>
  );
}

/** The records of one partition, or nothing when it is empty. */
function RecordList({
  label,
  records,
  byId,
  now,
  links,
  onChanged,
  collapsed = false,
}: {
  label: string;
  records: MemoryRecord[];
  byId: ReadonlyMap<string, MemoryRecord>;
  now: number;
  links: PortalLinks;
  onChanged: () => void;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  if (records.length === 0) return null;
  return (
    <section aria-label={`${label} (${records.length})`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground">
          {label} <span className="font-normal">{records.length}</span>
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2.5">
            {records.map((record) => (
              <RecordCard key={record.id} record={record} byId={byId} now={now} links={links} onChanged={onChanged} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * The memory browser: entities grouped by type (with their active-record counts), one entity's
 * records with provenance, lineage, and revisions, and the inbox of proposed records to approve or
 * reject. Edits supersede (the old record stays in history); forgetting archives with a reason.
 * Everything refetches on `memory` events.
 */
export default function MemoryView({
  entityId,
  onSelectEntity,
  links,
}: {
  /** From the URL; null shows the inbox. */
  entityId: string | null;
  onSelectEntity: (entityId: string | null) => void;
  links: PortalLinks;
}) {
  const { status } = usePortalLive();
  const now = useNow(60_000);
  const [entities, setEntities] = useState<MemoryEntity[] | null>(null);
  const [entitiesError, setEntitiesError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ entity: MemoryEntity; records: MemoryRecord[] } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [inbox, setInbox] = useState<MemoryRecord[] | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);
  const wide = useMediaQuery("(min-width: 768px)", true);

  usePortalEvents((event) => {
    if (event.type === "memory" || event.type === "reconnected") refresh();
  });

  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ entities: MemoryEntity[] }>("/api/portal/memory/entities", { signal: controller.signal })
      .then(({ entities }) => {
        setEntities(entities);
        setEntitiesError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setEntitiesError(e instanceof Error ? e.message : "Could not load memory.");
      });
    return () => controller.abort();
  }, [version]);

  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ records: MemoryRecord[] }>(`/api/portal/memory/records${query({ status: "proposed" })}`, { signal: controller.signal })
      .then(({ records }) => {
        setInbox(records);
        setInboxError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setInboxError(e instanceof Error ? e.message : "Could not load the inbox.");
      });
    return () => controller.abort();
  }, [version]);

  useEffect(() => {
    if (!entityId) return;
    const controller = new AbortController();
    portalJson<{ entity: MemoryEntity; records: MemoryRecord[] }>(`/api/portal/memory/entities/${encodeURIComponent(entityId)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        setDetail(result);
        setDetailError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setDetailError(e instanceof Error ? e.message : "Could not load that entity.");
      });
    return () => controller.abort();
  }, [entityId, version]);

  const groups = useMemo(() => groupEntities(entities ?? []), [entities]);
  const entityNames = useMemo(() => new Map((entities ?? []).map((entity) => [entity.id, entity.name])), [entities]);
  const shown = detail && detail.entity.id === entityId ? detail : null;
  const parts = useMemo(() => partitionRecords(shown?.records ?? []), [shown]);
  const byId = useMemo(() => new Map((shown?.records ?? []).map((record) => [record.id, record])), [shown]);
  const inboxById = useMemo(() => new Map((inbox ?? []).map((record) => [record.id, record])), [inbox]);
  const inboxCount = inbox?.length ?? status?.counts.inbox ?? 0;

  const nav = (
    <nav aria-label="Memory" className="space-y-4">
      <div className="space-y-0.5">
        <button
          type="button"
          aria-current={entityId === null ? "page" : undefined}
          onClick={() => onSelectEntity(null)}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${entityId === null ? "bg-white/8" : "hover:bg-white/5"}`}
        >
          <Inbox className={`size-3.5 ${inboxCount ? "text-amber-300" : "text-muted-foreground"}`} />
          <span className="flex-1">Inbox</span>
          <span className="text-[11px] text-muted-foreground">{inboxCount}</span>
        </button>
      </div>
      <ErrorLine>{entitiesError}</ErrorLine>
      {!entities && !entitiesError && <Loading>Loading…</Loading>}
      {groups.map((group) => (
        <div key={group.type} role="group" aria-label={group.label}>
          <p aria-hidden="true" className="mb-1 flex items-center px-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            <span className="flex-1">{group.label}</span>
            <span>{group.records}</span>
          </p>
          <ul className="space-y-0.5">
            {group.entities.map((entity) => (
              <li key={entity.id}>
                <button
                  type="button"
                  aria-current={entity.id === entityId ? "page" : undefined}
                  onClick={() => onSelectEntity(entity.id)}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${entity.id === entityId ? "bg-white/8" : "hover:bg-white/5"}`}
                >
                  <span className="min-w-0 flex-1 truncate">{entity.name}</span>
                  <span className="text-[11px] text-muted-foreground">{entity.activeRecords}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {entities && entities.length === 0 && <p className="px-2 text-xs text-muted-foreground">Portal remembers nothing yet.</p>}
    </nav>
  );

  const pane =
    entityId === null ? (
      <section aria-labelledby="memory-inbox">
        <SectionTitle id="memory-inbox" count={inbox?.length}>
          Inbox
        </SectionTitle>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          What Portal observed or inferred waits here until you approve it. Only approved records
          shape what it does.
        </p>
        <ErrorLine>{inboxError}</ErrorLine>
        {!inbox && !inboxError && <Loading>Loading the inbox…</Loading>}
        {inbox && inbox.length === 0 && <Empty>Nothing waiting for review.</Empty>}
        <div className="space-y-2.5">
          {inbox?.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              byId={inboxById}
              entityName={entityNames.get(record.entityId)}
              now={now}
              links={links}
              onChanged={refresh}
            />
          ))}
        </div>
      </section>
    ) : (
      <section aria-label={shown?.entity.name ?? "Entity"} className="space-y-5">
        <ErrorLine>{detailError}</ErrorLine>
        {!shown && !detailError && <Loading>Loading records…</Loading>}
        {shown && (
          <>
            <div>
              <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                {entityTypeLabels[shown.entity.type]} · <span className="font-mono normal-case">{shown.entity.key}</span>
              </p>
              <h2 className="mt-0.5 text-lg font-medium tracking-tight">{shown.entity.name}</h2>
              {shown.entity.summary && (
                <div className="mt-2 text-foreground/80">
                  <PortalMarkdown text={shown.entity.summary} compact />
                </div>
              )}
            </div>
            {shown.records.length === 0 && <Empty>No records about {shown.entity.name}.</Empty>}
            <RecordList label="In force" records={parts.active} byId={byId} now={now} links={links} onChanged={refresh} />
            <RecordList label="Waiting for review" records={parts.proposed} byId={byId} now={now} links={links} onChanged={refresh} />
            <RecordList label="History" records={parts.history} byId={byId} now={now} links={links} onChanged={refresh} collapsed />
          </>
        )}
      </section>
    );

  const addButton = (
    <Button type="button" variant="secondary" size="sm" className="mb-4 w-full text-xs" onClick={() => setAdding(true)}>
      <Plus />
      Add record
    </Button>
  );
  return (
    <div className="flex min-h-0 flex-1" role="region" aria-label="Memory browser">
      {wide ? (
        <>
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-white/5 p-3">
            {addButton}
            {nav}
          </aside>
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[820px] px-6 py-6 pb-16">{pane}</div>
          </div>
        </>
      ) : (
        // Narrow screens: the list with the inbox under it, or one entity with a way back.
        <div className="min-w-0 flex-1 overflow-y-auto px-3 py-4 pb-16">
          {entityId === null ? (
            <>
              {addButton}
              {nav}
              <div className="mt-6">{pane}</div>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => onSelectEntity(null)} className="-ml-2 mb-3 text-xs text-muted-foreground">
                <ArrowLeft />
                Memory
              </Button>
              {pane}
            </>
          )}
        </div>
      )}
      <AddRecordDialog
        open={adding}
        onOpenChange={setAdding}
        entity={shown?.entity ?? null}
        onAdded={(record) => {
          refresh();
          if (record.entityId !== entityId) onSelectEntity(record.entityId);
        }}
      />
    </div>
  );
}
