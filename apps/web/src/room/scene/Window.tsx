"use client";

import { useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, type Group } from "three";
import { ROOM } from "../layout";
import { matteMaterial, palette } from "./materials";

/** The window opening's centre, on the glass. */
export const WINDOW_CENTRE = new Vector3(ROOM.window.x, (ROOM.window.sill + ROOM.window.top) / 2, ROOM.back - 0.12);

const toWindow = new Vector3();

/**
 * A group that sits `distance` behind the window along the camera's line of sight through it, facing
 * the camera, so its children (clouds, the moon) stay framed by the window from any camera pose.
 * Children are laid out in the group's plane: +x right and +y up as seen through the glass.
 */
export function WindowView({ distance, children }: { distance: number; children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const node = group.current;
    if (!node) return;
    toWindow.copy(WINDOW_CENTRE).sub(camera.position).normalize();
    node.position.copy(WINDOW_CENTRE).addScaledVector(toWindow, distance);
    node.quaternion.copy(camera.quaternion);
  });
  return <group ref={group}>{children}</group>;
}

/** The window's frame, mullions, sill and glass (the view through it is the sky and the weather). */
export default function Window() {
  const { window: w, back } = ROOM;
  const left = w.x - w.width / 2;
  const right = w.x + w.width / 2;
  const height = w.top - w.sill;
  const z = back - 0.12;
  const bar = 0.07;
  const frame = matteMaterial(palette.frame);
  return (
    <group>
      <mesh position={[w.x, w.top - bar / 2, z]} material={frame} castShadow>
        <boxGeometry args={[w.width, bar, 0.1]} />
      </mesh>
      <mesh position={[w.x, w.sill + bar / 2, z]} material={frame} castShadow>
        <boxGeometry args={[w.width, bar, 0.1]} />
      </mesh>
      <mesh position={[left + bar / 2, w.sill + height / 2, z]} material={frame} castShadow>
        <boxGeometry args={[bar, height, 0.1]} />
      </mesh>
      <mesh position={[right - bar / 2, w.sill + height / 2, z]} material={frame} castShadow>
        <boxGeometry args={[bar, height, 0.1]} />
      </mesh>
      <mesh position={[w.x, w.sill + height / 2, z]} material={frame} castShadow>
        <boxGeometry args={[0.05, height, 0.08]} />
      </mesh>
      <mesh position={[w.x, w.sill + height * 0.62, z]} material={frame} castShadow>
        <boxGeometry args={[w.width, 0.05, 0.08]} />
      </mesh>
      {/* The inside sill, where plants will stand. */}
      <mesh position={[w.x, w.sill - 0.02, back + 0.1]} material={matteMaterial(palette.sill)} castShadow receiveShadow>
        <boxGeometry args={[w.width + 0.3, 0.06, 0.3]} />
      </mesh>
      {/* Faint glass: a sheen, not a reflection. It neither casts nor blocks shadows. */}
      <mesh position={[w.x, w.sill + height / 2, z - 0.01]}>
        <planeGeometry args={[w.width, height]} />
        <meshBasicMaterial color={palette.glass} transparent opacity={0.07} depthWrite={false} />
      </mesh>
    </group>
  );
}
