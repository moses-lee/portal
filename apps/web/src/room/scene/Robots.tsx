"use client";

import { memo, useEffect, useMemo, useRef, useState, type FC, type RefAttributes } from "react";
import { Merged, type InstanceProps } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type Group,
  type Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { agentBadge, robotLook, robotSpot, SPOTS, type RobotCrowd, type RobotSpec } from "../live";
import { waveStartedAt } from "../pointer";
import { Hotspot } from "./Hotspot";
import { matteMaterial, palette, ROUGHNESS } from "./materials";

/** Metres per second on foot; a robot leaving takes `LEAVE_S` whatever the distance. */
const WALK = 1.1;
const LEAVE_S = 1.5;
/** Robots that appear later than this after the canvas mounted walk in through the door; earlier ones were already here. */
const SETTLE_MS = 1500;
/** Robots still walking out are capped, so a mass purge does not file out forever. */
const MAX_LEAVING = 8;
/** Part instances per kind (two eyes, arms and legs a robot): room for twenty robots. */
const LIMIT = 48;
const TIP = 1.45;
/** The robots' size: the parts below are modelled at 1, a toy about half a metre tall. */
const SCALE = 1.2;

/** A robot's parts, each one instanced across every robot (one draw call per part). */
function createParts() {
  const white = new MeshStandardMaterial({ color: "#ffffff", roughness: ROUGHNESS, metalness: 0 });
  const glow = new MeshBasicMaterial({ color: "#ffffff" });
  const capsule = (radius: number, length: number) => new CapsuleGeometry(radius, length, 3, 8);
  return {
    body: new Mesh(new RoundedBoxGeometry(0.26, 0.24, 0.2, 2, 0.05), white),
    headBox: new Mesh(new RoundedBoxGeometry(0.24, 0.18, 0.18, 2, 0.05), white),
    headBall: new Mesh(new SphereGeometry(0.12, 14, 10), white),
    headCan: new Mesh(new CylinderGeometry(0.1, 0.1, 0.17, 14), white),
    eye: new Mesh(new SphereGeometry(0.022, 8, 6), glow),
    arm: new Mesh(capsule(0.032, 0.11), white),
    leg: new Mesh(capsule(0.042, 0.08), white),
    stem: new Mesh(new CylinderGeometry(0.008, 0.008, 0.1, 6), white),
    tip: new Mesh(new SphereGeometry(0.026, 8, 6), glow),
    badge: new Mesh(new CylinderGeometry(0.036, 0.036, 0.012, 12), white),
    scarf: new Mesh(new TorusGeometry(0.11, 0.03, 6, 16), white),
    stick: new Mesh(new CylinderGeometry(0.009, 0.009, 0.3, 6), white),
    board: new Mesh(new BoxGeometry(0.2, 0.14, 0.014), white),
    mark: new Mesh(new BoxGeometry(0.024, 0.07, 0.006), white),
    dot: new Mesh(new BoxGeometry(0.024, 0.024, 0.006), white),
    spark: new Mesh(new IcosahedronGeometry(0.035, 0), glow),
  };
}
type PartName = keyof ReturnType<typeof createParts>;
type Instanced = Object3D & { color: Color };
/** `Merged`'s components, one per part; each is drei's forwarded-ref `Instance`. */
type Parts = Record<PartName, FC<InstanceProps & RefAttributes<Instanced>>>;

const WHITE = new Color("#ffffff");
const LIMB = new Color("#8d939c");
const EYE = new Color("#23272d");
const EYE_ON = new Color("#8ff1ff");
const SPARK = new Color("#ffe066");
const BOARD = new Color("#fff3c4");
const MARK = new Color("#c8463c");
const STICK = new Color(palette.woodLight);

/** Head heights: the top of each head shape, and how far forward its eyes sit. */
const HEADS = [
  { top: 0.62, eyeZ: 0.092 },
  { top: 0.65, eyeZ: 0.112 },
  { top: 0.615, eyeZ: 0.102 },
] as const;
const HEAD_Y = 0.53;

type Motion = {
  x: number;
  z: number;
  heading: number;
  tip: number;
  path: [number, number][];
  speed: number;
  goalX: number;
  goalZ: number;
  leaving: boolean;
};

/** Turn `from` towards `to` (radians) by at most `step`, the short way round. */
function turn(from: number, to: number, step: number): number {
  let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) <= step ? to : from + Math.sign(diff) * step;
}

/** The path from (`x`, `z`) out through the door, as a list of floor points. */
const leavePath = (): [number, number][] => [
  [SPOTS.inside[0], SPOTS.inside[1]],
  [SPOTS.outside[0], SPOTS.outside[1]],
];

