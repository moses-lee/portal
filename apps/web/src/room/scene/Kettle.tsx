"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { IcosahedronGeometry, InstancedMesh, MeshBasicMaterial, Object3D } from "three";
import { STOVE } from "../layout";
import { Hotspot } from "./Hotspot";
import { markForUpload, matteMaterial } from "./materials";
import { Soft } from "./Shell";

const PUFFS = 6;
const IRON = "#3f3b39";
const KETTLE = "#5f9ea0";
const scratch = new Object3D();


/**
 * The kettle on a small stove by the hearth (docs/PALACE.md, Objects): it steams while one of
 * Portal's background jobs runs. The steam is a few soft puffs in one instanced mesh, rising and
 * fading (shrinking) in a loop; with no job they are scaled away but stay mounted, so the first
 * steam compiles nothing.
 */
export default function Kettle({ steaming, reducedMotion }: { steaming: boolean; reducedMotion: boolean }) {
  const steam = useMemo(() => {
    const mesh = new InstancedMesh(new IcosahedronGeometry(0.045, 1), new MeshBasicMaterial({ color: "#f4f1ec", transparent: true, opacity: 0.45, depthWrite: false }), PUFFS);
    mesh.frustumCulled = false;
    return mesh;
  }, []);
  useEffect(
    () => () => {
      steam.geometry.dispose();
      (steam.material as MeshBasicMaterial).dispose();
    },
    [steam],
  );

  useFrame((frame) => {
    const t = reducedMotion ? 0 : frame.clock.elapsedTime;
    for (let index = 0; index < PUFFS; index++) {
      // Each puff loops from the spout upwards, growing, then shrinking away as it fades.
      const phase = (t * 0.45 + index / PUFFS) % 1;
      const size = steaming ? (0.5 + phase * 1.8) * Math.sin(phase * Math.PI) : 1e-4;
      scratch.position.set(Math.sin(phase * 5 + index) * 0.04 + phase * 0.06, phase * 0.55, 0);
      scratch.scale.setScalar(Math.max(1e-4, size));
      scratch.updateMatrix();
      steam.setMatrixAt(index, scratch.matrix);
    }
    markForUpload(steam.instanceMatrix);
  });

  return (
    <group position={[STOVE.x, 0, STOVE.z]}>
      {/* The stove: an iron box on short legs, its pipe up and into the wall. */}
      <Soft size={[0.44, 0.36, 0.38]} position={[0, 0.3, 0]} color={IRON} radius={0.03} />
      <Soft size={[0.48, 0.03, 0.42]} position={[0, 0.495, 0]} color="#2f2c2a" radius={0.01} />
      <Soft size={[0.18, 0.1, 0.02]} position={[0, 0.27, 0.195]} color="#c46a3a" radius={0.008} />
      {[-0.17, 0.17].flatMap((x) =>
        [-0.13, 0.13].map((z) => <Soft key={`${x}:${z}`} size={[0.05, 0.12, 0.05]} position={[x, 0.06, z]} color={IRON} radius={0.01} />),
      )}
      <mesh position={[0.12, 0.98, -0.08]} material={matteMaterial(IRON)} castShadow>
        <cylinderGeometry args={[0.045, 0.045, 0.96, 10]} />
      </mesh>
      <mesh position={[0.12, 1.46, -0.08]} material={matteMaterial(IRON)} castShadow>
        <sphereGeometry args={[0.05, 10, 8]} />
      </mesh>
      <mesh position={[0.12, 1.46, -0.2]} rotation={[Math.PI / 2, 0, 0]} material={matteMaterial(IRON)} castShadow>
        <cylinderGeometry args={[0.045, 0.045, 0.24, 10]} />
      </mesh>
      {/* The kettle. */}
      <group position={[-0.05, 0.51, 0.02]}>
        <mesh position={[0, 0.09, 0]} scale={[1, 0.8, 1]} material={matteMaterial(KETTLE)} castShadow>
          <sphereGeometry args={[0.11, 14, 10]} />
        </mesh>
        <mesh position={[0, 0.18, 0]} material={matteMaterial("#2f2c2a")} castShadow>
          <sphereGeometry args={[0.022, 8, 6]} />
        </mesh>
        <mesh position={[0.12, 0.12, 0]} rotation={[0, 0, -0.9]} material={matteMaterial(KETTLE)} castShadow>
          <cylinderGeometry args={[0.012, 0.022, 0.12, 8]} />
        </mesh>
        <mesh position={[0, 0.17, 0]} material={matteMaterial("#2f2c2a")}>
          <torusGeometry args={[0.07, 0.008, 6, 16, Math.PI]} />
        </mesh>
        <primitive object={steam} position={[0.17, 0.18, 0]} />
      </group>
      <Hotspot kind="kettle" size={[0.6, 1.0, 0.55]} position={[0, 0.5, 0.02]} />
    </group>
  );
}
