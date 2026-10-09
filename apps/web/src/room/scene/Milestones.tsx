"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, MeshStandardMaterial, type Group } from "three";
import type { RoomMilestone } from "@portal/contracts/room";
import { ROOM } from "../layout";
import { ANCHORS, furniture } from "../layout-slots";
import { SPOTS } from "../live";
import { reportRoom } from "../report";
import { CorkboardFrame, PINBOARD } from "./Corkboard";
import { CHAIR } from "./Lamp";
import { matteMaterial, palette, ROUGHNESS } from "./materials";
import { Soft } from "./Shell";

// ---------------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------------

/** A milestone this recent when the page first sees it is delivered, not just there. */
export const FRESH_MS = 2 * 60_000;
/** The crate's timeline (seconds): it slides in, opens, the furniture appears, the crate goes. */
const SLIDE_S = 1.5;
const OPEN_S = 0.6;
const REVEAL_S = SLIDE_S + 0.4;
const GONE_S = SLIDE_S + OPEN_S + 0.5;
/** The furniture's grow-in once revealed. */
const GROW_S = 0.45;

/** Milestones revealed during this page load: a canvas that mounts again does not deliver them twice. */
const delivered = new Set<string>();
/** The milestones in the first state this page load saw; any later one arrived over the stream. */
let baseline: ReadonlySet<string> | null = null;

/**
 * Of `fresh` (milestones this canvas has not placed yet, out of `all`), the ones the crate brings:
 * on the page's first state, those reached within the last two minutes; after it, those not in it
 * (they arrived over the stream). Never under reduced motion, never one already delivered.
 */
function toDeliver(all: readonly RoomMilestone[], fresh: readonly RoomMilestone[], reducedMotion: boolean): Set<string> {
  const first = baseline === null;
  if (first) baseline = new Set(all.map((milestone) => milestone.id));
  const arrived = baseline ?? new Set<string>();
  const now = Date.now();
  return new Set(
    fresh
      .filter((milestone) => !reducedMotion && !delivered.has(milestone.id) && (first ? now - milestone.at < FRESH_MS : !arrived.has(milestone.id)))
      .map((milestone) => milestone.id),
  );
}

export type Deliveries = {
  /** Milestones whose furniture is in the room. */
  shown: ReadonlySet<string>;
  /** Milestones waiting for (or riding in) the crate, in order; the first is the one on its way. */
  queue: readonly string[];
  /** When each delivered milestone's furniture appeared (`performance.now()`), for its grow-in. */
  revealedAt: Readonly<Record<string, number>>;
  reveal: (id: string) => void;
  done: (id: string) => void;
};

type DeliveryState = { shown: string[]; queue: string[]; revealedAt: Record<string, number> };

/**
 * Which milestones' furniture shows, and which arrive in the crate (docs/PALACE.md, Milestones): one
 * whose `at` is within the last two minutes when the page first sees it, or that arrives over the
 * stream while the page is open, is delivered (one crate at a time); every other one is simply
 * there. Under reduced motion nothing is delivered: the furniture just appears.
 */
export function useDeliveries(milestones: readonly RoomMilestone[] | null, reducedMotion: boolean): Deliveries {
  const [state, setState] = useState<DeliveryState>({ shown: [], queue: [], revealedAt: {} });
  const [seen, setSeen] = useState<readonly RoomMilestone[] | null>(null);
  if (milestones && milestones !== seen) {
    setSeen(milestones);
    const known = new Set([...state.shown, ...state.queue]);
    const fresh = milestones.filter((milestone) => !known.has(milestone.id));
    if (fresh.length) {
      const deliver = toDeliver(milestones, fresh, reducedMotion);
      setState({
        shown: [...state.shown, ...fresh.filter((milestone) => !deliver.has(milestone.id)).map((milestone) => milestone.id)],
        queue: [...state.queue, ...fresh.filter((milestone) => deliver.has(milestone.id)).map((milestone) => milestone.id)],
        revealedAt: state.revealedAt,
      });
    }
  }
  const reveal = useCallback((id: string) => {
    delivered.add(id);
    setState((current) => (current.shown.includes(id) ? current : { ...current, shown: [...current.shown, id], revealedAt: { ...current.revealedAt, [id]: performance.now() } }));
  }, []);
  const done = useCallback((id: string) => {
    setState((current) => ({ ...current, queue: current.queue.filter((each) => each !== id) }));
  }, []);
  const shown = useMemo(() => new Set(state.shown), [state.shown]);
  return { shown, queue: state.queue, revealedAt: state.revealedAt, reveal, done };
}