const Robot = memo(function Robot({
  spec,
  leaving,
  parts,
  bornAt,
  reducedMotion,
  onGone,
}: {
  spec: RobotSpec;
  leaving: boolean;
  parts: Parts;
  bornAt: number;
  reducedMotion: boolean;
  onGone: (id: string) => void;
}) {
  const look = useMemo(() => robotLook(spec.id), [spec.id]);
  const colours = useMemo(() => {
    const body = new Color(look.body);
    return {
      body,
      head: body.clone().lerp(WHITE, 0.35),
      limb: body.clone().lerp(LIMB, 0.6),
      tip: new Color(look.tip),
      scarf: new Color(look.scarf),
      badge: new Color(agentBadge(spec.agentId)),
    };
  }, [look, spec.agentId]);
  const head = HEADS[look.head];
  const [goalX, goalZ] = robotSpot(spec.place, spec.slot);

  const root = useRef<Group>(null);
  const armLeft = useRef<Group>(null);
  const armRight = useRef<Group>(null);
  const legLeft = useRef<Group>(null);
  const legRight = useRef<Group>(null);
  const eyeLeft = useRef<Instanced>(null);
  const eyeRight = useRef<Instanced>(null);
  const spark = useRef<Group>(null);
  const motion = useRef<Motion | null>(null);
  const gone = useRef(false);

  useFrame((state, rawDelta) => {
    const node = root.current;
    if (!node) return;
    const delta = Math.min(0.1, Math.max(0, rawDelta));
    const t = state.clock.elapsedTime;
    let m = motion.current;
    if (!m) {
      // Already here when the room opened: in place. Arriving later, or connecting: in through the door.
      const walkIn = !reducedMotion && (spec.state === "connecting" || performance.now() - bornAt > SETTLE_MS);
      m = {
        x: walkIn ? SPOTS.outside[0] : goalX,
        z: walkIn ? SPOTS.outside[1] : goalZ,
        heading: walkIn ? Math.PI : 0,
        tip: 0,
        path: walkIn ? [[SPOTS.inside[0], SPOTS.inside[1]], [goalX, goalZ]] : [],
        speed: WALK,
        goalX,
        goalZ,
        leaving: false,
      };
      motion.current = m;
    }
    if (leaving && !m.leaving) {
      m.leaving = true;
      m.path = leavePath();
      const length = Math.hypot(m.path[0][0] - m.x, m.path[0][1] - m.z) + Math.hypot(m.path[1][0] - m.path[0][0], m.path[1][1] - m.path[0][1]);
      m.speed = length / LEAVE_S;
    } else if (!leaving && (m.leaving || m.goalX !== goalX || m.goalZ !== goalZ)) {
      // A new slot, or the session came back while its robot was on the way out.
      m.leaving = false;
      gone.current = false;
      m.goalX = goalX;
      m.goalZ = goalZ;
      m.path = [[goalX, goalZ]];
      m.speed = WALK;
    }
    if (reducedMotion) {
      // No walking: robots stand where they belong, and a leaving one is simply gone.
      if (m.path.length) {
        const [x, z] = m.path[m.path.length - 1];
        m.x = x;
        m.z = z;
        m.path.length = 0;
      }
    }

    let moving = false;
    if (m.path.length) {
      const [px, pz] = m.path[0];
      const dx = px - m.x;
      const dz = pz - m.z;
      const distance = Math.hypot(dx, dz);
      const step = m.speed * delta;
      if (distance <= step) {
        m.x = px;
        m.z = pz;
        m.path.shift();
      } else {
        m.x += (dx / distance) * step;
        m.z += (dz / distance) * step;
      }
      if (distance > 0.01) m.heading = turn(m.heading, Math.atan2(dx, dz), delta * 9);
      moving = true;
    }
    if (m.leaving && !m.path.length) {
      if (!gone.current) {
        gone.current = true;
        onGone(spec.id);
      }
      return;
    }

    const mode = spec.state;
    const settled = !moving;
    if (settled) {
      // By the door and in the queue they face the camera; at the bench, the bench.
      const facing = spec.place === "bench" ? 0 : Math.atan2(state.camera.position.x - m.x, state.camera.position.z - m.z);
      m.heading = reducedMotion ? facing : turn(m.heading, facing, delta * 6);
    }
    const tipTarget = settled && mode === "hung" ? 1 : 0;
    const tipBefore = m.tip;
    m.tip = reducedMotion ? tipTarget : m.tip + (tipTarget - m.tip) * Math.min(1, delta * 5);
    const bob = moving && !reducedMotion ? Math.abs(Math.sin(t * 12)) * 0.02 : 0;
    node.position.set(m.x, (m.tip * 0.13 + bob) * SCALE, m.z);
    // A hung robot tips over onto its back, away from the bench.
    node.rotation.set(-m.tip * TIP, m.heading, 0, "YXZ");
    if (moving || Math.abs(m.tip - tipBefore) > 1e-4) state.gl.shadowMap.needsUpdate = true;

    // Arms and legs.
    const left = armLeft.current;
    const right = armRight.current;
    const legL = legLeft.current;
    const legR = legRight.current;
    if (left && right && legL && legR) {
      const now = performance.now();
      const wave = waveStartedAt(spec.id, now);
      let swing = 0;
      if (moving && !reducedMotion) swing = Math.sin(t * 12) * 0.6;
      legL.rotation.x = swing * 0.8;
      legR.rotation.x = -swing * 0.8;
      if (moving) {
        left.rotation.set(-swing, 0, 0);
        right.rotation.set(swing, 0, 0);
      } else if (mode === "working" || mode === "background") {
        const rate = mode === "working" ? 8 : 3;
        const reach = reducedMotion ? 0 : mode === "working" ? 0.45 : 0.22;
        left.rotation.set(-0.95 + Math.sin(t * rate) * reach, 0, 0);
        right.rotation.set(-0.95 + Math.sin(t * rate + Math.PI) * reach, 0, 0);
      } else if (mode === "approval") {
        left.rotation.set(0, 0, 0.12);
        right.rotation.set(0, 0, -2.5 + (reducedMotion ? 0 : Math.sin(t * 2.2) * 0.08));
      } else {
        left.rotation.set(0, 0, 0.12);
        right.rotation.set(0, 0, -0.12);
      }
      if (wave !== null) {
        const k = (now - wave) / 600;
        right.rotation.set(0, 0, -2.7 + Math.sin(k * Math.PI * 6) * 0.35);
      }
    }

    // Eyes: a boot blink while connecting. The spark: a hung robot's blinking point.
    const lit = mode === "connecting" && (reducedMotion || t * 4 - Math.floor(t * 4) < 0.5);
    eyeLeft.current?.color.copy(lit ? EYE_ON : EYE);
    eyeRight.current?.color.copy(lit ? EYE_ON : EYE);
    const sparkNode = spark.current;
    if (sparkNode) {
      const on = mode === "hung" && settled && (reducedMotion || Math.sin(t * 11) + Math.sin(t * 4.3) > 0.4);
      sparkNode.scale.setScalar(on ? 1 : 1e-4);
    }
  });

  const P = parts;
  const stem = (key: string, x: number, lean: number) => (
    <group key={key} position={[x, head.top, 0]} rotation={[0, 0, lean]}>
      <P.stem position={[0, 0.05, 0]} color={LIMB} />
      <P.tip position={[0, 0.1, 0]} color={colours.tip} />
    </group>
  );
  return (
    <group ref={root} scale={SCALE}>
      <group ref={legLeft} position={[0.07, 0.17, 0]}>
        <P.leg position={[0, -0.08, 0]} color={colours.limb} />
      </group>
      <group ref={legRight} position={[-0.07, 0.17, 0]}>
        <P.leg position={[0, -0.08, 0]} color={colours.limb} />
      </group>
      <P.body position={[0, 0.3, 0]} color={colours.body} />
      <P.badge position={[0.06, 0.34, 0.102]} rotation={[Math.PI / 2, 0, 0]} color={colours.badge} />
      {look.head === 0 && <P.headBox position={[0, HEAD_Y, 0]} color={colours.head} />}
      {look.head === 1 && <P.headBall position={[0, HEAD_Y, 0]} color={colours.head} />}
      {look.head === 2 && <P.headCan position={[0, HEAD_Y, 0]} color={colours.head} />}
      <P.eye ref={eyeLeft} position={[0.05, HEAD_Y + 0.01, head.eyeZ]} color={EYE} />
      <P.eye ref={eyeRight} position={[-0.05, HEAD_Y + 0.01, head.eyeZ]} color={EYE} />
      {look.antenna === 0 && stem("a", 0, 0)}
      {look.antenna === 1 && [stem("l", 0.05, -0.35), stem("r", -0.05, 0.35)]}
      {look.antenna === 2 && stem("b", 0.03, -0.55)}
      {spec.tracked && <P.scarf position={[0, 0.44, 0]} rotation={[Math.PI / 2, 0, 0]} color={colours.scarf} />}
      <group ref={armLeft} position={[0.165, 0.39, 0]}>
        <P.arm position={[0, -0.075, 0]} color={colours.limb} />
      </group>
      <group ref={armRight} position={[-0.165, 0.39, 0]}>
        <P.arm position={[0, -0.075, 0]} color={colours.limb} />
        {spec.state === "approval" && (
          // The sign, held up in the raised hand and kept upright against the arm's angle.
          <group position={[0, -0.16, 0]} rotation={[0, 0, 2.5]}>
            <P.stick position={[0, 0.15, 0]} color={STICK} />
            <group position={[0, 0.36, 0]}>
              <P.board color={BOARD} />
              <P.mark position={[0, 0.015, 0.009]} color={MARK} />
              <P.dot position={[0, -0.045, 0.009]} color={MARK} />
            </group>
          </group>
        )}
      </group>
      {spec.state === "hung" && (
        <group ref={spark} position={[0.1, head.top, 0.06]}>
          <P.spark color={SPARK} />
        </group>
      )}
      {!leaving && <Hotspot kind="robot" id={spec.id} size={[0.42, 0.78, 0.36]} position={[0, 0.38, 0]} />}
    </group>
  );
});

