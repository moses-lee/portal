"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { reachedSet } from "./growth";
import { framePose, layoutOffset, readLayout, subscribeLayout } from "./layout";
// The extension is explicit: on a case-insensitive disk "./sketch" could resolve to this file.
import { sketchFigure, sketchStrokes } from "./sketch.ts";
import type { RoomMilestone } from "@portal/contracts/room";

/** The draw-in plays the first time a sketch shows in a page load, and never again. */
let drawnIn = false;

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The room drawn in pencil (docs/PALACE.md, Revision 2, The sketch): shown under the canvas while
 * the room loads, after a lost context, and for the visit without WebGL, after a canvas failure or
 * under reduced transparency. An inline SVG lined up with the 3D room: the walls a shade lighter
 * than the warm dark ground, the window's panes filled with the sky's colours (`--room-sky-*`,
 * set by `RoomBackground`), soft glows at the lamp and the hearth, and the room's edges in pale
 * pencil (`sketch.ts`), projected with the camera's pose and view offset whenever the layout
 * registry's measure changes; nothing is drawn before the first measure. The strokes draw in, back
 * wall first, the first time a sketch shows in the page load; later it comes back complete, fading
 * in from the ground. `milestones` are the room's, when its state is known as the sketch mounts:
 * they change only the lines they change, and later changes are not followed.
 */
export default function Sketch({ milestones }: { milestones: readonly RoomMilestone[] | null }) {
  const layout = useSyncExternalStore(subscribeLayout, readLayout, readLayout);
  const [reached] = useState(() => reachedSet(milestones));
  const strokes = useMemo(() => sketchStrokes(reached), [reached]);
  const [drawIn] = useState(() => !drawnIn);
  const id = useId();
  const { width, height } = layout;
  const figure = useMemo(() => {
    if (!width || !height) return null;
    const pose = framePose(width / height);
    return sketchFigure(pose, layoutOffset(layout, pose), { width, height }, strokes, reached.has("bay-window"));
  }, [layout, width, height, strokes, reached]);
  const shown = figure !== null;
  useEffect(() => {
    if (shown) drawnIn = true;
  }, [shown]);

  const sky = `${id}-sky`;
  const lamp = `${id}-lamp`;
  const hearth = `${id}-hearth`;
  return (
    <svg
      className="room-sketch"
      data-room-sketch=""
      data-draw-in={drawIn ? "" : undefined}
      data-window={figure ? `${round(figure.window.x)},${round(figure.window.y)}` : undefined}
      width={width || undefined}
      height={height || undefined}
      viewBox={figure ? `0 0 ${width} ${height}` : undefined}
      aria-hidden="true"
    >
      {figure && (
        <>
          <defs>
            <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="room-sketch-sky-top" />
              <stop offset="1" className="room-sketch-sky-horizon" />
            </linearGradient>
            <radialGradient id={lamp}>
              <stop offset="0" stopColor="#ffb86b" stopOpacity="0.32" />
              <stop offset="1" stopColor="#ffb86b" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={hearth}>
              <stop offset="0" stopColor="#ff7a3a" stopOpacity="0.3" />
              <stop offset="1" stopColor="#ff7a3a" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path d={figure.wall} className="room-sketch-wall" />
          <path d={figure.panes} fill={`url(#${sky})`} />
          {figure.hearth && <circle cx={figure.hearth.x} cy={figure.hearth.y} r={figure.hearth.r} fill={`url(#${hearth})`} />}
          {figure.lamp && <circle cx={figure.lamp.x} cy={figure.lamp.y} r={figure.lamp.r} fill={`url(#${lamp})`} />}
          <g className="room-sketch-strokes">
            {figure.strokes.map((stroke) => (
              <path key={stroke.id} d={stroke.d} pathLength={1} style={drawIn ? { animationDelay: `${stroke.delay}ms` } : undefined} />
            ))}
          </g>
        </>
      )}
    </svg>
  );
}