// ---------------------------------------------------------------------------------------------
// The crate
// ---------------------------------------------------------------------------------------------

/** Where the crate comes to rest: on the floor between the rug and the door. */
const DROP: [number, number] = [2.35, -0.75];
const CRATE = 0.56;
const PATH: [number, number][] = [[SPOTS.outside[0], SPOTS.outside[1]], [SPOTS.inside[0], SPOTS.inside[1]], DROP];
const LENGTHS = PATH.slice(1).map(([x, z], index) => Math.hypot(x - PATH[index][0], z - PATH[index][1]));
const TOTAL = LENGTHS.reduce((sum, length) => sum + length, 0);
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The crate on its way: slides in through the door, its lid lifts off and its sides fall open, then it shrinks away. */
function Crate({ deliveries }: { deliveries: Deliveries }) {
  const root = useRef<Group>(null);
  const lid = useRef<Group>(null);
  const sides = useRef<(Group | null)[]>([]);
  const started = useRef<{ id: string; at: number } | null>(null);
  /** Deliveries finished but maybe still at the queue's head until the state catches up. */
  const finished = useRef(new Set<string>());
  const { queue, reveal, done, shown } = deliveries;

  /** What `data-room` last said is in the crate (`delivery`), for tests. */
  const reported = useRef<string | null | undefined>(undefined);
  useFrame((frame) => {
    const node = root.current;
    if (!node) return;
    const head = queue.find((id) => !finished.current.has(id)) ?? null;
    if (reported.current !== head) {
      reported.current = head;
      reportRoom("delivery", head);
    }
    if (!head) {
      node.visible = false;
      started.current = null;
      return;
    }
    const now = performance.now();
    if (started.current?.id !== head) started.current = { id: head, at: now };
    const t = (now - started.current.at) / 1000;
    node.visible = true;
    // Along the path by distance, eased.
    let travel = ease(Math.min(1, t / SLIDE_S)) * TOTAL;
    let x = PATH[0][0];
    let z = PATH[0][1];
    for (let index = 0; index < LENGTHS.length; index++) {
      const step = Math.min(travel, LENGTHS[index]);
      const [x0, z0] = PATH[index];
      const [x1, z1] = PATH[index + 1];
      x = x0 + ((x1 - x0) * step) / LENGTHS[index];
      z = z0 + ((z1 - z0) * step) / LENGTHS[index];
      travel -= step;
      if (travel <= 0) break;
    }
    const open = Math.min(1, Math.max(0, (t - SLIDE_S) / OPEN_S));
    const fade = Math.min(1, Math.max(0, (t - SLIDE_S - OPEN_S) / (GONE_S - SLIDE_S - OPEN_S)));
    node.position.set(x, 0, z);
    node.scale.setScalar(Math.max(0.001, 1 - fade));
    // A little wobble while it slides.
    node.rotation.set(0, t < SLIDE_S ? Math.sin(t * 9) * 0.03 : 0, 0);
    if (lid.current) {
      lid.current.position.set(open * 0.35, CRATE + open * 0.25 - Math.max(0, open - 0.6) * 0.6, 0);
      lid.current.rotation.set(0, 0, -open * 1.2);
    }
    sides.current.forEach((side, index) => {
      if (side) side.rotation.set(index < 2 ? (index === 0 ? -1 : 1) * open * 1.45 : 0, 0, index >= 2 ? (index === 2 ? 1 : -1) * open * 1.45 : 0);
    });
    frame.gl.shadowMap.needsUpdate = true;
    if (t >= REVEAL_S && !shown.has(head)) reveal(head);
    if (t >= GONE_S) {
      started.current = null;
      finished.current.add(head);
      node.visible = false;
      done(head);
    }
  });

  const half = CRATE / 2;
  const wood = palette.woodLight;
  // The four sides, each hinged at its bottom edge so it can fall outwards.
  const panel = (key: number, position: [number, number, number], size: [number, number, number]) => (
    <group
      key={key}
      ref={(node) => {
        sides.current[key] = node;
      }}
      position={position}
    >
      <Soft size={size} position={[0, half, 0]} color={wood} radius={0.01} />
      <Soft size={[size[0] * 1.02, 0.05, size[2] * 1.4]} position={[0, half * 0.6, 0]} color={palette.wood} radius={0.008} />
    </group>
  );
  return (
    <group ref={root} visible={false}>
      <Soft size={[CRATE, 0.03, CRATE]} position={[0, 0.015, 0]} color={palette.wood} radius={0.008} />
      {panel(0, [0, 0, -half], [CRATE, CRATE, 0.03])}
      {panel(1, [0, 0, half], [CRATE, CRATE, 0.03])}
      {panel(2, [-half, 0, 0], [0.03, CRATE, CRATE])}
      {panel(3, [half, 0, 0], [0.03, CRATE, CRATE])}
      <group ref={lid} position={[0, CRATE, 0]}>
        <Soft size={[CRATE + 0.04, 0.035, CRATE + 0.04]} position={[0, 0.0175, 0]} color={palette.wood} radius={0.01} />
      </group>
      {/* Straw peeking out once it opens. */}
      <Soft size={[CRATE * 0.8, 0.12, CRATE * 0.8]} position={[0, 0.1, 0]} color="#e3c77a" radius={0.04} />
    </group>
  );
}

