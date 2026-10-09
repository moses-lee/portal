"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, ConeGeometry, CylinderGeometry, Euler, IcosahedronGeometry, InstancedMesh, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { hashId, mulberry32 } from "@portal/shared/room";
import { SILL_CAP, STAND_CAP, standPlant, type PlantSpec } from "../growth";
import { furniture, placeItems, placeRemembered } from "../layout-slots";
import { InstancedHotspot, type HotspotSpot } from "./Hotspot";
import { markForUpload, matteMaterial, palette, setDrawCount } from "./materials";
import { Soft } from "./Shell";

const PLANTS = SILL_CAP + STAND_CAP;
/** Foliage parts per plant at most (a fern's fronds), blooms at most five. */
const LEAVES = PLANTS * 7;
const BUSHES = PLANTS * 3;
const BLOOMS = PLANTS * 5;
const POT_HEIGHT = 0.1;
const GREENS = ["#5f9a4c", "#78a85a", "#4c8a5e", "#8fb36a"] as const;

const scratch = new Object3D();
const tint = new Color();
const sway = new Euler();
const turn = new Quaternion();
const pivot = new Vector3();
const ONE = new Vector3(1, 1, 1);
const world = new Matrix4();

/** One foliage or bloom part: its transform relative to the plant's pot top, and which plant it sways with. */
type Part = { local: Matrix4; plant: number };

/** A plant's foliage (bushes, leaves) and blooms, by species, relative to the pot's top. */
function plantParts(plant: PlantSpec, index: number) {
  const random = mulberry32(hashId(plant.id, 83));
  const local = (x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number) => {
    scratch.position.set(x, y, z);
    scratch.rotation.set(rx, ry, rz);
    scratch.scale.set(sx, sy, sz);
    scratch.updateMatrix();
    return { local: scratch.matrix.clone(), plant: index };
  };
  const leaves: Part[] = [];
  const bushes: Part[] = [];
  const tips: [number, number, number][] = [];
  switch (plant.species) {
    case 0: {
      // A round bush: one big ball and two small ones.
      bushes.push(local(0, 0.07, 0, random(), random(), 0, 1, 0.9, 1));
      bushes.push(local(0.05, 0.04, 0.02, random(), random(), 0, 0.55, 0.55, 0.55));
      bushes.push(local(-0.045, 0.05, -0.02, random(), random(), 0, 0.6, 0.6, 0.6));
      tips.push([0.03, 0.13, 0.04], [-0.04, 0.11, 0.03], [0.05, 0.09, -0.03], [-0.02, 0.14, -0.03], [0.0, 0.15, 0.0]);
      break;
    }
    case 1: {
      // A succulent: five short leaves splayed in a rosette.
      for (let leaf = 0; leaf < 5; leaf++) {
        const angle = (leaf / 5) * Math.PI * 2 + random() * 0.3;
        leaves.push(local(Math.sin(angle) * 0.025, 0.04, Math.cos(angle) * 0.025, Math.cos(angle) * 0.7, 0, -Math.sin(angle) * 0.7, 1.1, 0.6, 1.1));
      }
      tips.push([0, 0.08, 0], [0.03, 0.06, 0.02], [-0.03, 0.06, -0.01], [0.01, 0.07, -0.03], [-0.02, 0.07, 0.03]);
      break;
    }
    case 2: {
      // A snake plant: four tall blades.
      for (let leaf = 0; leaf < 4; leaf++) {
        const angle = (leaf / 4) * Math.PI * 2 + random();
        leaves.push(local(Math.sin(angle) * 0.015, 0.12, Math.cos(angle) * 0.015, Math.cos(angle) * 0.12, angle, -Math.sin(angle) * 0.12, 0.7, 1.7 + random() * 0.4, 0.45));
      }
      tips.push([0.01, 0.26, 0], [-0.015, 0.24, 0.01], [0.0, 0.22, -0.015], [0.02, 0.2, 0.01], [-0.01, 0.27, -0.01]);
      break;
    }
    default: {
      // A fern: six fronds arching out.
      for (let leaf = 0; leaf < 6; leaf++) {
        const angle = (leaf / 6) * Math.PI * 2 + random() * 0.4;
        leaves.push(local(Math.sin(angle) * 0.05, 0.05, Math.cos(angle) * 0.05, Math.cos(angle) * 1.05, 0, -Math.sin(angle) * 1.05, 1.0, 1.2, 0.5));
      }
      tips.push([0.07, 0.07, 0.0], [-0.06, 0.07, 0.03], [0.0, 0.08, 0.07], [0.03, 0.08, -0.06], [-0.04, 0.09, -0.04]);
    }
  }
  const blooms = tips.slice(0, plant.blooms).map(([x, y, z]) => local(x, y, z, random(), random(), 0, 1, 1, 1));
  return { leaves, bushes, blooms, green: GREENS[hashId(plant.id, 89) % GREENS.length] };
}

