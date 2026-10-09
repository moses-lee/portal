"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { LEAVES, type TreeSpec } from "../growth";
import { Hotspot } from "./Hotspot";
import { matteMaterial } from "./materials";
import { WindowView } from "./Window";

const BARK = "#6b4a34";
/** Where the trunk stands in the window's view (below the sill line, so it rises into the glass). */
const ROOT = { x: 0.55, y: -1.45 } as const;

/** The canopy's balls at full size (x, y above the root, radius) and where its accents sit. */
const CANOPY = [
  [0, 1.95, 0.5],
  [-0.32, 1.72, 0.34],
  [0.34, 1.78, 0.36],
  [0.05, 2.28, 0.32],
] as const;
const ACCENTS = [
  [-0.2, 2.05, 0.38],
  [0.28, 2.0, 0.36],
  [0.12, 1.62, 0.4],
  [-0.38, 1.6, 0.25],
  [0.42, 1.65, 0.26],
  [0.02, 2.45, 0.2],
] as const;
/** Bare branches in winter: angle from upright, length. */
const BRANCHES = [
  [-0.7, 0.55],
  [0.6, 0.6],
  [-0.25, 0.7],
  [0.35, 0.5],
] as const;

/**
 * The tree outside the window (docs/PALACE.md, Objects): its size from `since` (a sapling to 30
 * days, young to 180, full grown at 365, big past 730) and its leaves from the season in the room's
 * hemisphere (fresh green with blossom, deep green, turning, bare). It lives in the window's view
 * (`WindowView`), so it stays framed by the glass from any pose, rising from below the sill. Its
 * hotspot (its crown) wins over the window's.
 */
export default function Tree({ tree, reducedMotion }: { tree: TreeSpec; reducedMotion: boolean }) {
  const crown = useRef<Group>(null);
  useFrame(({ clock }) => {
    const node = crown.current;
    if (!node) return;
    node.rotation.z = reducedMotion ? 0 : Math.sin(clock.elapsedTime * 0.5) * 0.015 + Math.sin(clock.elapsedTime * 1.3) * 0.006;
  });
  const leaves = LEAVES[tree.season];
  const scale = tree.scale;
  const trunk = 1.75;
  return (
    <WindowView distance={4}>
      <group position={[ROOT.x, ROOT.y, 0]} scale={scale}>
        <mesh position={[0, trunk / 2, 0]} material={matteMaterial(BARK)}>
          <cylinderGeometry args={[0.06, 0.1, trunk, 8]} />
        </mesh>
        <group ref={crown} position={[0, trunk * 0.75, 0]}>
          {leaves ? (
            <>
              {CANOPY.map(([x, y, r]) => (
                <mesh key={`${x}:${y}`} position={[x, y - trunk * 0.75, 0]} material={matteMaterial(leaves.canopy)}>
                  <icosahedronGeometry args={[r, 1]} />
                </mesh>
              ))}
              {ACCENTS.map(([x, y, z]) => (
                <mesh key={`${x}:${y}`} position={[x, y - trunk * 0.75, z]} material={matteMaterial(leaves.accent)}>
                  <icosahedronGeometry args={[tree.season === "spring" ? 0.06 : 0.1, 0]} />
                </mesh>
              ))}
            </>
          ) : (
            BRANCHES.map(([angle, length]) => (
              <mesh key={angle} position={[Math.sin(angle) * length * 0.5, Math.cos(angle) * length * 0.5, 0]} rotation={[0, 0, -angle]} material={matteMaterial(BARK)}>
                <cylinderGeometry args={[0.015, 0.035, length, 6]} />
              </mesh>
            ))
          )}
        </group>
        {/* The crown only: the trunk's foot is behind the wall, where the desk's hotspot must still answer. */}
        <Hotspot kind="tree" size={[1.25, 1.15, 0.6]} position={[0, 2.0, 0]} priority={2} />
      </group>
    </WindowView>
  );
}