/** A milestone's furniture, growing in from nothing when it was just delivered. */
function Grow({ at, children }: { at: number | undefined; children: ReactNode }) {
  const node = useRef<Group>(null);
  useFrame(() => {
    const group = node.current;
    if (!group || at === undefined) return;
    const t = Math.min(1, (performance.now() - at) / 1000 / GROW_S);
    // Ease out with a little overshoot, settling at full size.
    const s = t >= 1 ? 1 : 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
    group.scale.setScalar(Math.max(0.001, s));
  });
  return (
    <group ref={node} scale={at === undefined ? 1 : 0.001}>
      {children}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// The furniture
// ---------------------------------------------------------------------------------------------

/** A floor-standing bookcase against the left wall whose shelves are the furniture's book rows. */
function Bookcase({ id }: { id: "tall-bookcase" | "second-bookcase" }) {
  const piece = furniture(id);
  const centre = piece.rows[0][2] + (piece.pitch[2] * (piece.perRow - 1)) / 2;
  const width = piece.pitch[2] * piece.perRow + 0.12;
  const depth = 0.38;
  const height = 2.45;
  const x = ROOM.left + depth / 2;
  return (
    <group position={[x, 0, centre]}>
      <Soft size={[0.03, height, width]} position={[-depth / 2 + 0.015, height / 2, 0]} color={palette.wood} radius={0.008} />
      {[-1, 1].map((side) => (
        <Soft key={side} size={[depth, height, 0.04]} position={[0, height / 2, (side * (width - 0.04)) / 2]} color={palette.woodLight} radius={0.012} />
      ))}
      <Soft size={[depth + 0.04, 0.05, width + 0.04]} position={[0, height, 0]} color={palette.woodLight} radius={0.012} />
      <Soft size={[depth, 0.1, width - 0.06]} position={[0, 0.06, 0]} color={palette.wood} radius={0.01} />
      {piece.rows.map(([, y]) => (
        <Soft key={y} size={[depth - 0.03, 0.035, width - 0.06]} position={[0.01, y - 0.0175, 0]} color={palette.woodLight} radius={0.008} />
      ))}
    </group>
  );
}

/** A rolling ladder on a rail along the bookcases. */
function Ladder() {
  const length = 2.38;
  const lean = 0.23;
  const z = -0.42;
  const rail = matteMaterial(palette.brass);
  return (
    <group>
      <mesh position={[ROOM.left + 0.42, 2.33, -0.4]} rotation={[Math.PI / 2, 0, 0]} material={rail} castShadow>
        <cylinderGeometry args={[0.014, 0.014, 3.5, 8]} />
      </mesh>
      <group position={[ROOM.left + 0.95, 0, z]} rotation={[0, 0, lean]}>
        {[-0.2, 0.2].map((dz) => (
          <Soft key={dz} size={[0.05, length, 0.04]} position={[0, length / 2, dz]} color={palette.wood} radius={0.01} />
        ))}
        {Array.from({ length: 7 }, (_, index) => (
          <mesh key={index} position={[0, 0.3 + index * 0.3, 0]} rotation={[Math.PI / 2, 0, 0]} material={matteMaterial(palette.woodLight)} castShadow>
            <cylinderGeometry args={[0.017, 0.017, 0.4, 8]} />
          </mesh>
        ))}
        {[-0.2, 0.2].map((dz) => (
          <mesh key={dz} position={[0, 0.03, dz]} material={matteMaterial("#2f2c2a")}>
            <sphereGeometry args={[0.035, 8, 6]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** The floor lamp's shade glows by its own emission: no light of its own, so nothing recompiles when it arrives. */
const nookShade = new MeshStandardMaterial({ color: palette.shade, emissive: "#ffc77a", emissiveIntensity: 0.55, roughness: ROUGHNESS, side: DoubleSide });

/** The reading nook in the front-left corner: an armchair, a floor lamp and a side table. */
/** The nook's armchair (the kit's read as a beanbag in one flat colour; these primitives keep its arms and cushion). */
function Armchair({ fabric }: { fabric: string }) {
  return (
    <>
      <Soft size={[0.72, 0.18, 0.66]} position={[0, 0.3, 0]} color={fabric} radius={0.06} />
      <Soft size={[0.62, 0.12, 0.56]} position={[0, 0.44, 0.04]} color="#c97a63" radius={0.05} />
      <Soft size={[0.72, 0.62, 0.16]} position={[0, 0.66, -0.27]} color={fabric} radius={0.07} />
      {[-1, 1].map((side) => (
        <Soft key={side} size={[0.13, 0.3, 0.62]} position={[side * 0.33, 0.52, 0.02]} color={fabric} radius={0.05} />
      ))}
      {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <Soft key={`${sx}:${sz}`} size={[0.05, 0.2, 0.05]} position={[sx * 0.3, 0.1, sz * 0.27]} color={palette.wood} radius={0.01} />))}
    </>
  );
}

function ReadingNook() {
  const [x, , z] = ANCHORS.floor;
  const fabric = "#b5654f";
  return (
    <group>
      <group position={[x, 0, z]} rotation={[0, Math.PI / 2 - 0.35, 0]}>
        <Armchair fabric={fabric} />
      </group>
      <group position={[x - 0.45, 0, z - 0.42]}>
        <mesh position={[0, 0.02, 0]} material={matteMaterial(palette.brass)} castShadow>
          <cylinderGeometry args={[0.14, 0.16, 0.04, 14]} />
        </mesh>
        <mesh position={[0, 0.78, 0]} material={matteMaterial(palette.brass)} castShadow>
          <cylinderGeometry args={[0.015, 0.015, 1.52, 8]} />
        </mesh>
        <mesh position={[0, 1.58, 0]} material={nookShade} castShadow>
          <cylinderGeometry args={[0.13, 0.22, 0.26, 16, 1, true]} />
        </mesh>
      </group>
      <group position={[x + 0.05, 0, z + 0.66]}>
        <mesh position={[0, 0.55, 0]} material={matteMaterial(palette.woodLight)} castShadow receiveShadow>
          <cylinderGeometry args={[0.22, 0.22, 0.04, 18]} />
        </mesh>
        <mesh position={[0, 0.27, 0]} material={matteMaterial(palette.wood)} castShadow>
          <cylinderGeometry args={[0.03, 0.05, 0.54, 8]} />
        </mesh>
        <Soft size={[0.16, 0.04, 0.22]} position={[-0.04, 0.59, 0.02]} color="#3f6fb0" radius={0.006} />
        <mesh position={[0.1, 0.61, -0.06]} material={matteMaterial("#f3ead6")} castShadow>
          <cylinderGeometry args={[0.035, 0.03, 0.07, 10]} />
        </mesh>
      </group>
    </group>
  );
}

/** The window box outside the sill, a row of flowers in it; further out when the bay window stands there. */
function WindowBox({ bay }: { bay: boolean }) {
  const w = ROOM.window;
  const z = ROOM.back - (bay ? 0.78 : 0.4);
  const y = w.sill - 0.08;
  const flowers = ["#f2a7b8", "#f6d36b", "#f08c5a", "#c9a3e6", "#ffffff", "#f2a7b8", "#f08c5a", "#f6d36b", "#c9a3e6"];
  return (
    <group position={[w.x, y, z]}>
      <Soft size={[1.7, 0.16, 0.22]} position={[0, 0, 0]} color="#8a6a4f" radius={0.015} />
      <Soft size={[1.62, 0.04, 0.16]} position={[0, 0.07, 0]} color="#4b3a2c" radius={0.01} />
      {flowers.map((colour, index) => {
        const fx = -0.72 + index * 0.18;
        return (
          <group key={index} position={[fx, 0.09, (index % 2) * 0.05 - 0.02]}>
            <mesh position={[0, 0.06, 0]} material={matteMaterial("#5f9a4c")}>
              <icosahedronGeometry args={[0.06, 0]} />
            </mesh>
            <mesh position={[0.01, 0.13, 0.02]} material={matteMaterial(colour)}>
              <icosahedronGeometry args={[0.035, 0]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/** A wind chime hanging by the window's right edge, swinging gently. */
function WindChime({ reducedMotion }: { reducedMotion: boolean }) {
  const swing = useRef<Group>(null);
  useFrame(({ clock }) => {
    const node = swing.current;
    if (!node) return;
    const t = reducedMotion ? 0 : clock.elapsedTime;
    node.rotation.set(Math.sin(t * 0.8) * 0.05, 0, Math.sin(t * 1.1 + 1) * 0.07);
  });
  const w = ROOM.window;
  const tubes = [0.32, 0.26, 0.36, 0.22, 0.29];
  return (
    <group position={[w.x + w.width / 2 + 0.16, 2.42, ROOM.back + 0.2]}>
      <mesh position={[0, 0.06, 0]} material={matteMaterial("#2f2c2a")}>
        <cylinderGeometry args={[0.003, 0.003, 0.12, 4]} />
      </mesh>
      <group ref={swing}>
        <mesh material={matteMaterial(palette.wood)} castShadow>
          <cylinderGeometry args={[0.07, 0.07, 0.02, 12]} />
        </mesh>
        {tubes.map((length, index) => {
          const angle = (index / tubes.length) * Math.PI * 2;
          return (
            <mesh key={index} position={[Math.sin(angle) * 0.05, -0.04 - length / 2, Math.cos(angle) * 0.05]} material={matteMaterial("#c9cfd4")} castShadow>
              <cylinderGeometry args={[0.008, 0.008, length, 6]} />
            </mesh>
          );
        })}
        <mesh position={[0, -0.3, 0]} material={matteMaterial(palette.wood)}>
          <cylinderGeometry args={[0.025, 0.025, 0.012, 10]} />
        </mesh>
      </group>
    </group>
  );
}

/** A second rug in front of the shelving, round, in the room's other colour. */
function SecondRug() {
  return (
    <group position={[-2.6, 0, 0.75]} scale={[1, 1, 0.72]}>
      <mesh position={[0, 0.012, 0]} material={matteMaterial("#7d9bb5")} receiveShadow>
        <cylinderGeometry args={[0.78, 0.78, 0.024, 32]} />
      </mesh>
      <mesh position={[0, 0.015, 0]} material={matteMaterial("#e9dcc0")} receiveShadow>
        <cylinderGeometry args={[0.6, 0.6, 0.024, 32]} />
      </mesh>
      <mesh position={[0, 0.018, 0]} material={matteMaterial("#7d9bb5")} receiveShadow>
        <cylinderGeometry args={[0.38, 0.38, 0.024, 28]} />
      </mesh>
    </group>
  );
}

/** A cat asleep on Portal's chair, breathing slowly. */
function Cat({ reducedMotion }: { reducedMotion: boolean }) {
  const body = useRef<Group>(null);
  useFrame(({ clock }) => {
    const node = body.current;
    if (!node) return;
    node.scale.y = reducedMotion ? 1 : 1 + Math.sin(clock.elapsedTime * 1.6) * 0.04;
  });
  const fur = "#d98e4a";
  return (
    <group position={[CHAIR.x, CHAIR.seat - 0.01, CHAIR.z]} rotation={[0, CHAIR.turn + 0.65, 0]}>
      <group ref={body}>
        <mesh position={[0, 0.07, 0]} scale={[1.25, 0.7, 0.95]} material={matteMaterial(fur)} castShadow>
          <sphereGeometry args={[0.13, 14, 10]} />
        </mesh>
      </group>
      <mesh position={[0.15, 0.07, 0.06]} material={matteMaterial(fur)} castShadow>
        <sphereGeometry args={[0.07, 12, 9]} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[0.17, 0.135, 0.06 + side * 0.035]} rotation={[side * 0.3, 0, -0.3]} material={matteMaterial("#b8703a")}>
          <coneGeometry args={[0.022, 0.05, 4]} />
        </mesh>
      ))}
      <mesh position={[-0.04, 0.03, 0.12]} rotation={[Math.PI / 2, 0, 0.4]} material={matteMaterial("#b8703a")} castShadow>
        <torusGeometry args={[0.11, 0.022, 6, 14, Math.PI * 0.9]} />
      </mesh>
    </group>
  );
}

/**
 * The room's milestone furniture (docs/PALACE.md, Milestones): each reached milestone mounts its
 * piece. The tall and second bookcases and the wide pinboard hold the books' and notes' slots (the
 * small shelf and the corkboard they replace are drawn by `Books` and `Corkboard`); the bay window is
 * the `Window`'s. The rest: a rolling ladder, the reading nook, a window box, a wind chime, a second
 * rug and a sleeping cat. A just-reached milestone arrives in a crate (`useDeliveries`). No piece
 * adds a light: the floor lamp glows by emission, so the shader cache key never changes.
 */
export default function Milestones({ deliveries, reducedMotion }: { deliveries: Deliveries; reducedMotion: boolean }) {
  const { shown, revealedAt } = deliveries;
  const piece = (id: string, node: ReactNode) =>
    shown.has(id) ? (
      <Grow key={id} at={revealedAt[id]}>
        {node}
      </Grow>
    ) : null;
  return (
    <group>
      {piece("tall-bookcase", <Bookcase id="tall-bookcase" />)}
      {piece("second-bookcase", <Bookcase id="second-bookcase" />)}
      {piece("rolling-ladder", <Ladder />)}
      {piece("reading-nook", <ReadingNook />)}
      {piece("wide-pinboard", <CorkboardFrame width={PINBOARD.width} centre={PINBOARD.centre} />)}
      {piece("wall-map", <WallMap />)}
      {piece("window-box", <WindowBox bay={shown.has("bay-window")} />)}
      {piece("wind-chime", <WindChime reducedMotion={reducedMotion} />)}
      {piece(
        "second-rug",
        <>
          <SecondRug />
          <Cat reducedMotion={reducedMotion} />
        </>,
      )}
      <Crate deliveries={deliveries} />
    </group>
  );
}

/** A map on the left wall beside the board: a pale sea, two islands, a compass rose. */
function WallMap() {
  const z = PINBOARD.centre + PINBOARD.width / 2 + 0.6;
  const y = ANCHORS.board[1] - 0.05;
  const x = ROOM.left;
  return (
    <group position={[x, y, z]}>
      <Soft size={[0.03, 0.66, 0.96]} position={[0.015, 0, 0]} color={palette.wood} radius={0.008} />
      <Soft size={[0.02, 0.58, 0.88]} position={[0.03, 0, 0]} color="#e9dcbc" radius={0.004} />
      <mesh position={[0.042, 0.05, -0.18]} scale={[0.01, 0.16, 0.26]} material={matteMaterial("#8fb36a")}>
        <sphereGeometry args={[1, 12, 8]} />
      </mesh>
      <mesh position={[0.042, -0.12, 0.2]} scale={[0.01, 0.1, 0.16]} material={matteMaterial("#b5a06a")}>
        <sphereGeometry args={[1, 12, 8]} />
      </mesh>
      <mesh position={[0.044, 0.17, 0.3]} rotation={[0, Math.PI / 2, 0]} material={matteMaterial("#c8463c")}>
        <circleGeometry args={[0.05, 4]} />
      </mesh>
    </group>
  );
}
