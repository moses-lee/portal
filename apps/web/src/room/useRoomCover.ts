"use client";

import { useEffect, useRef, type RefObject } from "react";
import { registerCover, type CoverKind } from "./layout";

/**
 * A ref that reports its element as covering the room (docs/PALACE.md, Camera) while it is mounted,
 * registered in an effect. For elements whose `ref` goes through another component's ref merger
 * (the message scroller's content), which drops a callback ref's cleanup: `roomCover` would leave
 * the element in the registry after it unmounts.
 */
export function useRoomCover<T extends Element>(kind: CoverKind): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => (ref.current ? registerCover(ref.current, kind) : undefined), [kind]);
  return ref;
}
