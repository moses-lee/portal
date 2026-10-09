"use client";

import { useCallback, useEffect, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { AgXToneMapping, PCFShadowMap } from "three";
import type { RoomWeather } from "@portal/contracts/room";
import FrostPass from "./frost/FrostPass";
import { startRoomLoop, type RoomLoop } from "./loop";
import type { SunClock } from "./sun";
import CameraRig from "./scene/Camera";
import Shell from "./scene/Shell";
import Sky from "./scene/Sky";
import Sun from "./scene/Sun";
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
  const size = useThree((state) => state.size);
  const own = useRef<RoomLoop | null>(null);
  useEffect(() => {
    const started = startRoomLoop((time) => advance(time), { reducedMotion });
    own.current = started;
    onLoop(started);
    return () => {
      started.stop();
      own.current = null;
      onLoop(null);
    };
  }, [advance, reducedMotion, onLoop]);
  useEffect(() => {
    own.current?.request();
  }, [revision, size.width, size.height]);
  return null;
}

export type RoomCanvasProps = {
  clock: SunClock;
  weather: RoomWeather | null;
  reducedMotion: boolean;
  /** The GPU dropped the context: the background falls back to the gradient. */
  onContextLost: () => void;
};

/**
 * The room's WebGL canvas (docs/PALACE.md, Web): react-three-fiber with a capped hand-driven loop,
 * DPR at most 1.5, no antialiasing, a low-power context, AgX tone mapping, and one sun shadow map.
 * Every frame goes through `FrostPass`, which blurs the room under the `.frost` panels.
 * Loaded with `next/dynamic` (no SSR) by `RoomBackground`, which owns the fallbacks.
 */
export default function RoomCanvas({ clock, weather, reducedMotion, onContextLost }: RoomCanvasProps) {
  const loop = useRef<RoomLoop | null>(null);
  const condition = weather?.condition ?? "clear";
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
          event.preventDefault();
          onContextLost();
        });
      }}
    >
      <Loop reducedMotion={reducedMotion} revision={`${clock.at}:${condition}`} onLoop={onLoop} />
      <color attach="background" args={["#1d1916"]} />
      <fogExp2 attach="fog" args={["#8b8f94", 0]} />
      <CameraRig reducedMotion={reducedMotion} onChange={requestFrame} />
      <Sky clock={clock} condition={condition} />
      <Sun clock={clock} condition={condition} />
      <Weather weather={weather} clock={clock} reducedMotion={reducedMotion} />
      <Shell />
      <Window />
      <FrostPass />
    </Canvas>
  );
}
