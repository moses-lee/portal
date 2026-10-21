"use client";

import type { MonitoringLevel } from "@portal/contracts/monitoring";
import { PANTRY_SHELF } from "../layout";
import { Hotspot } from "./Hotspot";
import { matteMaterial, palette } from "./materials";
import { Soft } from "./Shell";

/** The lid by the disk level: cream at rest and when all is well, amber, red. */
const LIDS: Record<MonitoringLevel | "rest", string> = { rest: "#e9dcc0", normal: "#e9dcc0", warning: "#e0a030", critical: "#c8463c" };
const BEANS = "#a5552c";
/** Clear glass, a little warm, so the beans keep their colour through it. */
const GLASS = "#fbf6ec";
const HIDDEN = 1e-4;

/**
 * The jar on a small pantry shelf above the stove (docs/MONITORING.md, Room): filled as far as the
 * volume holding Portal's home is used, its lid the disk level. At rest (no reading yet, or an OS
 * Portal cannot measure) it stands empty with a cream lid. It changes only when the numbers do.
 */
export default function Jar({ fill, lid }: { fill: number | null; lid: MonitoringLevel | null }) {
  const { jar, thickness } = PANTRY_SHELF;
  const top = thickness / 2;
  const inner = jar.radius - 0.008;
  const level = fill === null ? HIDDEN : Math.max(HIDDEN, Math.min(1, fill) * (jar.height - 0.02));
  return (
    <group position={[PANTRY_SHELF.x, PANTRY_SHELF.y, PANTRY_SHELF.z]}>
      {/* The shelf: a board on two brackets. */}
      <Soft size={[PANTRY_SHELF.width, thickness, PANTRY_SHELF.depth]} position={[0, 0, 0]} color={palette.woodLight} radius={0.01} />
      {[-1, 1].map((side) => (
        <Soft key={side} size={[0.03, 0.12, 0.14]} position={[side * (PANTRY_SHELF.width / 2 - 0.06), -0.075, -0.02]} color={palette.wood} radius={0.008} />
      ))}
      <group position={[jar.x - PANTRY_SHELF.x, top, 0]}>
        {/* What is in it, then the glass round it and the lid on top. */}
        <mesh position={[0, 0.006 + level / 2, 0]} scale={[1, level, 1]} material={matteMaterial(BEANS)} castShadow>
          <cylinderGeometry args={[inner, inner, 1, 18]} />
        </mesh>
        <mesh position={[0, jar.height / 2, 0]}>
          <cylinderGeometry args={[jar.radius, jar.radius, jar.height, 20]} />
          <meshBasicMaterial color={GLASS} transparent opacity={0.14} depthWrite={false} />
        </mesh>
        <mesh position={[0, jar.height + 0.014, 0]} material={matteMaterial(LIDS[lid ?? "rest"])} castShadow>
          <cylinderGeometry args={[jar.radius + 0.007, jar.radius + 0.007, 0.03, 20]} />
        </mesh>
        <mesh position={[0, jar.height + 0.034, 0]} material={matteMaterial(LIDS[lid ?? "rest"])}>
          <cylinderGeometry args={[0.018, 0.022, 0.014, 10]} />
        </mesh>
        <Hotspot kind="jar" size={[jar.radius * 2 + 0.08, jar.height + 0.12, jar.radius * 2 + 0.08]} position={[0, jar.height / 2 + 0.02, 0]} />
      </group>
    </group>
  );
}
