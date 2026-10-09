"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { BoxGeometry, Color, InstancedMesh, Object3D } from "three";
import { hashId, MILESTONES } from "@portal/shared/room";
import type { BookSpec } from "../growth";
import { SMALL_SHELF } from "../layout";
import { capacityOf, furnitureFor, placeItems } from "../layout-slots";
import { InstancedHotspot, type HotspotSpot } from "./Hotspot";
import { instancedMatte, markForUpload, palette, setDrawCount } from "./materials";
import { Soft } from "./Shell";

/** The most books any shelving holds (both bookcases): the instanced meshes' size, made once. */
const LIMIT = capacityOf(furnitureFor("book", new Set(MILESTONES.map((milestone) => milestone.id))));
/** How far a book reaches into the shelf (x), and the slot's width for its hotspot. */
const DEPTH = 0.17;
const SLOT = 0.058;
const BAND = new Color("#efe3c8");
const scratch = new Object3D();
const tint = new Color();

/** The small shelf on the left wall the room starts with: one row of books on its lower board. */
function SmallShelf() {
  return (
    <group position={[SMALL_SHELF.x, 0, SMALL_SHELF.z]}>
      {SMALL_SHELF.boards.map((y) => (
        <Soft key={y} size={[SMALL_SHELF.depth, SMALL_SHELF.thickness, SMALL_SHELF.length]} position={[0, y, 0]} color={palette.woodLight} radius={0.012} />
      ))}
      {SMALL_SHELF.brackets.map((z) => (
        <Soft key={z} size={[0.24, 0.16, 0.04]} position={[0.02, 1.56, z]} color={palette.wood} radius={0.01} />
      ))}
    </group>
  );
}

/**
 * The books (docs/PALACE.md, Objects): one per session ever, on the shelves in rows of 24, the
 * first row on the small shelf and further rows on the bookcases the session milestones bring.
 * Spine colour from the session's project (a plain spine when the project is gone, greyer for a
 * purged session), height and thickness from the session id; some carry a pale band. Two instanced
 * meshes (the books and their bands) for every book, rewritten only when the books or the shelving
 * change, and one instanced hotspot so each book has its own card.
 */
export default function Books({ books, shown }: { books: readonly BookSpec[]; shown: ReadonlySet<string> }) {
  const get = useThree((state) => state.get);
  const tall = shown.has("tall-bookcase");
  const rig = useMemo(() => {
    const geometry = new BoxGeometry(1, 1, 1);
    const spines = new InstancedMesh(geometry, instancedMatte(), LIMIT);
    const bands = new InstancedMesh(geometry, instancedMatte(), LIMIT);
    for (let index = 0; index < LIMIT; index++) {
      spines.setColorAt(index, BAND);
      bands.setColorAt(index, BAND);
    }
    for (const mesh of [spines, bands]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    return { geometry, spines, bands };
  }, []);
  useEffect(
    () => () => {
      rig.geometry.dispose();
      rig.spines.dispose();
      rig.bands.dispose();
    },
    [rig],
  );

  const shelving = useMemo(() => furnitureFor("book", shown), [shown]);
  const placed = useMemo(() => {
    const { placed: places } = placeItems(
      books.map((book) => book.id),
      shelving,
      { unit: "row" },
    );
    const byId = new Map(books.map((book) => [book.id, book]));
    return places.map((place) => ({ place, book: byId.get(place.id)! }));
  }, [books, shelving]);

  useLayoutEffect(() => {
    const { spines, bands } = rig;
    let banded = 0;
    placed.forEach(({ place, book }, index) => {
      const [x, y, z] = place.position;
      // A slight lean on some books, from the id: never past the slot.
      const lean = (hashId(book.id, 61) % 7 === 0 ? 1 : 0) * 0.06;
      scratch.position.set(x, y + book.height / 2, z);
      scratch.rotation.set(lean, 0, 0);
      scratch.scale.set(DEPTH, book.height, book.thickness);
      scratch.updateMatrix();
      spines.setMatrixAt(index, scratch.matrix);
      spines.setColorAt(index, tint.set(book.colour));
      if (!book.purged && hashId(book.id, 67) % 3 === 0) {
        scratch.position.set(x + DEPTH / 2 + 0.002, y + book.height * 0.78, z);
        scratch.scale.set(0.006, 0.022, book.thickness * 0.9);
        scratch.updateMatrix();
        bands.setMatrixAt(banded, scratch.matrix);
        bands.setColorAt(banded, BAND);
        banded++;
      }
    });
    setDrawCount(spines, placed.length);
    setDrawCount(bands, banded);
    markForUpload(spines.instanceMatrix);
    markForUpload(spines.instanceColor);
    markForUpload(bands.instanceMatrix);
    markForUpload(bands.instanceColor);
    get().gl.shadowMap.needsUpdate = true;
  }, [rig, placed, get]);

  const spots = useMemo<HotspotSpot[]>(
    () =>
      placed.map(({ place, book }) => ({
        target: { kind: "book", id: book.id },
        position: [place.position[0], place.position[1] + book.height / 2, place.position[2]],
        size: [DEPTH + 0.04, book.height, SLOT],
      })),
    [placed],
  );

  return (
    <group>
      {!tall && <SmallShelf />}
      <primitive object={rig.spines} />
      <primitive object={rig.bands} />
      <InstancedHotspot spots={spots} />
    </group>
  );
}
