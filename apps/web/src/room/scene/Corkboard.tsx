"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { BoxGeometry, Color, InstancedMesh, Object3D, SphereGeometry } from "three";
import { hashId, mulberry32 } from "@portal/shared/room";
import { LOOSE_CAP, NOTE_CAP, type NoteCount } from "../growth";
import { ANCHORS, furnitureFor, placeItems } from "../layout-slots";
import { Hotspot } from "./Hotspot";
import { instancedMatte, markForUpload, palette, setDrawCount } from "./materials";
import { Soft } from "./Shell";

const PAPERS = ["#fff3b0", "#ffd6a5", "#cdeac0", "#bde0fe", "#ffc8dd", "#f4efe4"] as const;
const PINS = ["#c8463c", "#3f6fb0", "#d9902f", "#5d8a4a"] as const;
const CORK = "#c49a6c";
/** Notes drawn: a board's sixty, sixty more layered over them, and the desk's loose ones. */
const LIMIT = NOTE_CAP * 2 + LOOSE_CAP;
const NOTE = 0.08;
const scratch = new Object3D();
const tint = new Color();

/** The loose inbox notes' corner of the desk, right of the papers. */
const DESK = { x: -0.58, z: ANCHORS.desk[2] - 0.05, y: ANCHORS.desk[1] + 0.002 } as const;

/** The wide pinboard's width and centre along the wall (it grows towards the room's front). */
export const PINBOARD = { width: 2.1, centre: ANCHORS.board[2] + 0.35 } as const;

/** A board on the left wall above the shelving: the corkboard the room starts with, or (wider) the pinboard. */
export function CorkboardFrame({ width = 1.3, centre = ANCHORS.board[2] }: { width?: number; centre?: number }) {
  const [x, y] = ANCHORS.board;
  return (
    <group position={[x, y, centre]}>
      <Soft size={[0.04, 0.68, width + 0.06]} position={[0.02, 0, 0]} color={palette.wood} radius={0.012} />
      <Soft size={[0.03, 0.6, width - 0.02]} position={[0.035, 0, 0]} color={CORK} radius={0.008} />
    </group>
  );
}

/**
 * The corkboard and the inbox notes (docs/PALACE.md, Objects): one pinned note per active memory
 * record on the board (the wide pinboard once its milestone is in), sixty and then layered over
 * them; unreviewed inbox items lie loose on the desk until filed. Notes and pins are two instanced
 * meshes, their places from the board's slots, their paper and pin colours from each note's id.
 * Every pin is the same: the census counts records, it does not say which are pinned.
 */
export default function Corkboard({ notes, shown }: { notes: NoteCount; shown: ReadonlySet<string> }) {
  const get = useThree((state) => state.get);
  const wide = shown.has("wide-pinboard");
  const rig = useMemo(() => {
    const papers = new InstancedMesh(new BoxGeometry(1, 1, 1), instancedMatte(), LIMIT);
    const pins = new InstancedMesh(new SphereGeometry(0.009, 8, 6), instancedMatte(), NOTE_CAP * 2);
    for (let index = 0; index < LIMIT; index++) papers.setColorAt(index, tint.set(PAPERS[0]));
    for (let index = 0; index < NOTE_CAP * 2; index++) pins.setColorAt(index, tint.set(PINS[0]));
    for (const mesh of [papers, pins]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    return { papers, pins };
  }, []);
  useEffect(
    () => () => {
      rig.papers.geometry.dispose();
      rig.pins.geometry.dispose();
      rig.papers.dispose();
      rig.pins.dispose();
    },
    [rig],
  );

  const board = useMemo(() => furnitureFor("note", shown), [shown]);
  const placed = useMemo(() => {
    const ids = Array.from({ length: notes.pinned }, (_, index) => `note:${index}`);
    return placeItems(ids, board, { unit: "piece" }).placed;
  }, [notes.pinned, board]);

  useLayoutEffect(() => {
    const { papers, pins } = rig;
    let paper = 0;
    let pin = 0;
    const put = (x: number, y: number, z: number, id: string, layer: number) => {
      const random = mulberry32(hashId(id, 71));
      scratch.position.set(x + 0.003 + layer * 0.004, y + layer * -0.018, z + layer * 0.022);
      scratch.rotation.set((random() - 0.5) * 0.3, 0, 0);
      scratch.scale.set(0.004, NOTE, NOTE * (0.85 + random() * 0.3));
      scratch.updateMatrix();
      papers.setMatrixAt(paper, scratch.matrix);
      papers.setColorAt(paper, tint.set(PAPERS[Math.floor(random() * PAPERS.length) % PAPERS.length]));
      paper++;
      scratch.position.set(x + 0.01 + layer * 0.004, y + NOTE * 0.36 + layer * -0.018, z + layer * 0.022);
      scratch.rotation.set(0, 0, 0);
      scratch.scale.setScalar(1);
      scratch.updateMatrix();
      pins.setMatrixAt(pin, scratch.matrix);
      pins.setColorAt(pin, tint.set(PINS[Math.floor(random() * PINS.length) % PINS.length]));
      pin++;
    };
    for (const place of placed) put(place.position[0], place.position[1], place.position[2], place.id, 0);
    // Past sixty the notes layer over the first ones, a little lower and to the side.
    for (let index = 0; index < Math.min(notes.layered, placed.length); index++) {
      const place = placed[index];
      put(place.position[0], place.position[1], place.position[2], `layer:${index}`, 1);
    }
    for (let index = 0; index < notes.loose; index++) {
      const random = mulberry32(hashId(`inbox:${index}`, 73));
      scratch.position.set(DESK.x + (random() - 0.5) * 0.3, DESK.y + index * 0.0025, DESK.z + (random() - 0.5) * 0.32);
      scratch.rotation.set(0, random() * Math.PI, 0);
      scratch.scale.set(NOTE * 1.2, 0.002, NOTE * 1.2);
      scratch.updateMatrix();
      papers.setMatrixAt(paper, scratch.matrix);
      papers.setColorAt(paper, tint.set(PAPERS[Math.floor(random() * PAPERS.length) % PAPERS.length]));
      paper++;
    }
    setDrawCount(papers, paper);
    setDrawCount(pins, pin);
    markForUpload(papers.instanceMatrix);
    markForUpload(papers.instanceColor);
    markForUpload(pins.instanceMatrix);
    markForUpload(pins.instanceColor);
    get().gl.shadowMap.needsUpdate = true;
  }, [rig, placed, notes.layered, notes.loose, get]);

  const [bx, by, bz] = ANCHORS.board;
  return (
    <group>
      {!wide && <CorkboardFrame />}
      <primitive object={rig.papers} />
      <primitive object={rig.pins} />
      <Hotspot kind="notes" id="board" size={[0.2, 0.7, wide ? PINBOARD.width + 0.1 : 1.4]} position={[bx + 0.08, by, wide ? PINBOARD.centre : bz]} />
      {/* Loose notes sit on the lamp's desk: their spot wins over the desk's. */}
      {notes.loose > 0 && <Hotspot kind="notes" id="inbox" size={[0.42, 0.08, 0.45]} position={[DESK.x, DESK.y + 0.03, DESK.z]} priority={1} />}
    </group>
  );
}
