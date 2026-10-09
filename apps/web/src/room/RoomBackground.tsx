"use client";

import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { AgentActivity } from "@/lib/agent-activity";
import { usePortalEvents, usePortalLive } from "@/components/portal/PortalLive";
import { useSessions } from "@/components/SessionsProvider";
import { useMediaQuery } from "@/components/useMediaQuery";
import { useWorkspaceActions } from "@/components/workspace/useWorkspaceActions";
import { pushPath } from "@/lib/navigation";
import { isPortalPath, portalPath, portalPathKeepingPanel, type PortalView } from "@/lib/session-routes";
import type { RoomCensus } from "@portal/contracts/room";
import { LAYOUT_VERSION, latitudeForTimeZone } from "@portal/shared/room";
import {
  bookList,
  describeGrowth,
  FRAME_CAP,
  frameList,
  GALLERY_CAP,
  growthSummary,
  isGrowthKind,
  KEY_CAP,
  noteCount,
  plantList,
  reachedSet,
  shelfCount,
  SILL_CAP,
  STAND_CAP,
  treeSpec,
  type GrowthData,
  type GrowthScene,
} from "./growth";
import { useRoomHost } from "./host";
import { CAMERA_VERSION, readLayout, registerStage, subscribeLayout } from "./layout";
import {
  backgroundRuns,
  describeObject,
  hearthLevel,
  lampState,
  liveSummary,
  mailStack,
  placeRobots,
  type RoomLiveData,
  type RoomTarget,
} from "./live";
import { requestRoomFrame } from "./loop";
import { hideCard, pinCard, startRoomPointer, waveRobot, WAVE_MS } from "./pointer";
import { onRoomReport, readRoomReport } from "./report";
import type { RoomLiveScene } from "./RoomCanvas";
// The extension is explicit: on a case-insensitive disk "./Sketch" could resolve to sketch.ts.
import Sketch, { skipSketchDrawIn } from "./Sketch.tsx";
import { peekSnapshot, snapshotEligibility, snapshotRead, SNAPSHOT_READ_WAIT_MS, type SnapshotRecord } from "./snapshot.ts";
import SnapshotImage from "./SnapshotImage";
import { sceneForAltitude, skyColours } from "./sun";
import { useRoomState, useSunClock } from "./useRoomState";

/**
 * The WebGL room's chunk (three.js and the scene). Named once so the background can start the
 * download as it mounts, before the canvas does: the bundler's module cache makes this and
 * `next/dynamic`'s call the same request and the same module, evaluated once.
 */
const loadRoomCanvas = () => import("./RoomCanvas");
/** The WebGL room loads on the client only, in its own chunk: three.js stays off the first paint. */
const RoomCanvas = dynamic(loadRoomCanvas, { ssr: false });
/** The hover card shows only over the canvas: it loads with it. */
const RoomHoverCard = dynamic(() => import("./RoomHoverCard"), { ssr: false });

let webglSupport: boolean | null = null;

/**
 * Whether this browser can open a WebGL 2 context, the only kind three.js still creates (a WebGL
 * 1-only browser gets the sketch); asked once, the probe context released at once.
 */
function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    webglSupport = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

const subscribeNever = () => () => {};
const hydratedOnClient = () => true;
const notOnServer = () => false;

