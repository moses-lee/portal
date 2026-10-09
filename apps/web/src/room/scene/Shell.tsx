"use client";

import { RoundedBox } from "@react-three/drei";
import { MeshBasicMaterial } from "three";
import { ROOM } from "../layout";
import { matteMaterial, palette, shellMaterial } from "./materials";

type Vec3 = [number, number, number];

/** A box from its min and max corners, in the shell's material (corner darkening) or a plain matte one. */
function Slab({ from, to, color, shell = true, cast = true }: { from: Vec3; to: Vec3; color: string; shell?: boolean; cast?: boolean }) {
  const size: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const position: Vec3 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
  return (
    <mesh position={position} castShadow={cast} receiveShadow material={shell ? shellMaterial(color) : matteMaterial(color)}>
      <boxGeometry args={size} />
    </mesh>
  );
}

/** A rounded low-poly box centred at `position`. */
export function Soft({ size, position, color, radius = 0.025, rotation }: { size: Vec3; position: Vec3; color: string; radius?: number; rotation?: Vec3 }) {
  return (
    <RoundedBox args={size} radius={radius} smoothness={2} position={position} rotation={rotation} castShadow receiveShadow material={matteMaterial(color)} />
  );
}

/** Walls run past the room's edges (and high above it) so the long lens never shows where the set ends. */
const FAR_RIGHT = 14;
const FAR_FRONT = 10;
const TALL = 10;
const WALL = 0.25;

function BackWall() {
  const back = ROOM.back;
  const behind = back - WALL;
  const { window: w, door } = ROOM;
  const windowLeft = w.x - w.width / 2;
  const windowRight = w.x + w.width / 2;
  const doorLeft = door.x - door.width / 2;
  const doorRight = door.x + door.width / 2;
  return (
    <group>
      <Slab from={[ROOM.left - WALL, 0, behind]} to={[windowLeft, TALL, back]} color={palette.wall} />
      <Slab from={[windowLeft, 0, behind]} to={[windowRight, w.sill, back]} color={palette.wall} />
      <Slab from={[windowLeft, w.top, behind]} to={[windowRight, TALL, back]} color={palette.wall} />
      <Slab from={[windowRight, 0, behind]} to={[doorLeft, TALL, back]} color={palette.wall} />
      <Slab from={[doorLeft, door.height, behind]} to={[doorRight, TALL, back]} color={palette.wall} />
      <Slab from={[doorRight, 0, behind]} to={[FAR_RIGHT, TALL, back]} color={palette.wall} />
      {/* Skirting along the back wall, broken by the door. */}
      <Slab from={[ROOM.left, 0, back]} to={[doorLeft - 0.06, 0.12, back + 0.03]} color={palette.wallTrim} shell={false} cast={false} />
      <Slab from={[doorRight + 0.06, 0, back]} to={[FAR_RIGHT, 0.12, back + 0.03]} color={palette.wallTrim} shell={false} cast={false} />
    </group>
  );
}

function LeftWall() {
  return (
    <group>
      <Slab from={[ROOM.left - WALL, 0, ROOM.back - WALL]} to={[ROOM.left, TALL, FAR_FRONT]} color={palette.wall} />
      <Slab from={[ROOM.left, 0, ROOM.back]} to={[ROOM.left + 0.03, 0.12, FAR_FRONT]} color={palette.wallTrim} shell={false} cast={false} />
    </group>
  );
}

function Floor() {
  return (
    <group>
      <Slab from={[ROOM.left - WALL, -0.2, ROOM.back - WALL]} to={[FAR_RIGHT, 0, FAR_FRONT]} color={palette.floor} cast={false} />
      {/* A few darker boards, so the floor reads as wood from far off. */}
      {[-2.2, -0.4, 1.4, 3.2].map((z) => (
        <Slab key={z} from={[ROOM.left, 0, z]} to={[FAR_RIGHT, 0.002, z + 0.05]} color={palette.floorDark} cast={false} />
      ))}
    </group>
  );
}

function Rug() {
  return (
    <group position={[0.3, 0, 0.5]}>
      <Soft size={[3.7, 0.03, 2.5]} position={[0, 0.015, 0]} color={palette.rugBorder} radius={0.012} />
      <Soft size={[3.3, 0.034, 2.1]} position={[0, 0.019, 0]} color={palette.rug} radius={0.012} />
    </group>
  );
}

/** Casts shadows and draws nothing. */
const shadowOnly = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/**
 * The ceiling the room would have: invisible, but it casts the sun's shadow, so daylight comes in
 * through the window only, and the floor out past the room's open sides is in the same shade as
 * the floor inside it (the walls alone would leave it sunlit wherever their shadows end).
 */
function Ceiling() {
  return (
    <mesh position={[(ROOM.left - WALL + FAR_RIGHT) / 2, ROOM.height + 0.1, (ROOM.back - WALL + FAR_FRONT) / 2]} material={shadowOnly} castShadow>
      <boxGeometry args={[FAR_RIGHT - ROOM.left + WALL, 0.2, FAR_FRONT - ROOM.back + WALL]} />
    </mesh>
  );
}

