"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, ConeGeometry, IcosahedronGeometry, InstancedMesh, MeshBasicMaterial, Object3D, type PointLight } from "three";
import type { HearthLevel } from "../live";
import { ROOM } from "../layout";
import { Hotspot } from "./Hotspot";
import { markForUpload, matteMaterial } from "./materials";

/** The point light's intensity for each level: none when cold. */
const LIGHT: Record<HearthLevel, number> = { cold: 0, embers: 0.6, fire: 1.9 };

const FLAMES = [
  { x: -0.13, z: 0.02, height: 0.75, rate: 9.1, colour: "#ff7a2e" },
  { x: -0.04, z: -0.02, height: 1.05, rate: 7.3, colour: "#ff9a3c" },
  { x: 0.05, z: 0.01, height: 0.9, rate: 8.4, colour: "#ffb347" },
  { x: 0.14, z: -0.01, height: 0.7, rate: 10.2, colour: "#ff7a2e" },
  { x: 0.0, z: 0.03, height: 0.55, rate: 11.7, colour: "#ffe08a" },
] as const;
const EMBERS = [
  [-0.18, 0.03],
  [-0.1, 0.07],
  [-0.02, 0.04],
  [0.06, 0.08],
  [0.13, 0.03],
  [0.19, 0.06],
  [0.02, -0.02],
  [-0.14, -0.01],
] as const;

const ASH = new Color("#4a403a");
const EMBER = new Color("#ff5a1f");
const scratch = new Object3D();
const tint = new Color();

/**
 * The fire in the hearth (docs/PALACE.md, Objects), from the census's `activityLastHour`: cold
 * (grey ash) under 3 entries, glowing embers up to 20, a full fire past that. The flames are a few
 * low-poly cones in one instanced mesh whose heights cycle like a flipbook; the embers another,
 * their glow pulsing through per-instance colour. The hearth's point light (mounted from the start)
 * follows the level.
 */
export default function Hearth({ level, reducedMotion }: { level: HearthLevel; reducedMotion: boolean }) {
  const { hearth, back } = ROOM;
  const front = back + hearth.depth;
  const light = useRef<PointLight>(null);
  const rig = useMemo(() => {
    const glow = new MeshBasicMaterial({ color: "#ffffff" });
    const flames = new InstancedMesh(new ConeGeometry(0.075, 0.3, 6), glow, FLAMES.length);
    const embers = new InstancedMesh(new IcosahedronGeometry(0.035, 0), glow, EMBERS.length);
    FLAMES.forEach((flame, index) => flames.setColorAt(index, tint.set(flame.colour)));
    EMBERS.forEach((_, index) => embers.setColorAt(index, ASH));
    for (const mesh of [flames, embers]) mesh.frustumCulled = false;
    return { glow, flames, embers };
  }, []);
  useEffect(
    () => () => {
      rig.flames.geometry.dispose();
      rig.embers.geometry.dispose();
      rig.glow.dispose();
    },
    [rig],
  );
  const strength = useRef(LIGHT[level]);

  useFrame((frame, rawDelta) => {
    const delta = Math.min(0.1, Math.max(0, rawDelta));
    const t = reducedMotion ? 0 : frame.clock.elapsedTime;
    const fire = level === "fire";
    const lit = level !== "cold";
    for (let index = 0; index < FLAMES.length; index++) {
      const flame = FLAMES[index];
      // A flipbook of heights: each flame jumps between a few sizes rather than easing smoothly.
      const step = Math.floor(t * flame.rate) % 4;
      const height = fire ? flame.height * (0.75 + 0.12 * step) : 1e-4;
      scratch.position.set(flame.x, 0.12 + 0.15 * height, flame.z);
      scratch.rotation.set(0, step * 0.8, fire && !reducedMotion ? Math.sin(t * 3 + index) * 0.08 : 0);
      scratch.scale.set(fire ? 1 : 1e-4, height, fire ? 1 : 1e-4);
      scratch.updateMatrix();
      rig.flames.setMatrixAt(index, scratch.matrix);
    }
    markForUpload(rig.flames.instanceMatrix);
    for (let index = 0; index < EMBERS.length; index++) {
      const [x, z] = EMBERS[index];
      scratch.position.set(x, 0.065, z);
      scratch.rotation.set(index, index * 2, 0);
      scratch.scale.set(1, 0.7, 1);
      scratch.updateMatrix();
      rig.embers.setMatrixAt(index, scratch.matrix);
      const pulse = lit ? 0.55 + 0.45 * Math.sin(t * (1.3 + index * 0.37) + index * 2.1) ** 2 : 0;
      rig.embers.setColorAt(index, tint.copy(ASH).lerp(EMBER, pulse));
    }
    markForUpload(rig.embers.instanceMatrix);
    markForUpload(rig.embers.instanceColor);

    const target = LIGHT[level];
    strength.current += (target - strength.current) * (reducedMotion ? 1 : Math.min(1, delta * 2));
    const flicker = fire && !reducedMotion ? 1 + 0.12 * Math.sin(t * 17) * Math.sin(t * 6.1) : lit && !reducedMotion ? 1 + 0.08 * Math.sin(t * 2.4) : 1;
    if (light.current) light.current.intensity = strength.current * flicker;
  });

  return (
    <group position={[hearth.x, 0.05, front + 0.17]}>
      {/* Two logs, crossed. */}
      <mesh position={[0, 0.045, 0.02]} rotation={[0, 0.25, Math.PI / 2]} material={matteMaterial("#5b3a26")} castShadow>
        <capsuleGeometry args={[0.045, 0.38, 3, 8]} />
      </mesh>
      <mesh position={[0, 0.07, -0.03]} rotation={[0, -0.3, Math.PI / 2]} material={matteMaterial("#6b4630")} castShadow>
        <capsuleGeometry args={[0.04, 0.34, 3, 8]} />
      </mesh>
      <primitive object={rig.embers} />
      <primitive object={rig.flames} />
      <pointLight ref={light} position={[0, 0.3, 0.08]} color="#ff9a4d" intensity={LIGHT[level]} distance={4} decay={2} />
      <Hotspot kind="hearth" size={[1.3, 1.15, 0.6]} position={[0, 0.5, 0]} />
    </group>
  );
}