/** The plant stand by the hearth: two tiers on four legs. */
function Stand() {
  const piece = furniture("plant-stand");
  const [x0, , z] = piece.rows[0];
  const x = x0 + (piece.pitch[0] * (piece.perRow - 1)) / 2;
  const width = piece.pitch[0] * piece.perRow + 0.04;
  return (
    <group position={[x, 0, z]}>
      {piece.rows.map(([, y]) => (
        <Soft key={y} size={[width, 0.03, 0.26]} position={[0, y - 0.015, 0]} color={palette.woodLight} radius={0.01} />
      ))}
      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => <Soft key={`${sx}:${sz}`} size={[0.03, 0.86, 0.03]} position={[(sx * width) / 2 - sx * 0.02, 0.43, (sz * 0.26) / 2 - sz * 0.02]} color={palette.wood} radius={0.008} />),
      )}
    </group>
  );
}

/**
 * The plants (docs/PALACE.md, Objects): one per active watch on the window sill, its species, pot
 * and bloom colour from the watch's id and a bloom per fire up to five; finished watches' plants on
 * the stand by the hearth; six on the sill and eight on the stand, the rest counted in the card.
 * Pots, bushes, leaves and blooms are four instanced meshes. The foliage sways a little: each frame
 * turns every plant's parts about its pot (a matrix product per part, no allocation); under reduced
 * motion they stand still.
 */