/** The tiny workbench on the rug where working robots stand. */
function Bench() {
  const [x, z] = SPOTS.bench;
  const wood = matteMaterial(palette.woodLight);
  const legs: [number, number][] = [
    [-1.38, -0.12],
    [1.38, -0.12],
    [-1.38, 0.12],
    [1.38, 0.12],
  ];
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.25, 0]} material={wood} castShadow receiveShadow>
        <boxGeometry args={[2.9, 0.045, 0.34]} />
      </mesh>
      {legs.map(([lx, lz]) => (
        <mesh key={`${lx}:${lz}`} position={[lx, 0.115, lz]} material={matteMaterial(palette.wood)} castShadow>
          <boxGeometry args={[0.05, 0.23, 0.05]} />
        </mesh>
      ))}
      {/* A few parts and a toolbox on the bench. */}
      <mesh position={[-0.9, 0.31, 0.02]} material={matteMaterial(palette.chair)} castShadow>
        <boxGeometry args={[0.2, 0.08, 0.12]} />
      </mesh>
      <mesh position={[0.6, 0.29, -0.03]} material={matteMaterial(palette.brass)} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.05, 10]} />
      </mesh>
    </group>
  );
}

/**
 * The toy robots (docs/PALACE.md, Objects): one per active session, from `placeRobots`. Every part
 * is instanced across all robots (drei `Merged`), coloured per instance from the session id's hash.
 * Robots walk between the door and their slots along hand-written waypoints, interpolated every frame
 * in the capped loop; a robot whose session finished or went away walks out of the door over 1.5 s
 * and is gone. Under reduced motion they stand still where they belong.
 */
