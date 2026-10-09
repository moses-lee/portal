"use client";

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { AgentActivity } from "@/lib/agent-activity";
import { useMediaQuery } from "@/components/useMediaQuery";
import { sceneForAltitude, skyColours } from "./sun";
import { useRoomState, useSunClock } from "./useRoomState";

/** The WebGL room loads on the client only, in its own chunk: three.js stays off the first paint. */
const RoomCanvas = dynamic(() => import("./RoomCanvas"), { ssr: false });

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

/**
 * The room behind every Portal view and the workspace (docs/PALACE.md): the 3D canvas when the
 * browser can draw it, else a CSS gradient sky with the same colours under the dark veil (no
 * WebGL, a lost context, or `prefers-reduced-transparency`). It follows the real sun at the room's
 * location, never a setting. The fixed `.room-scene` element carries what tests and CSS read:
 * `data-scene` (day or night, from the sun's altitude), `data-activity`, `data-renderer`, and a
 * `data-room` JSON summary.
 */
export default function RoomBackground({ activity }: { activity: AgentActivity }) {
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
  const summary = JSON.stringify({ scene, weather: condition, renderer, source: environment?.source ?? "none", still: reducedMotion });

  return (
    <div
      className="room-scene"
      data-scene={scene}
      data-activity={activity}
      data-renderer={renderer}
      data-room={summary}
      style={style}
      aria-hidden="true"
    >
      {renderer === "webgl" && clock && ready && (
        <RoomCanvas clock={clock} weather={weather} reducedMotion={reducedMotion} onContextLost={() => setLost(true)} />
      )}
    </div>
  );
}