/** The door opening on the right of the back wall: casing, a dark hallway beyond, the leaf swung into the room. */
function Door() {
  const { door, back } = ROOM;
  const left = door.x - door.width / 2;
  const right = door.x + door.width / 2;
  return (
    <group>
      <Slab from={[left - 0.08, 0, back]} to={[left, door.height + 0.08, back + 0.05]} color={palette.frame} shell={false} />
      <Slab from={[right, 0, back]} to={[right + 0.08, door.height + 0.08, back + 0.05]} color={palette.frame} shell={false} />
      <Slab from={[left - 0.08, door.height, back]} to={[right + 0.08, door.height + 0.08, back + 0.05]} color={palette.frame} shell={false} />
      {/* The hallway beyond: a dark box (back, sides, floor) just big enough to fill the opening from any pose. */}
      <Slab from={[left - 0.5, -0.2, back - WALL - 1.3]} to={[right + 0.5, door.height + 0.6, back - WALL - 1.2]} color={palette.hallway} shell={false} />
      <Slab from={[left - 0.6, -0.2, back - WALL - 1.3]} to={[left - 0.5, door.height + 0.6, back - WALL]} color={palette.hallway} shell={false} />
      <Slab from={[right + 0.5, -0.2, back - WALL - 1.3]} to={[right + 0.6, door.height + 0.6, back - WALL]} color={palette.hallway} shell={false} />
      <Slab from={[left - 0.6, door.height + 0.6, back - WALL - 1.3]} to={[right + 0.6, door.height + 0.7, back - WALL]} color={palette.hallway} shell={false} />
      <Slab from={[left - 0.5, -0.2, back - WALL - 1.3]} to={[right + 0.5, 0, back]} color={palette.floorDark} shell={false} cast={false} />
      {/* The leaf, hinged at the right jamb and open about 70°. */}
      <group position={[right - 0.02, 0, back + 0.03]} rotation={[0, -1.2, 0]}>
        <Soft size={[door.width - 0.04, door.height - 0.04, 0.05]} position={[-(door.width - 0.04) / 2, (door.height - 0.04) / 2, 0]} color={palette.woodLight} radius={0.02} />
        <mesh position={[-(door.width - 0.16), 1.02, 0.05]} material={matteMaterial(palette.brass)}>
          <sphereGeometry args={[0.035, 10, 8]} />
        </mesh>
      </group>
    </group>
  );
}

/** The hearth alcove on the right of the back wall: a chimney breast, brick surround, a dark firebox, mantel and hearthstone (the fire is the live `Hearth`). */
function Alcove() {
  const { hearth, back } = ROOM;
  const front = back + hearth.depth;
  return (
    <group>
      <Slab from={[hearth.x - hearth.width / 2, 0, back]} to={[hearth.x + hearth.width / 2, TALL, front]} color={palette.wall} />
      <Slab from={[hearth.x - 0.62, 0, front]} to={[hearth.x + 0.62, 1.08, front + 0.04]} color={palette.brick} shell={false} cast={false} />
      <Slab from={[hearth.x - 0.4, 0, front + 0.04]} to={[hearth.x + 0.4, 0.78, front + 0.05]} color={palette.firebox} shell={false} cast={false} />
      <Soft size={[1.7, 0.08, 0.3]} position={[hearth.x, 1.14, front + 0.08]} color={palette.wood} radius={0.02} />
      <Soft size={[1.7, 0.05, 0.55]} position={[hearth.x, 0.025, front + 0.28]} color={palette.brick} radius={0.015} />
    </group>
  );
}

/** The desk under the window (the lamp, chair and papers on it are the live `Lamp`). */
function Desk() {
  const x = ROOM.window.x;
  const z = ROOM.back + 0.45;
  const legs: [number, number][] = [
    [-0.82, -0.28],
    [0.82, -0.28],
    [-0.82, 0.28],
    [0.82, 0.28],
  ];
  return (
    <group position={[x, 0, z]}>
      <Soft size={[1.84, 0.07, 0.68]} position={[0, 0.76, 0]} color={palette.wood} />
      {legs.map(([lx, lz]) => (
        <Soft key={`${lx}:${lz}`} size={[0.07, 0.73, 0.07]} position={[lx, 0.365, lz]} color={palette.wood} radius={0.015} />
      ))}
      <Soft size={[0.5, 0.2, 0.6]} position={[0.55, 0.62, 0]} color={palette.woodLight} />
    </group>
  );
}

/**
 * The fixed parts of the room (docs/PALACE.md, Shell and anchors), all primitives for now. The
 * shelving, the board and the rest of the furniture with slots belong to their objects (`Books`,
 * `Corkboard`, `Plants`, `Frames`, `Keys`) and the milestones (`Milestones`).
 */
export default function Shell() {
  return (
    <group>
      <Floor />
      <Ceiling />
      <BackWall />
      <LeftWall />
      <Rug />
      <Door />
      <Alcove />
      <Desk />
    </group>
  );
}
