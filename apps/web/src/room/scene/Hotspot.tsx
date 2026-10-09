"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Box3, BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Raycaster, Sphere, Vector2, Vector3, type Camera, type Intersection, type Mesh } from "three";
import type { RoomObjectKind, RoomTarget } from "../live";
import { setRoomPicker, type RoomHit } from "../pointer";
import { setDrawCount } from "./materials";
import { reportRoom } from "../report";

/**
 * The room's interactive objects (docs/PALACE.md, Hover and click): each is an undrawn box (a
 * hotspot) around the object, tagged `userData.room = { kind, id }`, kept in one registry the
 * pointer's raycast tests against. Raycasting a dozen boxes is cheaper than the objects' own
 * meshes, and an instanced robot has no mesh of its own to hit. Objects that come in rows (books,
 * plants, frames) share one instanced hotspot whose instances carry their targets
 * (`userData.roomTargets`). A hotspot with a higher `userData.roomPriority` wins over a nearer one
 * (the tree, seen through the window's own hotspot; notes loose on the lamp's desk).
 */
const hotspots = new Set<Mesh>();

type HotspotData = { room?: RoomTarget; roomTargets?: readonly RoomTarget[]; roomPriority?: number };

/** Hotspots are raycast, never drawn: an invisible material keeps them out of every render list. */
const HIDDEN = new MeshBasicMaterial({ visible: false });

export function Hotspot({
  kind,
  id = kind,
  size,
  position,
  rotation,
  priority = 0,
}: {
  kind: RoomObjectKind;
  id?: string;
  size: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
  priority?: number;
}) {
  const mesh = useRef<Mesh>(null);
  useEffect(() => {
    const node = mesh.current;
    if (!node) return;
    Object.assign(node.userData, { room: { kind, id }, roomPriority: priority } satisfies HotspotData);
    hotspots.add(node);
    return () => {
      hotspots.delete(node);
    };
  }, [kind, id, priority]);
  return (
    <mesh ref={mesh} position={position} rotation={rotation} material={HIDDEN}>
      <boxGeometry args={size} />
    </mesh>
  );
}

/** One spot of an instanced hotspot: what it stands for, and its box (centre, size, turn about y). */
export type HotspotSpot = { target: RoomTarget; position: readonly [number, number, number]; size: readonly [number, number, number]; turn?: number };

const UNIT_BOX = new BoxGeometry(1, 1, 1);
const place = new Object3D();

/**
 * Many hotspots in one instanced mesh, never drawn: a row of books, the plants on the sill. Each
 * instance is its spot's box and carries its target; the raycast reports which one was hit. The
 * mesh is rebuilt only when it needs more room; the boxes are rewritten when the spots change.
 */
export function InstancedHotspot({ spots, priority = 0 }: { spots: readonly HotspotSpot[]; priority?: number }) {
  const room = Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(1, spots.length))));
  const mesh = useMemo(() => {
    const node = new InstancedMesh(UNIT_BOX, HIDDEN, room);
    node.count = 0;
    return node;
  }, [room]);
  useEffect(() => {
    hotspots.add(mesh);
    return () => {
      hotspots.delete(mesh);
      mesh.dispose();
    };
  }, [mesh]);
  useLayoutEffect(() => {
    spots.forEach((spot, index) => {
      place.position.set(spot.position[0], spot.position[1], spot.position[2]);
      place.rotation.set(0, spot.turn ?? 0, 0);
      place.scale.set(spot.size[0], spot.size[1], spot.size[2]);
      place.updateMatrix();
      mesh.setMatrixAt(index, place.matrix);
    });
    Object.assign(mesh.userData, { roomTargets: spots.map((spot) => spot.target), roomPriority: priority } satisfies HotspotData);
    setDrawCount(mesh, spots.length);
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }, [mesh, spots, priority]);
  return <primitive object={mesh} />;
}

const raycaster = new Raycaster();
const instance = new Matrix4();
const ndc = new Vector2();
const hits: Intersection[] = [];
const box = new Box3();
const sphere = new Sphere();
const projected = new Vector3();
const ORIGIN = new Vector3(0, 0, 0);
const UNIT = new Vector3(1, 1, 1);

