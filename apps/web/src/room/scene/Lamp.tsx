"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BoxGeometry, DoubleSide, InstancedMesh, MeshStandardMaterial, Object3D, type PointLight } from "three";
import type { LampState } from "../live";
import { ROOM } from "../layout";
import { Hotspot } from "./Hotspot";
import { KitMesh, WithKit } from "./kit";
import { markForUpload, matteMaterial, palette, ROUGHNESS, setGlow } from "./materials";
import { Soft } from "./Shell";

/** The light's and the shade's glow for each state; the shade is emissive so the lamp reads as lit. */
const LEVELS: Record<LampState, { light: number; glow: number }> = {
  on: { light: 2.4, glow: 0.6 },
  dim: { light: 0.7, glow: 0.2 },
  off: { light: 0, glow: 0 },
};

const PAPERS = 4;

/**
 * Portal's chair: pulled out from the desk and turned side-on to the room, so its seat (where the
 * year's cat sleeps) shows from the camera instead of hiding behind the backrest.
 */
export const CHAIR = { x: ROOM.window.x + 0.2, z: ROOM.back + 0.45 + 0.72, turn: -1.2, seat: 0.42 } as const;
const scratch = new Object3D();

/** The desk's papers: where each sheet rests, and how it turns. */
const SHEETS = [
  { x: 0.02, z: 0.02, turn: 0.12 },
  { x: 0.1, z: -0.04, turn: -0.18 },
  { x: -0.06, z: 0.06, turn: 0.32 },
  { x: 0.05, z: 0.01, turn: -0.05 },
] as const;

/**
 * Portal's desk lamp, its chair and its papers (docs/PALACE.md, Objects): the lamp is on and the
 * papers shuffle during a chat turn, a dim glow when idle, off at night once Portal has been idle
 * for an hour. The point light is the one the room started with, so a change of state only drives
 * its intensity (no recompiles). The papers are one instanced mesh.
 */
export default function Lamp({ state, reducedMotion }: { state: LampState; reducedMotion: boolean }) {
  const x = ROOM.window.x;
  const z = ROOM.back + 0.45;
  const light = useRef<PointLight>(null);
  const shade = useMemo(
    () => new MeshStandardMaterial({ color: palette.shade, emissive: "#ffb35c", emissiveIntensity: LEVELS[state].glow, roughness: ROUGHNESS, side: DoubleSide }),
    // Created once; the state drives its intensity below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const papers = useMemo(() => new InstancedMesh(new BoxGeometry(0.21, 0.003, 0.29), matteMaterial("#f4efe4"), PAPERS), []);
  useEffect(
    () => () => {
      shade.dispose();
      papers.geometry.dispose();
      papers.dispose();
    },
    [shade, papers],
  );
  const level = useRef({ light: LEVELS[state].light, glow: LEVELS[state].glow });

  useFrame((frame, rawDelta) => {
    const delta = Math.min(0.1, Math.max(0, rawDelta));
    const t = frame.clock.elapsedTime;
    const target = LEVELS[state];
    const k = reducedMotion ? 1 : Math.min(1, delta * 4);
    level.current.light += (target.light - level.current.light) * k;
    level.current.glow += (target.glow - level.current.glow) * k;
    // A faint flicker while the lamp is on.
    const flicker = state === "on" && !reducedMotion ? 1 + 0.04 * Math.sin(t * 13) * Math.sin(t * 5.3) : 1;
    if (light.current) light.current.intensity = level.current.light * flicker;
    setGlow(shade, level.current.glow * flicker);

    const shuffling = state === "on" && !reducedMotion;
    for (let index = 0; index < PAPERS; index++) {
      const sheet = SHEETS[index];
      const lift = shuffling ? Math.max(0, Math.sin(t * 5 + index * 1.7)) * 0.025 : 0;
      const slide = shuffling ? Math.sin(t * 2.3 + index) * 0.03 : 0;
      scratch.position.set(sheet.x + slide, 0.002 + index * 0.004 + lift, sheet.z);
      scratch.rotation.set(shuffling ? Math.sin(t * 5 + index * 1.7) * 0.08 : 0, sheet.turn + (shuffling ? Math.sin(t * 1.6 + index) * 0.15 : 0), 0);
      scratch.updateMatrix();
      papers.setMatrixAt(index, scratch.matrix);
    }
    markForUpload(papers.instanceMatrix);
  });

  const legs: [number, number][] = [
    [-0.82, -0.28],
    [0.82, -0.28],
    [-0.82, 0.28],
    [0.82, 0.28],
  ];
  return (
    <group>
      <primitive object={papers} position={[x - 0.05, 0.795, z + 0.05]} castShadow receiveShadow frustumCulled={false} />
      <group position={[CHAIR.x, 0, CHAIR.z]} rotation={[0, CHAIR.turn, 0]}>
        <WithKit
          fallback={
            <>
              <Soft size={[0.5, 0.06, 0.48]} position={[0, CHAIR.seat - 0.03, 0]} color={palette.chair} />
              <Soft size={[0.5, 0.52, 0.06]} position={[0, CHAIR.seat + 0.27, 0.22]} color={palette.chair} />
              {legs.map(([lx, lz]) => (
                <Soft key={`${lx}:${lz}`} size={[0.05, CHAIR.seat - 0.06, 0.05]} position={[lx * 0.26, (CHAIR.seat - 0.06) / 2, lz * 0.75]} color={palette.wood} radius={0.012} />
              ))}
            </>
          }
        >
          {/* The kit chair's seat is at 0.49 of its height units. */}
          <KitMesh piece="chair_A_wood" color={palette.chair} rotation={[0, Math.PI, 0]} scale={CHAIR.seat / 0.49} />
        </WithKit>
      </group>
      <group position={[x - 0.62, 0.795, z - 0.1]}>
        <mesh position={[0, 0.02, 0]} castShadow material={matteMaterial(palette.brass)}>
          <cylinderGeometry args={[0.1, 0.12, 0.04, 14]} />
        </mesh>
        <mesh position={[0, 0.22, 0]} castShadow material={matteMaterial(palette.brass)}>
          <cylinderGeometry args={[0.014, 0.014, 0.38, 8]} />
        </mesh>
        <mesh position={[0, 0.44, 0]} castShadow material={shade}>
          <cylinderGeometry args={[0.07, 0.17, 0.2, 14, 1, true]} />
        </mesh>
        <pointLight ref={light} position={[0, 0.36, 0]} color="#ffbf73" intensity={LEVELS[state].light} distance={7} decay={2} />
      </group>
      <Hotspot kind="lamp" size={[1.3, 1.25, 1.3]} position={[x - 0.25, 0.62, z + 0.3]} />
    </group>
  );
}