export default function Robots({ crowd, reducedMotion }: { crowd: RobotCrowd; reducedMotion: boolean }) {
  const parts = useMemo(() => createParts(), []);
  useEffect(
    () => () => {
      for (const mesh of Object.values(parts)) mesh.geometry.dispose();
      parts.body.material.dispose();
      parts.eye.material.dispose();
    },
    [parts],
  );
  const [bornAt] = useState(() => performance.now());

  // Robots whose session left the crowd keep walking out until they reach the hallway.
  const [previous, setPrevious] = useState(crowd.robots);
  const [leaving, setLeaving] = useState<RobotSpec[]>([]);
  if (previous !== crowd.robots) {
    const present = new Set(crowd.robots.map((robot) => robot.id));
    const gone = reducedMotion ? [] : previous.filter((robot) => !present.has(robot.id));
    setPrevious(crowd.robots);
    setLeaving((current) => [...current.filter((robot) => !present.has(robot.id)), ...gone].slice(-MAX_LEAVING));
  }
  const onGone = useMemo(() => (id: string) => setLeaving((current) => current.filter((robot) => robot.id !== id)), []);

  return (
    <group>
      <Bench />
      <Merged meshes={parts} limit={LIMIT} castShadow receiveShadow frustumCulled={false}>
        {(merged) => {
          const instances = merged as unknown as Parts;
          return (
          <>
            {/* One list keyed by session, so a robot that starts to leave keeps its place and pose. */}
            {[...crowd.robots.map((spec) => [spec, false] as const), ...leaving.map((spec) => [spec, true] as const)].map(([spec, gone]) => (
              <Robot key={spec.id} spec={spec} leaving={gone} parts={instances} bornAt={bornAt} reducedMotion={reducedMotion} onGone={onGone} />
            ))}
          </>
          );
        }}
      </Merged>
    </group>
  );
}
