"use client";

import { useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, type Group } from "three";
import { ROOM, WINDOW_CENTRE } from "../layout";
import { Hotspot } from "./Hotspot";
import { matteMaterial, palette } from "./materials";

/** The window opening's centre, on the glass (`WINDOW_CENTRE`). */
const GLASS_CENTRE = new Vector3(...WINDOW_CENTRE);

const toWindow = new Vector3();

/**
 * A group that sits `distance` behind the window along the camera's line of sight through it, facing
 * the camera, so its children (clouds, the moon) stay framed by the window from every fitted pose.
 * Children are laid out in the group's plane: +x right and +y up as seen through the glass.
 */
export function WindowView({ distance, children }: { distance: number; children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const node = group.current;
    if (!node) return;
    toWindow.copy(GLASS_CENTRE).sub(camera.position).normalize();
    node.position.copy(GLASS_CENTRE).addScaledVector(toWindow, distance);
    node.quaternion.copy(camera.quaternion);
  });
  return <group ref={group}>{children}</group>;
}

/** How far the bay window stands out beyond the wall, and how its sides angle in. */
const BAY = { depth: 0.55, cheek: 0.45 } as const;

/**
 * The bay window (the 600-session milestone): the opening stays, and beyond it a box of glass stands
 * out from the wall (a front pane and two angled side panes under a little roof), with a cushioned
 * seat at sill height inside it. The sky and the weather still show through.
 */
function Bay() {
  const { window: w, back } = ROOM;
  const outer = back - 0.25;
  const front = outer - BAY.depth;
  const height = w.top - w.sill;
  const frontWidth = w.width - 2 * BAY.cheek * 0.55;
  const frame = matteMaterial(palette.frame);
  const bar = 0.06;
  const cheekLength = Math.hypot(BAY.depth, (w.width - frontWidth) / 2);
  const cheekAngle = Math.atan2((w.width - frontWidth) / 2, BAY.depth);
  return (
    <group>
      {/* The seat: a board across the bay at sill height, a cushion on it. */}
      <mesh position={[w.x, w.sill - 0.03, (outer + front) / 2 + 0.06]} material={matteMaterial(palette.sill)} receiveShadow castShadow>
        <boxGeometry args={[w.width - 0.1, 0.06, BAY.depth + 0.2]} />
      </mesh>
      <mesh position={[w.x, w.sill + 0.04, (outer + front) / 2 + 0.06]} material={matteMaterial("#7d9bb5")} receiveShadow castShadow>
        <boxGeometry args={[w.width - 0.3, 0.08, BAY.depth - 0.05]} />
      </mesh>
      {/* The front pane's frame and glass. */}
      {[w.sill + bar / 2, w.top - bar / 2].map((y) => (
        <mesh key={y} position={[w.x, y, front]} material={frame} castShadow>
          <boxGeometry args={[frontWidth, bar, 0.08]} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[w.x + (side * (frontWidth - bar)) / 2, w.sill + height / 2, front]} material={frame} castShadow>
          <boxGeometry args={[bar, height, 0.08]} />
        </mesh>
      ))}
      <mesh position={[w.x, w.sill + height / 2, front - 0.01]}>
        <planeGeometry args={[frontWidth, height]} />
        <meshBasicMaterial color={palette.glass} transparent opacity={0.07} depthWrite={false} />
      </mesh>
      {/* The angled sides, each a frame from the wall's opening to the front pane. */}
      {[-1, 1].map((side) => (
        <group key={side} position={[w.x + side * (w.width / 2 - (w.width - frontWidth) / 4), 0, (outer + front) / 2]} rotation={[0, side * cheekAngle, 0]}>
          {[w.sill + bar / 2, w.top - bar / 2].map((y) => (
            <mesh key={y} position={[0, y, 0]} material={frame} castShadow>
              <boxGeometry args={[0.06, bar, cheekLength]} />
            </mesh>
          ))}
        </group>
      ))}
      {/* The bay's roof, sloping down and out. */}
      <mesh position={[w.x, w.top + 0.06, (outer + front) / 2]} rotation={[-0.25, 0, 0]} material={matteMaterial(palette.wallTrim)} castShadow>
        <boxGeometry args={[w.width + 0.1, 0.05, BAY.depth + 0.15]} />
      </mesh>
    </group>
  );
}

/**
 * The window's frame, mullions, sill and glass (the view through it is the sky and the weather),
 * and its hover card's hotspot. With `bay` (a milestone) the panes move out into a bay with a seat;
 * the inside sill, where the plants stand, stays.
 */
export default function Window({ bay = false }: { bay?: boolean }) {
  const { window: w, back } = ROOM;
  const left = w.x - w.width / 2;
  const right = w.x + w.width / 2;
  const height = w.top - w.sill;
  const z = back - 0.12;
  const bar = 0.07;
  const frame = matteMaterial(palette.frame);
  return (
    <group>
      {bay ? (
        <>
          {/* The opening's casing only: the panes stand out in the bay. */}
          {[left + bar / 2, right - bar / 2].map((x) => (
            <mesh key={x} position={[x, w.sill + height / 2, back - 0.03]} material={frame} castShadow>
              <boxGeometry args={[bar, height, 0.06]} />
            </mesh>
          ))}
          <mesh position={[w.x, w.top - bar / 2, back - 0.03]} material={frame} castShadow>
            <boxGeometry args={[w.width, bar, 0.06]} />
          </mesh>
          <Bay />
        </>
      ) : (
        <>
          <mesh position={[w.x, w.top - bar / 2, z]} material={frame} castShadow>
            <boxGeometry args={[w.width, bar, 0.1]} />
          </mesh>
          <mesh position={[w.x, w.sill + bar / 2, z]} material={frame} castShadow>
            <boxGeometry args={[w.width, bar, 0.1]} />
          </mesh>
          <mesh position={[left + bar / 2, w.sill + height / 2, z]} material={frame} castShadow>
            <boxGeometry args={[bar, height, 0.1]} />
          </mesh>
          <mesh position={[right - bar / 2, w.sill + height / 2, z]} material={frame} castShadow>
            <boxGeometry args={[bar, height, 0.1]} />
          </mesh>
          <mesh position={[w.x, w.sill + height / 2, z]} material={frame} castShadow>
            <boxGeometry args={[0.05, height, 0.08]} />
          </mesh>
          <mesh position={[w.x, w.sill + height * 0.62, z]} material={frame} castShadow>
            <boxGeometry args={[w.width, 0.05, 0.08]} />
          </mesh>
          {/* Faint glass: a sheen, not a reflection. It neither casts nor blocks shadows. */}
          <mesh position={[w.x, w.sill + height / 2, z - 0.01]}>
            <planeGeometry args={[w.width, height]} />
            <meshBasicMaterial color={palette.glass} transparent opacity={0.07} depthWrite={false} />
          </mesh>
        </>
      )}
      {/* The inside sill, where the plants stand. */}
      <mesh position={[w.x, w.sill - 0.02, back + 0.1]} material={matteMaterial(palette.sill)} castShadow receiveShadow>
        <boxGeometry args={[w.width + 0.3, 0.06, 0.3]} />
      </mesh>
      {/* Hovered or clicked, the window shows its card only: the weather and its source. */}
      <Hotspot kind="window" size={[w.width, height, 0.3]} position={[w.x, w.sill + height / 2, z]} />
    </group>
  );
}
