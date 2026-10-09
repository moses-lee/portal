"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { BoxGeometry, Color, CylinderGeometry, InstancedMesh, Object3D, SphereGeometry } from "three";
import { FRAME_CAP, GALLERY_CAP, type FrameSpec } from "../growth";
import { furniture, placeRemembered } from "../layout-slots";
import { InstancedHotspot, type HotspotSpot } from "./Hotspot";
import { instancedMatte, markForUpload, setDrawCount } from "./materials";

const LIMIT = FRAME_CAP + GALLERY_CAP;
/** A frame beside the window, and the gallery's small ones. */
const BIG = { width: 0.36, height: 0.42 } as const;
const SMALL = { width: 0.18, height: 0.21 } as const;
const DEPTH = 0.03;
const SUN = new Color("#fff1c2");
const scratch = new Object3D();
const tint = new Color();

/**
 * The framed pictures (docs/PALACE.md, Objects): one per pinned project on the back wall beside the
 * window, over the desk's end, six of them; past six a gallery row of small ones above the window.
 * Each frame's style (thin, thick or round), wood and picture (a sky, a hill and a sun) from the
 * project's id. Square and round frames, their canvases, hills and suns are six instanced meshes.
 */
export default function Frames({ frames }: { frames: readonly FrameSpec[] }) {
  const get = useThree((state) => state.get);
  const rig = useMemo(() => {
    const white = instancedMatte();
    const box = new BoxGeometry(1, 1, 1);
    const disc = new CylinderGeometry(0.5, 0.5, 1, 24);
    disc.rotateX(Math.PI / 2);
    const meshes = {
      square: new InstancedMesh(box, white, LIMIT),
      round: new InstancedMesh(disc, white, LIMIT),
      canvas: new InstancedMesh(box, white, LIMIT),
      roundCanvas: new InstancedMesh(disc, white, LIMIT),
      hill: new InstancedMesh(new SphereGeometry(0.5, 14, 8), white, LIMIT),
      sun: new InstancedMesh(new SphereGeometry(0.5, 10, 6), white, LIMIT),
    };
    for (const mesh of Object.values(meshes)) {
      for (let index = 0; index < LIMIT; index++) mesh.setColorAt(index, SUN);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    return { box, disc, meshes };
  }, []);
  useEffect(
    () => () => {
      rig.box.dispose();
      rig.disc.dispose();
      rig.meshes.hill.geometry.dispose();
      rig.meshes.sun.geometry.dispose();
      for (const mesh of Object.values(rig.meshes)) mesh.dispose();
    },
    [rig],
  );

  const placed = useMemo(() => {
    const visible = frames.slice(0, LIMIT);
    // Remembered, so an unpinned project leaves a gap rather than moving the others.
    const places = placeRemembered(
      "frames",
      visible.map((frame) => frame.id),
      [furniture("frames"), furniture("gallery")],
    ).placed;
    const byId = new Map(visible.map((frame) => [frame.id, frame]));
    return places.map((place) => ({ place, frame: byId.get(place.id)!, size: place.furniture === "gallery" ? SMALL : BIG }));
  }, [frames]);

  useLayoutEffect(() => {
    const { square, round, canvas, roundCanvas, hill, sun } = rig.meshes;
    const counts = { square: 0, round: 0, canvas: 0, roundCanvas: 0, hill: 0, sun: 0 };
    const put = (mesh: InstancedMesh, key: keyof typeof counts, x: number, y: number, z: number, sx: number, sy: number, sz: number, colour: Color | string) => {
      scratch.position.set(x, y, z);
      scratch.rotation.set(0, 0, 0);
      scratch.scale.set(sx, sy, sz);
      scratch.updateMatrix();
      mesh.setMatrixAt(counts[key], scratch.matrix);
      mesh.setColorAt(counts[key], typeof colour === "string" ? tint.set(colour) : colour);
      counts[key]++;
    };
    for (const { place, frame, size } of placed) {
      const [x, y, z] = place.position;
      const { width, height } = size;
      const border = frame.style === 1 ? 0.16 : 0.09;
      const inner = { width: width * (1 - border), height: height * (1 - border) };
      if (frame.style === 2) {
        put(round, "round", x, y, z, width, height, DEPTH, frame.frame);
        put(roundCanvas, "roundCanvas", x, y, z + DEPTH / 2 + 0.002, inner.width, inner.height, 0.004, frame.picture);
      } else {
        put(square, "square", x, y, z, width, height, DEPTH, frame.frame);
        put(canvas, "canvas", x, y, z + DEPTH / 2 + 0.002, inner.width, inner.height, 0.004, frame.picture);
      }
      put(hill, "hill", x - inner.width * 0.08, y - inner.height * 0.3, z + DEPTH / 2 + 0.005, inner.width * 0.9, inner.height * 0.38, 0.004, frame.hill);
      put(sun, "sun", x + inner.width * 0.22, y + inner.height * 0.22, z + DEPTH / 2 + 0.005, inner.width * 0.18, inner.width * 0.18, 0.004, SUN);
    }
    for (const [key, mesh] of Object.entries(rig.meshes)) {
      setDrawCount(mesh, counts[key as keyof typeof counts]);
      markForUpload(mesh.instanceMatrix);
      markForUpload(mesh.instanceColor);
    }
    get().gl.shadowMap.needsUpdate = true;
  }, [rig, placed, get]);

  const spots = useMemo<HotspotSpot[]>(
    () =>
      placed.map(({ place, frame, size }) => ({
        target: { kind: "frame", id: frame.id },
        position: [place.position[0], place.position[1], place.position[2] + 0.05],
        size: [size.width, size.height, 0.12],
      })),
    [placed],
  );

  return (
    <group>
      {Object.values(rig.meshes).map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
      <InstancedHotspot spots={spots} />
    </group>
  );
}
