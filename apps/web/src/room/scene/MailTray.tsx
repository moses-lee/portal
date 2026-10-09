"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { BoxGeometry, Color, CylinderGeometry, InstancedMesh, Object3D } from "three";
import { mulberry32 } from "@portal/shared/room";
import { MAIL_CAP } from "../live";
import { MAIL_SHELF as SHELF, ROOM } from "../layout";
import { Hotspot } from "./Hotspot";
import { instancedMatte, markForUpload, palette } from "./materials";
import { Soft } from "./Shell";

/** Envelopes drawn on the floor pile however many are past twelve; the hover card has the number. */
const PILE_DRAWN = 6;
const OPEN = new Color("#f3ead6");
const SEALED = new Color("#c9ab7c");
const scratch = new Object3D();
const HIDDEN = 1e-4;

const PILE = { x: 2.55, z: ROOM.back + 0.45 } as const;

/**
 * The mail tray by the door (docs/PALACE.md, Objects): one envelope per needs-you item and a
 * sealed one (darker, with a red wax dot) per pending approval, stacked up to twelve; past that the
 * rest lie in a pile on the floor below and the hover card gives the number. The envelopes and the
 * seals are two instanced meshes, rewritten only when the counts change.
 */
export default function MailTray({ sealed, open, pile }: { sealed: number; open: number; pile: number }) {
  const get = useThree((state) => state.get);
  const rig = useMemo(() => {
    const envelopes = new InstancedMesh(new BoxGeometry(0.26, 0.008, 0.17), instancedMatte(), MAIL_CAP + PILE_DRAWN);
    const seals = new InstancedMesh(new CylinderGeometry(0.018, 0.018, 0.006, 10), instancedMatte("#b8322b"), MAIL_CAP);
    for (const mesh of [envelopes, seals]) {
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    return { envelopes, seals };
  }, []);
  useEffect(
    () => () => {
      rig.envelopes.geometry.dispose();
      rig.seals.geometry.dispose();
    },
    [rig],
  );

  useLayoutEffect(() => {
    const { envelopes, seals } = rig;
    const stacked = open + sealed;
    // Open envelopes at the bottom, sealed ones on top; each a little askew, by its place in the stack.
    for (let index = 0; index < MAIL_CAP; index++) {
      const shown = index < stacked;
      const isSealed = index >= open;
      const random = mulberry32(index + 1);
      scratch.position.set(SHELF.x + (random() - 0.5) * 0.02, SHELF.y + 0.035 + index * 0.0095, SHELF.z + (random() - 0.5) * 0.015);
      scratch.rotation.set(0, (random() - 0.5) * 0.12, 0);
      scratch.scale.setScalar(shown ? 1 : HIDDEN);
      scratch.updateMatrix();
      envelopes.setMatrixAt(index, scratch.matrix);
      envelopes.setColorAt(index, isSealed ? SEALED : OPEN);
      // The seal sits on the envelope's front edge, facing out, so a stack shows a column of red dots.
      scratch.position.set(scratch.position.x, scratch.position.y, scratch.position.z + 0.086);
      scratch.rotation.set(Math.PI / 2, 0, 0);
      scratch.scale.setScalar(shown && isSealed ? 1 : HIDDEN);
      scratch.updateMatrix();
      seals.setMatrixAt(index, scratch.matrix);
    }
    for (let index = 0; index < PILE_DRAWN; index++) {
      const random = mulberry32(100 + index);
      scratch.position.set(PILE.x + (random() - 0.5) * 0.35, 0.006 + index * 0.009, PILE.z + (random() - 0.5) * 0.25);
      scratch.rotation.set((random() - 0.5) * 0.1, random() * Math.PI, (random() - 0.5) * 0.1);
      scratch.scale.setScalar(index < pile ? 1 : HIDDEN);
      scratch.updateMatrix();
      envelopes.setMatrixAt(MAIL_CAP + index, scratch.matrix);
      envelopes.setColorAt(MAIL_CAP + index, OPEN);
    }
    markForUpload(envelopes.instanceMatrix);
    markForUpload(envelopes.instanceColor);
    markForUpload(seals.instanceMatrix);
    get().gl.shadowMap.needsUpdate = true;
  }, [rig, open, sealed, pile, get]);

  return (
    <group>
      {/* The wall shelf and the tray on it. */}
      <Soft size={[SHELF.width, 0.03, SHELF.depth]} position={[SHELF.x, SHELF.y, SHELF.z]} color={palette.woodLight} radius={0.01} />
      <Soft size={[0.32, 0.02, 0.21]} position={[SHELF.x, SHELF.y + 0.025, SHELF.z]} color={palette.wood} radius={0.008} />
      <Soft size={[0.32, 0.05, 0.015]} position={[SHELF.x, SHELF.y + 0.05, SHELF.z + 0.105]} color={palette.wood} radius={0.006} />
      <Soft size={[0.32, 0.09, 0.015]} position={[SHELF.x, SHELF.y + 0.07, SHELF.z - 0.105]} color={palette.wood} radius={0.006} />
      <primitive object={rig.envelopes} />
      <primitive object={rig.seals} />
      <Hotspot kind="mail" size={[0.55, 1.3, 0.6]} position={[SHELF.x, 0.62, ROOM.back + 0.3]} />
    </group>
  );
}
