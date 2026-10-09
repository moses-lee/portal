"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { framePose, layoutOffset, readLayout, subscribeLayout } from "./layout";
import { snapshotPlacement, type SnapshotRecord } from "./snapshot.ts";

/**
 * The snapshot shown before the room draws (docs/PALACE.md, Revision 2, The snapshot): the stored
 * frame from an object URL, put on the page only once `img.decode()` has finished with it, then
 * drawn at its stored size times the viewport's height over the stored height and translated by
 * the difference of the view offsets (`snapshotPlacement`), so what it shows lands where the camera
 * will draw it. It follows the layout registry's measure as the camera's view offset does; edges
 * that fall short show the ground. The object URL is revoked when it unmounts. `onFail`: the image
 * could not be decoded (the background shows the sketch instead).
 */
export default function SnapshotImage({ record, onFail }: { record: SnapshotRecord; onFail: () => void }) {
  const layout = useSyncExternalStore(subscribeLayout, readLayout, readLayout);
  /** The object URL, once its image has decoded. */
  const [url, setUrl] = useState<string | null>(null);
  const failRef = useRef(onFail);
  useEffect(() => {
    failRef.current = onFail;
  }, [onFail]);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(record.blob);
    let live = true;
    const decoder = new Image();
    decoder.src = objectUrl;
    decoder.decode().then(
      () => {
        if (live) setUrl(objectUrl);
      },
      () => {
        if (live) failRef.current();
      },
    );
    return () => {
      live = false;
      setUrl(null);
      URL.revokeObjectURL(objectUrl);
    };
  }, [record]);

  const { width, height } = layout;
  const box = useMemo(() => {
    if (!width || !height) return null;
    const pose = framePose(width / height);
    const offset = layoutOffset(layout, pose);
    return snapshotPlacement(record, { width, height, offset: { x: offset.x, y: offset.y } });
  }, [layout, width, height, record]);

  if (!url || !box) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset
    <img
      className="room-snapshot"
      data-room-snapshot=""
      src={url}
      alt=""
      style={{ width: box.width, height: box.height, transform: `translate(${box.x}px, ${box.y}px)` }}
    />
  );
}
