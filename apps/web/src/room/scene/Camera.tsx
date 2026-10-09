"use client";

import { useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Vector3, type PerspectiveCamera } from "three";
import { boxCorners, cameraPosition, frameSpec, framePose } from "../layout";
import { reportRoom } from "../report";

const DEGREE = Math.PI / 180;
const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const corner = new Vector3();

/**
 * The diorama camera (docs/PALACE.md, Camera): the pose fitted to the room for the viewport's
 * aspect (`framePose`, aimed a little right in landscape), set when the aspect changes; nothing
 * else sets it (Revisions 3 and 4: no panel, no strip, no view offset). Nothing runs per frame and
 * nothing the user does moves it. After each change it reports `camera` into `data-room`: the
 * angles in degrees, the distance, and the hero box's bounds on screen as the live camera projects
 * them.
 */
export default function CameraRig({ onChange }: { onChange: () => void }) {
  const get = useThree((state) => state.get);
  const size = useThree((state) => state.size);
  const aspect = size.width / Math.max(1, size.height);
  const pose = useMemo(() => framePose(aspect), [aspect]);
  const box = useMemo(() => frameSpec(aspect).box, [aspect]);

  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const camera = get().camera as PerspectiveCamera;
    camera.position.set(...cameraPosition(pose));
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();
  }, [get, pose, size.width, size.height]);

  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const camera = get().camera as PerspectiveCamera;
    camera.fov = pose.fov;
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // The hero box on screen through the live camera, so a test can check it against the fit.
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const point of boxCorners(box)) {
      corner.set(...point).project(camera);
      const x = size.left + ((corner.x + 1) / 2) * size.width;
      const y = size.top + ((1 - corner.y) / 2) * size.height;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    reportRoom("camera", {
      yaw: round(pose.yaw / DEGREE),
      pitch: round(pose.pitch / DEGREE),
      distance: round(pose.distance, 2),
      box: [round(left), round(top), round(right), round(bottom)],
    });
    onChange();
  }, [get, size.width, size.height, size.left, size.top, pose, box, onChange]);

  return null;
}
