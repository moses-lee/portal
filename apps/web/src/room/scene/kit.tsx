"use client";

import { Component, Suspense, useEffect, type ReactNode } from "react";
import { useGLTF } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { Mesh } from "three";
import { requestRoomFrame } from "../loop";
import { matteMaterial } from "./materials";

/**
 * The room's kit (docs/PALACE.md, decision 20): a few CC0 furniture meshes from KayKit Furniture
 * Bits, merged into one meshopt-compressed GLB (`public/room/kit.glb`, sources and licences in
 * `public/room/LICENSES.md`). Only the geometry is used: every piece takes the room's own matte
 * colours, so the kit's texture and UVs were stripped when it was built.
 */
export const KIT_URL = "/room/kit.glb";

export type KitPiece = "chair_A_wood";

/** `useGLTF`'s arguments for the kit: no Draco, the meshopt decoder. */
const DRACO = false;
const MESHOPT = true;

/** The kit's meshes by node name; suspends until the GLB has loaded (meshopt decoding, no Draco). */
function useKit(): Record<string, Mesh> {
  return useGLTF(KIT_URL, DRACO, MESHOPT).nodes as Record<string, Mesh>;
}

// Fetched as the room's chunk evaluates, so the first frame usually has the kit's chair rather than
// its stand-in. The arguments must be `useKit`'s: R3F caches by loader and URL only, so the first
// call decides the decoder.
useGLTF.preload(KIT_URL, DRACO, MESHOPT);

/** One kit piece in a room colour, at the kit's own scale unless given one. */
export function KitMesh({
  piece,
  color,
  position,
  rotation,
  scale,
}: {
  piece: KitPiece;
  color: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
}) {
  const nodes = useKit();
  const get = useThree((state) => state.get);
  // The piece replaced its stand-in: draw it (a still room draws only when asked) and redo the sun's shadows.
  useEffect(() => {
    get().gl.shadowMap.needsUpdate = true;
    requestRoomFrame();
  }, [get]);
  return <mesh geometry={nodes[piece].geometry} material={matteMaterial(color)} position={position} rotation={rotation} scale={scale} castShadow receiveShadow />;
}

/** Shows `fallback` (the piece in primitives) until the kit has loaded, or for good if it fails to. */
class KitBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Kit pieces with a primitive stand-in while the kit loads or if it cannot. */
export function WithKit({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return (
    <KitBoundary fallback={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </KitBoundary>
  );
}
