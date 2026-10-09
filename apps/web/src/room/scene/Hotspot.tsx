"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Box3, MeshBasicMaterial, Raycaster, Sphere, Vector2, Vector3, type Camera, type Intersection, type Mesh } from "three";
import type { RoomObjectKind, RoomTarget } from "../live";
import { setRoomPicker, type RoomHit } from "../pointer";
import { reportRoom } from "../report";

/**
 * The room's interactive objects (docs/PALACE.md, Hover and click): each is an undrawn box (a
 * hotspot) around the object, tagged `userData.room = { kind, id }`, kept in one registry the
 * pointer's raycast tests against. Raycasting a dozen boxes is cheaper than the objects' own
 * meshes, and an instanced robot has no mesh of its own to hit.
 */
const hotspots = new Set<Mesh>();

/** Hotspots are raycast, never drawn: an invisible material keeps them out of every render list. */
const HIDDEN = new MeshBasicMaterial({ visible: false });

export function Hotspot({
  kind,
  id = kind,
  size,
  position,
  rotation,
}: {
  kind: RoomObjectKind;
  id?: string;
  size: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  const mesh = useRef<Mesh>(null);
  useEffect(() => {
    const node = mesh.current;
    if (!node) return;
    node.userData.room = { kind, id } satisfies RoomTarget;
    hotspots.add(node);
    return () => {
      hotspots.delete(node);
    };
  }, [kind, id]);
  return (
    <mesh ref={mesh} position={position} rotation={rotation} material={HIDDEN}>
      <boxGeometry args={size} />
    </mesh>
  );
}

const raycaster = new Raycaster();
const ndc = new Vector2();
const hits: Intersection[] = [];
const box = new Box3();
const sphere = new Sphere();

/** The nearest hotspot under the client point, with its world-space bounding sphere (for framing it). */
export function pickRoom(camera: Camera, canvas: HTMLCanvasElement, clientX: number, clientY: number): RoomHit | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  hits.length = 0;
  for (const hotspot of hotspots) raycaster.intersectObject(hotspot, false, hits);
  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance);
  const object = hits[0].object;
  hits.length = 0;
  const target = object.userData.room as RoomTarget;
  box.setFromObject(object).getBoundingSphere(sphere);
  return { kind: target.kind, id: target.id, centre: [sphere.center.x, sphere.center.y, sphere.center.z], radius: sphere.radius };
}

const projected = new Vector3();
const POINTS_MS = 400;

/** Where each hotspot's centre lands on screen (CSS pixels), keyed `kind:id`; for tests. */
function hotspotPoints(camera: Camera, canvas: HTMLCanvasElement): Record<string, [number, number]> {
  const rect = canvas.getBoundingClientRect();
  const points: Record<string, [number, number]> = {};
  for (const hotspot of hotspots) {
    const target = hotspot.userData.room as RoomTarget;
    hotspot.getWorldPosition(projected).project(camera);
    if (projected.z > 1) continue;
    points[`${target.kind}:${target.id}`] = [
      Math.round(rect.left + ((projected.x + 1) / 2) * rect.width),
      Math.round(rect.top + ((1 - projected.y) / 2) * rect.height),
    ];
  }
  return points;
}

/**
 * Connects the canvas to the page's pointer listener (`pointer.ts`): registers the raycast against
 * the hotspots, and every 400 ms reports the hotspots' screen points (`data-room`'s `points`).
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
    const now = performance.now();
    if (now - reportedAt.current < POINTS_MS) return;
    reportedAt.current = now;
    reportRoom("points", hotspotPoints(camera, gl.domElement));
  });
  return null;
}