/** Catches whatever the canvas throws (no context could be created, a scene error) and hands over to the sketch. */
class CanvasBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("The room's canvas failed; showing the sketch instead.", error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Set once the page has had its first idle moment; later mounts (another view) draw at once. */
let settled = false;
/** The longest the canvas waits for that idle moment (its chunk is already loading meanwhile). */
const SETTLE_MS = 800;
/** The canvas's fade-in over the placeholder (`globals.css`); the placeholder goes after it. */
const FADE_MS = 600;

/**
 * Whether the page has settled enough to start the canvas: its first frame compiles shaders, which
 * should not compete with the app's own first render and first clicks.
 */
function useSettled(): boolean {
  const [ready, setReady] = useState(settled);
  useEffect(() => {
    if (ready) return;
    const done = () => {
      settled = true;
      setReady(true);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(done, { timeout: SETTLE_MS });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(done, 300);
    return () => clearTimeout(timer);
  }, [ready]);
  return ready;
}

/** `value`, keeping the previous identity while it is equal as JSON: the canvas is memoised on it. */
function useSettledValue<T>(value: T): T {
  const [settledValue, setSettledValue] = useState(value);
  if (settledValue !== value && JSON.stringify(settledValue) !== JSON.stringify(value)) {
    setSettledValue(value);
    return value;
  }
  return settledValue;
}

/**
 * The page load's choice of placeholder (docs/PALACE.md, The snapshot): undefined until made, then
 * the eligible snapshot or null for the sketch. Made once per page load, so a background mounted
 * later keeps it.
 */
let pageChoice: SnapshotRecord | null | undefined;
/** The snapshot has stood in once (the canvas drew and faded in over it) or cannot (a lost context, a failure): only the sketch from now on. */
let snapshotSpent = false;

/** The viewport's aspect from the layout registry's measure; 0 before the first. */
function readAspect(): number {
  const { width, height } = readLayout();
  return width > 0 && height > 0 ? width / height : 0;
}
const noAspect = () => 0;

/**
 * The snapshot to show before the room draws, or null for the sketch; undefined while it is still
 * being chosen. Chosen once the page has hydrated, the layout registry has its first measure and
 * the read has answered; a read that has not answered `SNAPSHOT_READ_WAIT_MS` after hydration
 * means the sketch, and its later answer is not used. The registry is read only until the choice
 * is made, so the background does not re-render with every layout change after it. The scene the
 * record is checked against is worked out over the record's own coordinates (`snapshotEligibility`),
 * not taken from this page's sun clock, which starts from the browser zone's guess.
 */
function useSnapshotChoice(hydrated: boolean): SnapshotRecord | null | undefined {
  /** The read's answer and when it came (the record's age is taken then). */
  const [answer, setAnswer] = useState<{ record: SnapshotRecord | null; at: number } | undefined>(() => {
    const record = pageChoice === undefined ? peekSnapshot() : null;
    return record === undefined ? undefined : { record, at: Date.now() };
  });
  const [choice, setChoice] = useState<SnapshotRecord | null | undefined>(() => (snapshotSpent ? null : pageChoice));
  const choosing = choice === undefined;
  const aspect = useSyncExternalStore(choosing ? subscribeLayout : subscribeNever, choosing ? readAspect : noAspect, noAspect);
  const waiting = hydrated && answer === undefined;
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const timer = setTimeout(() => {
      if (live) setAnswer((current) => current ?? { record: null, at: Date.now() });
    }, SNAPSHOT_READ_WAIT_MS);
    void snapshotRead().then((record) => {
      if (live) setAnswer((current) => current ?? { record, at: Date.now() });
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waiting]);
  if (choosing && hydrated && answer !== undefined && aspect > 0) {
    const { record, at } = answer;
    const eligible = record !== null && snapshotEligibility(record, { layoutVersion: LAYOUT_VERSION, cameraVersion: CAMERA_VERSION, at, aspect }) === "eligible";
    setChoice(eligible ? record : null);
  }
  useEffect(() => {
    if (choice !== undefined && pageChoice === undefined) pageChoice = choice;
    // The room has been seen: a sketch that follows the snapshot appears complete, without the draw-in.
    if (choice) skipSketchDrawIn();
  }, [choice]);
  return choice;
}

/** The census before the room's state arrives: nothing counted yet. */
const NO_CENSUS: RoomCensus = { sessionsEver: 0, memoryActive: 0, memoryInbox: 0, watches: { active: 0, finished: 0, fires: 0, ever: 0 }, grants: 0, activityLastHour: 0, since: null };

/** The browser's time zone's latitude: the hemisphere for the tree's seasons when the room has no location. */
function zoneLatitude(): number {
  try {
    return latitudeForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)?.latitude ?? 0;
  } catch {
    return 0;
  }
}

/** The Portal view a room object opens: the tracked panel's session comes along on Portal pages. */
function openView(view: PortalView) {
  pushPath(isPortalPath(window.location.pathname) ? portalPathKeepingPanel(view, window.location.search) : portalPath(view));
}

/**
 * The room behind every Portal view and the workspace (docs/PALACE.md): the 3D canvas when the
 * browser can draw it, over a placeholder until its first frame is drawn (the last frame drawn on
 * the previous visit, `snapshot.ts`, or the pencil sketch, `Sketch.tsx`); the sketch alone without
 * WebGL, after a lost context or a canvas failure, and under `prefers-reduced-transparency`; one
 * veil over either. It follows the real sun at the room's
 * location, never a setting. The live objects follow the session list, the portal stream's status
 * and the census; the accumulated ones (books, notes, plants, frames, keys, the tree) the census,
 * the session and project lists and the active watches, and the milestones mount their furniture;
 * with the canvas up, a document-level pointer listener (`pointer.ts`) shows their hover cards and
 * clicks through. `palace` is the Palace page, where a clicked robot waves first.
 * The fixed `.room-scene` element carries what tests and CSS read: `data-scene` (day or night,
 * from the sun's altitude), `data-activity`, `data-renderer` (`webgl` while the canvas is up or
 * coming), `data-placeholder` (what is under the canvas: `snapshot` at the start of a visit when
 * one is eligible, else `sketch`; nothing before hydration, while that is chosen, and once the
 * canvas has drawn and faded in), `data-drawn` (the canvas has drawn a frame), and a `data-room`
 * JSON summary (the live and accumulated objects, and what the canvas reports: `drawn`, the
 * camera's pose and frame, the objects' screen points, and the milestone in the crate).
 */
export default function RoomBackground({ activity, palace = false }: { activity: AgentActivity; palace?: boolean }) {
  const room = useRoomState();
  const environment = room?.environment ?? null;
  const clock = useSunClock(environment);
  const webgl = useSyncExternalStore(subscribeNever, hasWebGL, () => false);
  const reducedTransparency = useMediaQuery("(prefers-reduced-transparency: reduce)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  /** The canvas failed for good (it threw): the sketch for the rest of the visit. */
  const [lost, setLost] = useState(false);
  /** The GPU took the context away; the canvas stays mounted, hidden, for the browser to give it back. */
  const [contextLost, setContextLost] = useState(false);
  /** A new canvas after a restored context: a fresh renderer, scene and frost pipeline. */
  const [canvasKey, setCanvasKey] = useState(0);
  const ready = useSettled();
  const hydrated = useSyncExternalStore(subscribeNever, hydratedOnClient, notOnServer);
  const renderer = webgl && !lost && !contextLost && !reducedTransparency ? "webgl" : "fallback";
  const weather = environment?.weather ?? null;
  const condition = weather?.condition ?? "clear";
  const scene = clock ? sceneForAltitude(clock.sun.altitude) : "pending";
  const sky = clock ? skyColours(clock.sun.altitude, condition) : null;
  const style = sky ? ({ "--room-sky-top": sky.zenith, "--room-sky-horizon": sky.horizon } as CSSProperties) : undefined;

  // The live objects (docs/PALACE.md, Objects).
  const { sessions, tracked } = useSessions();
  const { status, approvals, intents, requestApproval } = usePortalLive();
  const trackedIds = useMemo(() => new Set(tracked.map((entry) => entry.sessionId)), [tracked]);
  const crowd = useMemo(() => placeRobots(sessions, trackedIds), [sessions, trackedIds]);
  const busy = status?.busy ?? false;
  /** When Portal last stopped answering (the lamp goes off at night an hour after); the page load counts as a start. */
  const [idleSince, setIdleSince] = useState<number | null>(() => Date.now());
  usePortalEvents((event) => {
    if (event.type !== "status") return;
    if (event.status.busy) setIdleSince(null);
    else setIdleSince((current) => current ?? Date.now());
  });
  const now = clock?.at ?? 0;
  const data: RoomLiveData = {
    crowd,
    needsYou: status?.counts.needsYou ?? 0,
    approvals: Math.max(status?.counts.approvals ?? 0, approvals.length),
    activityLastHour: room?.census.activityLastHour ?? 0,
    runs: status?.runs ?? [],
    busy,
    lamp: lampState({ busy, night: scene === "night", idleSince: idleSince ?? now, now }),
    weather,
  };
  const live = useSettledValue<RoomLiveScene>({
    crowd: data.crowd,
    mail: mailStack(data.needsYou, data.approvals),
    hearth: hearthLevel(data.activityLastHour),
    lamp: data.lamp,
    kettle: backgroundRuns(data.runs).length > 0,
  });
  const dataRef = useRef(data);
  useLayoutEffect(() => {
    dataRef.current = data;
  });

  // The accumulated objects (docs/PALACE.md, Objects) and the milestones' furniture.
  const host = useRoomHost();
  const census = room?.census ?? NO_CENSUS;
  const milestones = room?.milestones ?? null;
  const reached = useMemo(() => reachedSet(milestones), [milestones]);
  const sessionsEver = room ? census.sessionsEver : sessions.length;
  const books = useMemo(() => bookList(sessions, host.projects, sessionsEver), [sessions, host.projects, sessionsEver]);
  const shelves = shelfCount(books.length, Math.max(0, sessionsEver - sessions.length), reached);
  const plants = useMemo(() => plantList(intents.filter((intent) => intent.status === "active")), [intents]);
  const frames = useMemo(() => frameList(host.projects), [host.projects]);
  const latitude = environment?.latitude ?? (clock ? zoneLatitude() : 0);
  const growth = useSettledValue<GrowthScene>({
    milestones,
    books: books.slice(0, shelves.drawn),
    notes: noteCount(census.memoryActive, census.memoryInbox),
    plants: { sill: plants.slice(0, SILL_CAP), stand: Math.min(census.watches.finished, STAND_CAP) },
    frames: frames.slice(0, FRAME_CAP + GALLERY_CAP),
    keys: Math.min(census.grants, KEY_CAP),
    tree: treeSpec(census.since, now, latitude),
  });
  const growthData: GrowthData = { scene: growth, census, shelves, books, plants, frames, approvals: approvals.length };
  const growthRef = useRef(growthData);
  useLayoutEffect(() => {
    growthRef.current = growthData;
  });
  const describe = useCallback(
    (target: RoomTarget) => (isGrowthKind(target.kind) ? describeGrowth({ kind: target.kind, id: target.id }, growthRef.current) : describeObject(target, dataRef.current)),
    [],
  );

  const { openSession } = useWorkspaceActions();
  const { openProject } = host;
  const approvalsRef = useRef(approvals);
  useLayoutEffect(() => {
    approvalsRef.current = approvals;
  });
  const open = useCallback(
    (target: RoomTarget) => {
      switch (target.kind) {
        case "robot":
          return void openSession(target.id);
        case "book":
          // A purged session's book goes nowhere: its card says so.
          if (!target.id.startsWith("purged:")) void openSession(target.id);
          return;
        case "mail":
          return openView("attention");
        case "hearth":
          return openView("activity");
        case "kettle":
          return openView("watches");
        case "lamp":
          return openView("chat");
        case "notes":
          return openView("memory");
        case "plant":
          return openView("watches");
        case "frame":
          return openProject(target.id);
        case "key": {
          // The approvals dialog shows pending requests only; with none waiting, the grants are listed in System.
          const pending = approvalsRef.current.find((approval) => approval.status === "pending");
          return pending ? requestApproval(pending.id) : openView("system");
        }
        default:
          return;
      }
    },
    [openSession, openProject, requestApproval],
  );
  const palaceRef = useRef(palace);
  useLayoutEffect(() => {
    palaceRef.current = palace;
  });
  /** The canvas will mount: its chunk starts loading now, not when the page has settled. */
  const coming = webgl && !lost && !reducedTransparency;
  useEffect(() => {
    // A failed download is the lazy component's to handle (the boundary, then the sketch), not an unhandled rejection.
    if (coming) loadRoomCanvas().catch(() => {});
  }, [coming]);
  /** The canvas has drawn a frame (its report's `drawn`): it fades in, and the placeholder goes after. */
  const [drawn, setDrawn] = useState(false);
  /** The canvas is mounted (also while its context is lost, waiting to be restored). */
  const mounted = coming && !!clock && ready;
  /**
   * The canvas is on screen: it has drawn (before that it is transparent, and no frame has updated
   * the objects' matrices for the raycast) and its context is not lost. Hover cards and clicks only then.
   */
  const drawing = mounted && !contextLost && drawn;
  useEffect(() => {
    if (!drawing) return;
    const waves = new Set<ReturnType<typeof setTimeout>>();
    const stop = startRoomPointer({
      onActivate: (hit, at) => {
        // The window, the tree and a purged book have no page of their own: the card, pinned, is all they show.
        if (hit.kind === "window" || describe(hit)?.hint === null) return pinCard(hit, at.x, at.y);
        if (hit.kind === "robot" && palaceRef.current) {
          // On the Palace page a robot waves before its card shows (pinned, with the button to its session).
          hideCard();
          waveRobot(hit.id);
          requestRoomFrame();
          const timer = setTimeout(() => {
            waves.delete(timer);
            pinCard(hit, at.x, at.y);
          }, WAVE_MS);
          waves.add(timer);
          return;
        }
        hideCard();
        open(hit);
      },
    });
    return () => {
      stop();
      for (const timer of waves) clearTimeout(timer);
    };
  }, [drawing, open, describe]);

  // The attribute React renders holds only what the server renders the same (hydration must match);
  // the live objects (from data the page loads after it) and what the canvas reports are merged in after.
  const base = { scene, weather: condition, renderer, source: environment?.source ?? "none", still: reducedMotion };
  const baseJson = JSON.stringify(base);
  const liveJson = JSON.stringify({ ...liveSummary(data), ...growthSummary(growthData) });
  const element = useRef<HTMLDivElement>(null);
  // The layout registry measures the viewport as this fixed element's box, the size the canvas takes.
  useLayoutEffect(() => (element.current ? registerStage(element.current) : undefined), []);
  useLayoutEffect(() => {
    const merged = { ...(JSON.parse(baseJson) as object), ...(JSON.parse(liveJson) as object) };
    const write = (report: Record<string, unknown>) => {
      if (element.current) element.current.dataset.room = JSON.stringify({ ...merged, ...report });
      setDrawn(report.drawn === true);
    };
    write(readRoomReport());
    return onRoomReport(write);
  }, [baseJson, liveJson]);
  /** The placeholder stays opaque under the canvas while it fades in, and goes once it has. */
  const [faded, setFaded] = useState(false);
  const [wasDrawn, setWasDrawn] = useState(drawn);
  if (wasDrawn !== drawn) {
    setWasDrawn(drawn);
    if (!drawn) setFaded(false);
  }
  /** The snapshot can no longer stand in (it has, or a lost context or a failure came first): the sketch from now on. */
  const [spent, setSpent] = useState(snapshotSpent);
  const spend = useCallback(() => {
    snapshotSpent = true;
    skipSketchDrawIn();
    setSpent(true);
  }, []);
  useEffect(() => {
    if (!drawn) return;
    const timer = setTimeout(() => {
      setFaded(true);
      spend();
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [drawn, spend]);
  const choice = useSnapshotChoice(hydrated);
  const snapshot = renderer === "webgl" && !spent && choice ? choice : null;
  /**
   * What is under the canvas (docs/PALACE.md, The veil): nothing before hydration (the ground), then
   * until the canvas has drawn and faded in the snapshot when one is eligible, else the sketch;
   * nothing while that is chosen. Without the canvas, always the sketch.
   */
  const placeholder = !hydrated || (drawn && faded) ? null : renderer !== "webgl" ? "sketch" : choice === undefined ? null : snapshot ? "snapshot" : "sketch";
  const failed = useCallback(() => {
    setLost(true);
    spend();
  }, [spend]);
  const onContextLost = useCallback(() => {
    setContextLost(true);
    spend();
  }, [spend]);
  const onContextRestored = useCallback(() => {
    setContextLost(false);
    setCanvasKey((key) => key + 1);
  }, []);

  return (
    <div
      ref={element}
      className="room-scene"
      data-scene={scene}
      data-activity={activity}
      data-renderer={renderer}
      data-placeholder={placeholder ?? undefined}
      data-drawn={drawn ? "" : undefined}
      data-room={baseJson}
      data-view={palace ? "palace" : undefined}
      style={style}
      aria-hidden="true"
    >
      {placeholder === "snapshot" && snapshot && <SnapshotImage record={snapshot} onFail={spend} />}
      {placeholder === "sketch" && <Sketch milestones={milestones} />}
      {mounted && (
        <CanvasBoundary key={canvasKey} onError={failed}>
          <RoomCanvas
            clock={clock}
            live={live}
            growth={growth}
            weather={weather}
            reducedMotion={reducedMotion}
            onContextLost={onContextLost}
            onContextRestored={onContextRestored}
          />
        </CanvasBoundary>
      )}
      {/* Portalled to the body, so outside this hidden element. */}
      {drawing && <RoomHoverCard describe={describe} open={open} />}
    </div>
  );
}
