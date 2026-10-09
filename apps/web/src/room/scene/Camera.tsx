"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";
import { cameraPose, driftYaw, interestPoint, parallax, readLayout, subscribeLayout, viewOffset } from "../layout";
import { look, stepLook } from "../look";
import { reportRoom } from "../report";

const DEGREE = Math.PI / 180;
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The diorama camera (docs/PALACE.md, Camera): the pose for the viewport's aspect, the view offset
 * that centres the room in the region the UI leaves open (recomputed on layout change only), and
 * the slow drift and pointer parallax, both off under reduced motion. On the Palace page the
 * look-around (`look.ts`) adds its yaw, pitch, zoom and framing flights on top; the camera reports
 * that look (degrees, zoom) into `data-room` as `camera` for tests.
 */
export default function CameraRig({ reducedMotion, onChange }: { reducedMotion: boolean; onChange: () => void }) {
  const get = useThree((state) => state.get);
  const size = useThree((state) => state.size);
  const layout = useSyncExternalStore(subscribeLayout, readLayout, readLayout);
  const strip = layout.covers.some((cover) => cover.kind === "focus");
  const pose = useMemo(() => cameraPose(size.width / Math.max(1, size.height), strip), [size.width, size.height, strip]);

  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const point = interestPoint({ ...layout, width: size.width, height: size.height });
    const offset = viewOffset(size.width, size.height, point);
    const camera = get().camera as PerspectiveCamera;
    camera.fov = pose.fov;
    camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.x, offset.y, offset.width, offset.height);
    camera.updateProjectionMatrix();
    onChange();
  }, [get, layout, size.width, size.height, pose, onChange]);

  const pointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (reducedMotion) {
      pointer.current = { x: 0, y: 0 };
      return;
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointer.current = { x: (event.clientX / window.innerWidth) * 2 - 1, y: (event.clientY / window.innerHeight) * 2 - 1 };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [reducedMotion]);

  // Eased towards the pointer so the parallax glides rather than snapping at 24 fps.
  const eased = useRef({ yaw: 0, pitch: 0 });
  const reported = useRef({ yaw: NaN, pitch: NaN, zoom: NaN, focus: NaN });
  useFrame((state, rawDelta) => {
    const delta = Math.min(0.1, Math.max(0, rawDelta));
    const target = reducedMotion ? { yaw: 0, pitch: 0 } : parallax(pointer.current.x, pointer.current.y);
    const k = reducedMotion ? 1 : Math.min(1, delta * 3);
    eased.current.yaw += (target.yaw - eased.current.yaw) * k;
    eased.current.pitch += (target.pitch - eased.current.pitch) * k;
    const drift = reducedMotion ? 0 : driftYaw(state.clock.elapsedTime);

    // The Palace page's look: offsets within its limits, a zoom, and a blend towards a framed object.
    look.basePitch = pose.pitch;
    if (look.active) stepLook(performance.now(), delta);
    const on = look.active;
    const yaw = pose.yaw + drift + eased.current.yaw + (on ? look.yaw : 0);
    const pitch = pose.pitch + eased.current.pitch + (on ? look.pitch : 0);
    const focus = on ? look.focus : 0;
    const distance = ((1 - focus) * pose.distance + focus * look.focusDistance) / (on ? look.zoom : 1);
    const tx = pose.target[0] + (look.focusPoint[0] - pose.target[0]) * focus;
    const ty = pose.target[1] + (look.focusPoint[1] - pose.target[1]) * focus;
    const tz = pose.target[2] + (look.focusPoint[2] - pose.target[2]) * focus;
    const flat = Math.cos(pitch) * distance;
    state.camera.position.set(tx + Math.sin(yaw) * flat, ty + Math.sin(pitch) * distance, tz + Math.cos(yaw) * flat);
    state.camera.lookAt(tx, ty, tz);

    const lookYaw = round((on ? look.yaw : 0) / DEGREE);
    const lookPitch = round((pose.pitch + (on ? look.pitch : 0)) / DEGREE);
    const zoom = round(on ? look.zoom : 1);
    const framed = round(focus);
    const last = reported.current;
    if (last.yaw !== lookYaw || last.pitch !== lookPitch || last.zoom !== zoom || last.focus !== framed) {
      reported.current = { yaw: lookYaw, pitch: lookPitch, zoom, focus: framed };
      // Yaw from the default pose, pitch absolute, both in degrees (drift and parallax left out).
      reportRoom("camera", { yaw: lookYaw, pitch: lookPitch, zoom, focus: framed });
    }
  });
  return null;
}
