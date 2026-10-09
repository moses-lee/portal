"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { BoxGeometry, Color, InstancedMesh, Object3D, TorusGeometry } from "three";
import { hashId } from "@portal/shared/room";
import { KEY_CAP } from "../growth";
import { furniture, placeItems } from "../layout-slots";
import { Hotspot } from "./Hotspot";
import { markForUpload, matteMaterial, palette, setDrawCount } from "./materials";
import { Soft } from "./Shell";

const METALS = ["#c9a46a", "#d8b878", "#b38b4d", "#bfc3c7", "#a87a52"] as const;
const scratch = new Object3D();
const tint = new Color();

/**
 * The key rack by the door (docs/PALACE.md, Objects): one key per standing approval grant, eight
 * hooks, the rest counted in the card. The census gives a count, so each key's slot and metal come
 * from its place in the count (`key:<n>`). Bows, shafts and bits are three instanced meshes.
 */
export default function Keys({ count }: { count: number }) {
  const get = useThree((state) => state.get);
  const rack = furniture("key-rack");
  const rig = useMemo(() => {
    const white = matteMaterial("#ffffff");
    const meshes = [
      new InstancedMesh(new TorusGeometry(0.016, 0.005, 6, 14), white, KEY_CAP),
      new InstancedMesh(new BoxGeometry(0.007, 0.07, 0.005), white, KEY_CAP),
      new InstancedMesh(new BoxGeometry(0.016, 0.012, 0.005), white, KEY_CAP),
    ];
    for (const mesh of meshes) {
      for (let index = 0; index < KEY_CAP; index++) mesh.setColorAt(index, tint.set(METALS[0]));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
    }
    return meshes;
  }, []);
  useEffect(
    () => () => {
      for (const mesh of rig) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    },
    [rig],
  );

  useLayoutEffect(() => {
    const [bows, shafts, bits] = rig;
    const ids = Array.from({ length: Math.min(KEY_CAP, count) }, (_, index) => `key:${index}`);
    const { placed } = placeItems(ids, [rack], { unit: "piece" });
    placed.forEach((place, index) => {
      const [x, y, z] = place.position;
      const metal = tint.set(METALS[hashId(place.id, 101) % METALS.length]);
      const hang = ((hashId(place.id, 103) % 9) - 4) * 0.02;
      const put = (mesh: InstancedMesh, dx: number, dy: number) => {
        scratch.position.set(x + dx, y + dy, z + 0.012);
        scratch.rotation.set(0, 0, hang);
        scratch.updateMatrix();
        mesh.setMatrixAt(index, scratch.matrix);
        mesh.setColorAt(index, metal);
      };
      put(bows, 0, -0.035);
      put(shafts, 0, -0.085);
      put(bits, 0.009, -0.11);
    });
    for (const mesh of rig) {
      setDrawCount(mesh, placed.length);
      markForUpload(mesh.instanceMatrix);
      markForUpload(mesh.instanceColor);
    }
    get().gl.shadowMap.needsUpdate = true;
  }, [rig, rack, count, get]);

  const [x0, y, z] = rack.rows[0];
  const centre = x0 + (rack.pitch[0] * (rack.perRow - 1)) / 2;
  const width = rack.pitch[0] * rack.perRow + 0.06;
  return (
    <group>
      <Soft size={[width, 0.07, 0.025]} position={[centre, y + 0.01, z - 0.025]} color={palette.wood} radius={0.008} />
      {Array.from({ length: rack.perRow }, (_, index) => (
        <mesh key={index} position={[x0 + rack.pitch[0] * index, y - 0.012, z]} rotation={[Math.PI / 2, 0, 0]} material={matteMaterial(palette.brass)} castShadow>
          <cylinderGeometry args={[0.005, 0.005, 0.03, 6]} />
        </mesh>
      ))}
      <primitive object={rig[0]} />
      <primitive object={rig[1]} />
      <primitive object={rig[2]} />
      <Hotspot kind="key" id="rack" size={[width + 0.06, 0.26, 0.2]} position={[centre, y - 0.06, z + 0.04]} priority={1} />
    </group>
  );
}
