"use client";

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { AgXToneMapping, PCFShadowMap } from "three";
import type { RoomWeather } from "@portal/contracts/room";
import FrostPass from "./frost/FrostPass";
import type { GrowthScene } from "./growth";
import type { HearthLevel, LampState, RobotCrowd } from "./live";
import { setCurrentLoop, startRoomLoop, type RoomLoop } from "./loop";
import { clearRoomReport } from "./report";
import type { SunClock } from "./sun";
import Books from "./scene/Books";
import CameraRig from "./scene/Camera";
import Corkboard from "./scene/Corkboard";
import Frames from "./scene/Frames";
import Hearth from "./scene/Hearth";
import { PointerBridge } from "./scene/Hotspot";
import Keys from "./scene/Keys";
import Kettle from "./scene/Kettle";
import Lamp from "./scene/Lamp";
import MailTray from "./scene/MailTray";
import Milestones, { useDeliveries } from "./scene/Milestones";
import Plants from "./scene/Plants";
import Robots from "./scene/Robots";
import Shell from "./scene/Shell";
import Sky from "./scene/Sky";
import Sun from "./scene/Sun";
import Tree from "./scene/Tree";
import Weather from "./scene/Weather";
import Window from "./scene/Window";

/** Renderer options, constant so the canvas never re-applies them. */
const GL = { antialias: false, powerPreference: "low-power", toneMapping: AgXToneMapping, toneMappingExposure: 1.1 } as const;
/** One shadow map that renders only when asked (`needsUpdate`): when the sun moves. */
const SHADOWS = { enabled: true, type: PCFShadowMap, autoUpdate: false };
const CAMERA = { fov: 30, near: 0.5, far: 220, position: [6, 6, 12] as [number, number, number] };
const DPR: [number, number] = [1, 1.5];
const STYLE = { position: "absolute", inset: 0, pointerEvents: "none" } as const;

/** Drives the canvas (`frameloop="never"`) from the capped loop; a new `revision` or size asks for a frame. */
function Loop({ reducedMotion, revision, onLoop }: { reducedMotion: boolean; revision: string; onLoop: (loop: RoomLoop | null) => void }) {
  const advance = useThree((state) => state.advance);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const own = useRef<RoomLoop | null>(null);
  useEffect(() => {
    const context = gl.getContext();
    // R3F's clock takes the timestamp as given under `frameloop="never"`: seconds, as every `useFrame` reads it.
    // Nothing draws while the GPU has the context (lost until it is restored and the canvas remounts).
    const started = startRoomLoop(
      (time) => {
        if (!context.isContextLost()) advance(time / 1000);
      },
      { reducedMotion },
    );
    own.current = started;
    onLoop(started);
    setCurrentLoop(started);
    return () => {
      started.stop();
      own.current = null;
      onLoop(null);
      setCurrentLoop(null);
    };
  }, [advance, gl, reducedMotion, onLoop]);
  useEffect(() => {
    own.current?.request();
  }, [revision, size.width, size.height]);
  return null;
}

/** What the live objects show (docs/PALACE.md, Objects), from `RoomBackground`. */
export type RoomLiveScene = {
  crowd: RobotCrowd;
  mail: { sealed: number; open: number; pile: number };
  hearth: HearthLevel;
  lamp: LampState;
  kettle: boolean;
};

export type RoomCanvasProps = {
  clock: SunClock;
  live: RoomLiveScene;
  /** The accumulated objects and the milestones (docs/PALACE.md, Objects and Milestones), from `RoomBackground`. */
  growth: GrowthScene;
  weather: RoomWeather | null;
  reducedMotion: boolean;
  /** The GPU dropped the context: the background shows the gradient until it is restored. */
  onContextLost: () => void;
  /** The GPU gave the context back: the background remounts the canvas from scratch. */
  onContextRestored: () => void;
};

/**
 * The room's WebGL canvas (docs/PALACE.md, Web): react-three-fiber with a capped hand-driven loop,
 * DPR at most 1.5, no antialiasing, a low-power context, AgX tone mapping, and one sun shadow map.
 * Every frame goes through `FrostPass`, which blurs the room under the `.frost` panels. The live
 * objects (robots, lamp, hearth, kettle, mail tray) and the accumulated ones (books, notes, plants,
 * frames, keys, the tree) are hotspots for the page's pointer (`pointer.ts`). Milestone furniture
 * mounts as it is reached, a fresh one delivered in a crate (`Milestones`).
 * Loaded with `next/dynamic` (no SSR) by `RoomBackground`, which owns the fallbacks.
 */
function RoomCanvas({ clock, live, growth, weather, reducedMotion, onContextLost, onContextRestored }: RoomCanvasProps) {
  const loop = useRef<RoomLoop | null>(null);
  const condition = weather?.condition ?? "clear";
  const deliveries = useDeliveries(growth.milestones, reducedMotion);
  const { shown } = deliveries;
  // A change in what the objects show asks for a frame (the only way one draws under reduced motion).
  const liveKey = useMemo(() => JSON.stringify(live), [live]);
  const growthKey = useMemo(() => `${JSON.stringify(growth)}:${[...shown].join(",")}`, [growth, shown]);
  useEffect(() => () => clearRoomReport(), []);
  const onLoop = useCallback((started: RoomLoop | null) => {
    loop.current = started;
  }, []);
  const requestFrame = useCallback(() => loop.current?.request(), []);
  return (
    <Canvas
      frameloop="never"
      dpr={DPR}
      gl={GL}
      shadows={SHADOWS}
      camera={CAMERA}
      style={STYLE}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (event) => {
          // Prevented, so the browser may restore it.
          event.preventDefault();
          onContextLost();
        });
        gl.domElement.addEventListener("webglcontextrestored", () => onContextRestored());
      }}
    >
      <Loop reducedMotion={reducedMotion} revision={`${clock.at}:${condition}:${liveKey}:${growthKey}`} onLoop={onLoop} />
      <color attach="background" args={["#1d1916"]} />
      <fogExp2 attach="fog" args={["#8b8f94", 0]} />
      <CameraRig onChange={requestFrame} />
      <Sky clock={clock} condition={condition} />
      <Sun clock={clock} condition={condition} />
      <Weather weather={weather} clock={clock} reducedMotion={reducedMotion} bay={shown.has("bay-window")} />
      <Shell />
      <Window bay={shown.has("bay-window")} />
      <Tree tree={growth.tree} reducedMotion={reducedMotion} />
      <Lamp state={live.lamp} reducedMotion={reducedMotion} />
      <Hearth level={live.hearth} reducedMotion={reducedMotion} />
      <Kettle steaming={live.kettle} reducedMotion={reducedMotion} />
      <MailTray sealed={live.mail.sealed} open={live.mail.open} pile={live.mail.pile} />
      <Robots crowd={live.crowd} reducedMotion={reducedMotion} />
      <Books books={growth.books} shown={shown} />
      <Corkboard notes={growth.notes} shown={shown} />
      <Plants sill={growth.plants.sill} stand={growth.plants.stand} reducedMotion={reducedMotion} />
      <Frames frames={growth.frames} />
      <Keys count={growth.keys} />
      <Milestones deliveries={deliveries} reducedMotion={reducedMotion} />
      <PointerBridge />
      <FrostPass />
    </Canvas>
  );
}

/** Memoised: the background re-renders with every session list change, the scene only when what it shows changed. */
export default memo(RoomCanvas);
