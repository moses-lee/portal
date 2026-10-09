"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { AgentActivity } from "@/lib/agent-activity";
import { usePortalEvents, usePortalLive } from "@/components/portal/PortalLive";
import { useSessions } from "@/components/SessionsProvider";
import { useMediaQuery } from "@/components/useMediaQuery";
import { useWorkspaceActions } from "@/components/workspace/useWorkspaceActions";
import { pushPath } from "@/lib/navigation";
import { isPortalPath, portalPath, portalPathKeepingPanel, type PortalView } from "@/lib/session-routes";
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
import { sceneForAltitude, skyColours } from "./sun";
import { useRoomState, useSunClock } from "./useRoomState";

/** The WebGL room loads on the client only, in its own chunk: three.js stays off the first paint. */
const RoomCanvas = dynamic(() => import("./RoomCanvas"), { ssr: false });
/** The hover card shows only over the canvas: it loads with it. */
const RoomHoverCard = dynamic(() => import("./RoomHoverCard"), { ssr: false });

let webglSupport: boolean | null = null;

/** Whether this browser can open a WebGL context at all; asked once, the probe context released at once. */
function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webglSupport = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

const subscribeNever = () => () => {};

/** Set once the page has had its first idle moment; later mounts (another view) draw at once. */
let settled = false;

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
      const id = window.requestIdleCallback(done, { timeout: 1500 });
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

/** The Portal view a room object opens: the tracked panel's session comes along on Portal pages. */
function openView(view: PortalView) {
  pushPath(isPortalPath(window.location.pathname) ? portalPathKeepingPanel(view, window.location.search) : portalPath(view));
}

/**
 * The room behind every Portal view and the workspace (docs/PALACE.md): the 3D canvas when the
 * browser can draw it, else a CSS gradient sky with the same colours under the dark veil (no
 * WebGL, a lost context, or `prefers-reduced-transparency`). It follows the real sun at the room's
 * location, never a setting. The live objects follow the session list, the portal stream's status
 * and the census; with the canvas up, a document-level pointer listener (`pointer.ts`) shows their
 * hover cards and clicks through. `palace` is the Palace page, where a clicked robot waves first.
 * The fixed `.room-scene` element carries what tests and CSS read: `data-scene` (day or night,
 * from the sun's altitude), `data-activity`, `data-renderer`, and a `data-room` JSON summary (the
 * live objects, and what the canvas reports: the camera's look and the objects' screen points).
 */
export default function RoomBackground({ activity, palace = false }: { activity: AgentActivity; palace?: boolean }) {
  const room = useRoomState();
  const environment = room?.environment ?? null;
  const clock = useSunClock(environment);
  const webgl = useSyncExternalStore(subscribeNever, hasWebGL, () => false);
  const reducedTransparency = useMediaQuery("(prefers-reduced-transparency: reduce)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [lost, setLost] = useState(false);
  const ready = useSettled();
  const renderer = webgl && !lost && !reducedTransparency ? "webgl" : "fallback";
  const weather = environment?.weather ?? null;
  const condition = weather?.condition ?? "clear";
  const scene = clock ? sceneForAltitude(clock.sun.altitude) : "pending";
  const sky = clock ? skyColours(clock.sun.altitude, condition) : null;
  const style = sky ? ({ "--room-sky-top": sky.zenith, "--room-sky-horizon": sky.horizon } as CSSProperties) : undefined;

  // The live objects (docs/PALACE.md, Objects).
  const { sessions, tracked } = useSessions();
  const { status, approvals } = usePortalLive();
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
  const describe = useCallback((target: RoomTarget) => describeObject(target, dataRef.current), []);

  const { openSession } = useWorkspaceActions();
  const open = useCallback(
    (target: RoomTarget) => {
      if (target.kind === "robot") void openSession(target.id);
      else if (target.kind === "mail") openView("attention");
      else if (target.kind === "hearth") openView("activity");
      else if (target.kind === "kettle") openView("watches");
      else if (target.kind === "lamp") openView("chat");
    },
    [openSession],
  );
  const palaceRef = useRef(palace);
  useLayoutEffect(() => {
    palaceRef.current = palace;
  });
  const drawing = renderer === "webgl" && !!clock && ready;
  useEffect(() => {
    if (!drawing) return;
    const waves = new Set<ReturnType<typeof setTimeout>>();
    const stop = startRoomPointer({
      onActivate: (hit, at) => {
        // The window has no page of its own: its card, pinned, is all it shows.
        if (hit.kind === "window") return pinCard(hit, at.x, at.y);
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
  }, [drawing, open]);

  // The attribute React renders holds only what the server renders the same (hydration must match);
  // the live objects (from data the page loads after it) and what the canvas reports are merged in after.
  const base = { scene, weather: condition, renderer, source: environment?.source ?? "none", still: reducedMotion };
  const baseJson = JSON.stringify(base);
  const liveJson = JSON.stringify(liveSummary(data));
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const merged = { ...(JSON.parse(baseJson) as object), ...(JSON.parse(liveJson) as object) };
    const write = (report: Record<string, unknown>) => {
      if (element.current) element.current.dataset.room = JSON.stringify({ ...merged, ...report });
    };
    write(readRoomReport());
    return onRoomReport(write);
  }, [baseJson, liveJson]);
  const contextLost = useCallback(() => setLost(true), []);

  return (
    <div
      ref={element}
      className="room-scene"
      data-scene={scene}
      data-activity={activity}
      data-renderer={renderer}
      data-room={baseJson}
      style={style}
      aria-hidden="true"
    >
      {drawing && <RoomCanvas clock={clock} live={live} weather={weather} reducedMotion={reducedMotion} onContextLost={contextLost} />}
      {/* Portalled to the body, so outside this hidden element. */}
      {drawing && <RoomHoverCard describe={describe} open={open} />}
    </div>
  );
}
