"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { MonitoringLevel } from "@portal/contracts/monitoring";
import { BAROMETER } from "../layout";
import { NEEDLE_ANGLES } from "../live";
import { Hotspot } from "./Hotspot";
import { matteMaterial, palette } from "./materials";

const FACE = "#f3ead6";
const INK = "#2f2c2a";
/** The dial's bands, one per level, centred where the needle points for it: Fair, Change, Stormy. */
const BANDS: { level: MonitoringLevel; colour: string }[] = [
  { level: "normal", colour: "#8fb36a" },
  { level: "warning", colour: "#e0a030" },
  { level: "critical", colour: "#c8463c" },
];
const BAND_HALF = 0.42;
/** The needle's spring: stiff enough to swing over in about a second, damped to one small overshoot. */
const STIFFNESS = 40;
const DAMPING = 8;

/**
 * The brass wall barometer on the chimney breast (docs/MONITORING.md, Room): its needle reads the
 * memory pressure, Fair (normal) on the right, Change (warning) at the top, Stormy (critical) on
 * the left, and hangs straight down at rest, before the first reading or on an OS Portal cannot
 * measure. A change of level swings the needle over on a damped spring; once it has settled
 * nothing moves. Under reduced motion it jumps.
 */
export default function Barometer({ level, reducedMotion }: { level: MonitoringLevel | null; reducedMotion: boolean }) {
  const needle = useRef<Group>(null);
  const swing = useRef({ angle: NEEDLE_ANGLES[level ?? "rest"], speed: 0 });

  useFrame((_, rawDelta) => {
    const node = needle.current;
    if (!node) return;
    const target = NEEDLE_ANGLES[level ?? "rest"];
    const state = swing.current;
    const delta = Math.min(0.1, Math.max(0, rawDelta));
    if (reducedMotion) {
      state.angle = target;
      state.speed = 0;
    } else if (state.angle !== target || state.speed !== 0) {
      state.speed += ((target - state.angle) * STIFFNESS - state.speed * DAMPING) * delta;
      state.angle += state.speed * delta;
      if (Math.abs(target - state.angle) < 1e-3 && Math.abs(state.speed) < 1e-3) {
        state.angle = target;
        state.speed = 0;
      }
    }
    // Clockwise from twelve o'clock, as the room sees the dial.
    node.rotation.z = -state.angle;
  });

  const { back, dial } = BAROMETER;
  return (
    <group position={[BAROMETER.x, BAROMETER.y, BAROMETER.z]}>
      {/* The round wooden back, the cream dial and its brass bezel. */}
      <mesh position={[0, 0, 0.02]} rotation={[Math.PI / 2, 0, 0]} material={matteMaterial(palette.wood)} castShadow receiveShadow>
        <cylinderGeometry args={[back, back, 0.04, 28]} />
      </mesh>
      <mesh position={[0, 0, 0.045]} rotation={[Math.PI / 2, 0, 0]} material={matteMaterial(FACE)}>
        <cylinderGeometry args={[dial, dial, 0.012, 28]} />
      </mesh>
      <mesh position={[0, 0, 0.05]} material={matteMaterial(palette.brass)} castShadow>
        <torusGeometry args={[dial + 0.008, 0.016, 6, 32]} />
      </mesh>
      {BANDS.map(({ level: band, colour }) => (
        <mesh key={band} position={[0, 0, 0.052]} material={matteMaterial(colour)}>
          {/* A ring's angles run anticlockwise from three o'clock; the needle's clockwise from twelve. */}
          <ringGeometry args={[dial * 0.68, dial * 0.86, 10, 1, Math.PI / 2 - NEEDLE_ANGLES[band] - BAND_HALF, BAND_HALF * 2]} />
        </mesh>
      ))}
      <group ref={needle} position={[0, 0, 0.058]}>
        <mesh position={[0, dial * 0.4, 0]} material={matteMaterial(INK)}>
          <boxGeometry args={[0.011, dial * 0.8, 0.005]} />
        </mesh>
        <mesh position={[0, -dial * 0.12, 0]} material={matteMaterial(INK)}>
          <boxGeometry args={[0.02, dial * 0.24, 0.005]} />
        </mesh>
      </group>
      <mesh position={[0, 0, 0.064]} rotation={[Math.PI / 2, 0, 0]} material={matteMaterial(palette.brass)}>
        <cylinderGeometry args={[0.016, 0.016, 0.012, 12]} />
      </mesh>
      <Hotspot kind="barometer" size={[back * 2 + 0.04, back * 2 + 0.04, 0.12]} position={[0, 0, 0.04]} />
    </group>
  );
}
