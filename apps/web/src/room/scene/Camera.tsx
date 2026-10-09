"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";
import { cameraPose, cameraPosition, driftYaw, interestPoint, parallax, readLayout, subscribeLayout, viewOffset } from "../layout";

/**
 * The diorama camera (docs/PALACE.md, Camera): the pose for the viewport's aspect, the view offset
 * that centres the room in the region the UI leaves open (recomputed on layout change only), and
 * the slow drift and pointer parallax, both off under reduced motion.
 */
export default function CameraRig({ reducedMotion, onChange }: { reducedMotion: boolean; onChange: () => void }) {
  const get = useThree((state) => state.get);
  const size = useThree((state) => state.size);
  const layout = useSyncExternalStore(subscribeLayout, readLayout, readLayout);
  const pose = useMemo(() => cameraPose(size.width / Math.max(1, size.height)), [size.width, size.height]);

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
  useFrame((state, delta) => {
    const target = reducedMotion ? { yaw: 0, pitch: 0 } : parallax(pointer.current.x, pointer.current.y);
    const k = reducedMotion ? 1 : Math.min(1, delta * 3);
    eased.current.yaw += (target.yaw - eased.current.yaw) * k;
    eased.current.pitch += (target.pitch - eased.current.pitch) * k;
    const drift = reducedMotion ? 0 : driftYaw(state.clock.elapsedTime);
    const [x, y, z] = cameraPosition(pose, drift + eased.current.yaw, eased.current.pitch);
    state.camera.position.set(x, y, z);
    state.camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  });
  return null;
}