/** The nearest hotspot under the client point, with its world-space bounding sphere (for framing it). */
export function pickRoom(camera: Camera, canvas: HTMLCanvasElement, clientX: number, clientY: number): RoomHit | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  hits.length = 0;
  for (const hotspot of hotspots) raycaster.intersectObject(hotspot, false, hits);
  if (!hits.length) return null;
  const priorityOf = (hit: Intersection) => (hit.object.userData as HotspotData).roomPriority ?? 0;
  hits.sort((a, b) => priorityOf(b) - priorityOf(a) || a.distance - b.distance);
  const hit = hits[0];
  hits.length = 0;
  const data = hit.object.userData as HotspotData;
  const target = hit.instanceId !== undefined ? data.roomTargets?.[hit.instanceId] : data.room;
  if (!target) return null;
  if (hit.instanceId !== undefined && hit.object instanceof InstancedMesh) {
    hit.object.getMatrixAt(hit.instanceId, instance);
    box.setFromCenterAndSize(ORIGIN, UNIT).applyMatrix4(instance).applyMatrix4(hit.object.matrixWorld);
    box.getBoundingSphere(sphere);
  } else box.setFromObject(hit.object).getBoundingSphere(sphere);
  return { kind: target.kind, id: target.id, centre: [sphere.center.x, sphere.center.y, sphere.center.z], radius: sphere.radius };
}

const POINTS_MS = 400;
/** An instanced hotspot reports its first few spots only: a full bookcase would fill the attribute. */
const POINTS_PER_INSTANCED = 6;

/** Where each hotspot's centre lands on screen (CSS pixels), keyed `kind:id`; for tests. */
function hotspotPoints(camera: Camera, canvas: HTMLCanvasElement): Record<string, [number, number]> {
  const rect = canvas.getBoundingClientRect();
  const points: Record<string, [number, number]> = {};
  const report = (target: RoomTarget) => {
    projected.project(camera);
    if (projected.z > 1) return;
    points[`${target.kind}:${target.id}`] = [
      Math.round(rect.left + ((projected.x + 1) / 2) * rect.width),
      Math.round(rect.top + ((1 - projected.y) / 2) * rect.height),
    ];
  };
  for (const hotspot of hotspots) {
    const data = hotspot.userData as HotspotData;
    if (hotspot instanceof InstancedMesh) {
      const targets = data.roomTargets ?? [];
      for (let index = 0; index < Math.min(hotspot.count, POINTS_PER_INSTANCED, targets.length); index++) {
        hotspot.getMatrixAt(index, instance);
        projected.setFromMatrixPosition(instance).applyMatrix4(hotspot.matrixWorld);
        report(targets[index]);
      }
    } else if (data.room) {
      hotspot.getWorldPosition(projected);
      report(data.room);
    }
  }
  return points;
}

/**
 * Whether the page is driven by automation (Playwright, WebDriver): only then are the hotspots'
 * screen points worth projecting and writing to the DOM, for the tests to aim at.
 */
const automated = typeof navigator !== "undefined" && navigator.webdriver === true;

/**
 * Connects the canvas to the page's pointer listener (`pointer.ts`): registers the raycast against
 * the hotspots, and under automation every 400 ms reports the hotspots' screen points (`data-room`'s
 * `points`).
 */
export function PointerBridge() {
  const get = useThree((state) => state.get);
  useEffect(() => {
    setRoomPicker((x, y) => {
      const { camera, gl } = get();
      return pickRoom(camera, gl.domElement, x, y);
    });
    return () => setRoomPicker(null);
  }, [get]);
  const reportedAt = useRef(-Infinity);
  useFrame(({ camera, gl }) => {
    if (!automated) return;
    const now = performance.now();
    if (now - reportedAt.current < POINTS_MS) return;
    reportedAt.current = now;
    reportRoom("points", hotspotPoints(camera, gl.domElement));
  });
  return null;
}