export default function Plants({ sill, stand, reducedMotion }: { sill: readonly PlantSpec[]; stand: number; reducedMotion: boolean }) {
  const get = useThree((state) => state.get);
  const rig = useMemo(() => {
    const white = matteMaterial("#ffffff");
    const pots = new InstancedMesh(new CylinderGeometry(0.055, 0.042, POT_HEIGHT, 10), white, PLANTS);
    const bushes = new InstancedMesh(new IcosahedronGeometry(0.075, 0), white, BUSHES);
    const leaves = new InstancedMesh(new ConeGeometry(0.025, 0.16, 5), white, LEAVES);
    const blooms = new InstancedMesh(new IcosahedronGeometry(0.022, 0), white, BLOOMS);
    const meshes = [pots, bushes, leaves, blooms];
    for (const mesh of meshes) {
      for (let index = 0; index < mesh.instanceMatrix.count; index++) mesh.setColorAt(index, tint.set(GREENS[0]));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    return { pots, bushes, leaves, blooms, meshes };
  }, []);
  useEffect(
    () => () => {
      for (const mesh of rig.meshes) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    },
    [rig],
  );

  const plants = useMemo(() => {
    // Remembered, so a watch that finishes leaves a gap rather than moving the others.
    const sillPlaces = placeRemembered(
      "sill",
      sill.map((plant) => plant.id),
      [furniture("sill")],
    ).placed;
    const byId = new Map(sill.map((plant) => [plant.id, plant]));
    const finished = Array.from({ length: Math.min(stand, STAND_CAP) }, (_, index) => standPlant(index));
    const standPlaces = placeItems(
      finished.map((plant) => plant.id),
      [furniture("plant-stand")],
      { unit: "piece" },
    ).placed;
    const standById = new Map(finished.map((plant) => [plant.id, plant]));
    return [
      ...sillPlaces.map((place) => ({ place, plant: byId.get(place.id)! })),
      ...standPlaces.map((place) => ({ place, plant: standById.get(place.id)! })),
    ];
  }, [sill, stand]);

  /** Every part with its plant's pot top, built when the plants change; the frame only multiplies. */
  const parts = useMemo(() => {
    const leaves: Part[] = [];
    const bushes: Part[] = [];
    const blooms: Part[] = [];
    const pivots: Vector3[] = [];
    const phases: number[] = [];
    const greens: string[] = [];
    const colours: { bloom: string }[] = [];
    plants.forEach(({ place, plant }, index) => {
      const built = plantParts(plant, index);
      leaves.push(...built.leaves);
      bushes.push(...built.bushes);
      blooms.push(...built.blooms);
      pivots.push(new Vector3(place.position[0], place.position[1] + POT_HEIGHT, place.position[2]));
      phases.push((hashId(plant.id, 97) % 1000) / 159);
      greens.push(built.green);
      colours.push({ bloom: plant.bloom });
    });
    return { leaves, bushes, blooms, pivots, phases, greens, colours };
  }, [plants]);

  useLayoutEffect(() => {
    const { pots, bushes, leaves, blooms } = rig;
    plants.forEach(({ place, plant }, index) => {
      scratch.position.set(place.position[0], place.position[1] + POT_HEIGHT / 2, place.position[2]);
      scratch.rotation.set(0, 0, 0);
      scratch.scale.setScalar(1);
      scratch.updateMatrix();
      pots.setMatrixAt(index, scratch.matrix);
      pots.setColorAt(index, tint.set(plant.pot));
    });
    parts.bushes.forEach((part, index) => bushes.setColorAt(index, tint.set(parts.greens[part.plant])));
    parts.leaves.forEach((part, index) => leaves.setColorAt(index, tint.set(parts.greens[part.plant])));
    parts.blooms.forEach((part, index) => blooms.setColorAt(index, tint.set(parts.colours[part.plant].bloom)));
    setDrawCount(pots, plants.length);
    setDrawCount(bushes, parts.bushes.length);
    setDrawCount(leaves, parts.leaves.length);
    setDrawCount(blooms, parts.blooms.length);
    for (const mesh of rig.meshes) {
      markForUpload(mesh.instanceMatrix);
      markForUpload(mesh.instanceColor);
    }
    get().gl.shadowMap.needsUpdate = true;
  }, [rig, plants, parts, get]);

  // Sway: every part turned about its plant's pot top by a small, slow, per-plant angle.
  const swayAll = (t: number) => {
    const write = (mesh: InstancedMesh, list: Part[]) => {
      for (let index = 0; index < list.length; index++) {
        const part = list[index];
        const phase = parts.phases[part.plant];
        sway.set(Math.sin(t * 0.7 + phase) * 0.04, 0, Math.sin(t * 0.9 + phase * 1.3) * 0.05);
        turn.setFromEuler(sway);
        pivot.copy(parts.pivots[part.plant]);
        world.compose(pivot, turn, ONE).multiply(part.local);
        mesh.setMatrixAt(index, world);
      }
      markForUpload(mesh.instanceMatrix);
    };
    write(rig.bushes, parts.bushes);
    write(rig.leaves, parts.leaves);
    write(rig.blooms, parts.blooms);
  };
  useFrame((frame) => {
    swayAll(reducedMotion ? 0 : frame.clock.elapsedTime);
  });

  const spots = useMemo<HotspotSpot[]>(
    () =>
      plants.map(({ place, plant }) => ({
        target: { kind: "plant", id: plant.id },
        position: [place.position[0], place.position[1] + 0.16, place.position[2]],
        size: [0.2, 0.34, 0.2],
      })),
    [plants],
  );

  return (
    <group>
      <Stand />
      {rig.meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
      <InstancedHotspot spots={spots} priority={1} />
    </group>
  );
}
