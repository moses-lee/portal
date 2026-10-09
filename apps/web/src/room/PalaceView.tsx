"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useMediaQuery } from "@/components/useMediaQuery";
import { DEFAULT_LOOK, dragLook, flyTo, framingDistance, look, resetLook, zoomLook } from "./look";
import { requestRoomFrame } from "./loop";
import { setPalaceHandlers } from "./pointer";

/** The camera's vertical field of view (`cameraPose`), for framing an object. */
const FOV = 30;
/** A drag's spin is measured over its last moves; a pause longer than this before release leaves none. */
const RELEASE_MS = 80;

/**
 * The Palace page's room (docs/PALACE.md, Palace page): the view's whole area, see-through to the
 * shared canvas behind it, with a look-around camera on this page only. Drag (one finger on touch)
 * turns within ±20° of yaw and 10° to 40° of pitch and coasts on release; the wheel or a pinch zooms
 * between 0.85× and 1.3×; a double click or tap on an object flies to frame it over 600 ms, and
 * Escape or a click on empty floor flies back. Under reduced motion the flights are cuts and a drag
 * does not coast. Leaving the page puts the camera back. Hover cards and clicks come from the
 * page's room pointer (`pointer.ts`); the drift and parallax carry on underneath.
 */
export default function PalaceView() {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const element = useRef<HTMLElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const last = useRef({ x: 0, y: 0, at: 0, pinch: 0 });

  useEffect(() => {
    look.active = true;
    requestRoomFrame();
    return () => {
      look.active = false;
      resetLook();
      requestRoomFrame();
    };
  }, []);

  useEffect(() => {
    const flyBack = () => {
      if (look.focus === 0 && look.yaw === 0 && look.pitch === 0 && look.zoom === 1 && !look.flight) return;
      flyTo(DEFAULT_LOOK, 0, performance.now(), reducedMotion);
      requestRoomFrame();
    };
    setPalaceHandlers({
      onDouble: (hit) => {
        look.focusPoint = hit.centre;
        look.focusDistance = framingDistance(hit.radius, FOV);
        // Framing straightens the zoom; the turn the user chose stays.
        flyTo({ yaw: look.yaw, pitch: look.pitch, zoom: 1 }, 1, performance.now(), reducedMotion);
        requestRoomFrame();
      },
      onEmpty: flyBack,
      onEscape: flyBack,
    });
    return () => setPalaceHandlers(null);
  }, [reducedMotion]);

  // The wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      Object.assign(look, zoomLook(look, Math.exp(-delta * 0.0015), look.basePitch));
      requestRoomFrame();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    look.dragging = true;
    look.velocity = { yaw: 0, pitch: 0 };
    look.flight = null;
    last.current = { x: event.clientX, y: event.clientY, at: performance.now(), pinch: spread() };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const now = performance.now();
    if (pointers.current.size >= 2) {
      // Pinch: the fingers' spread is the zoom.
      const current = spread();
      if (last.current.pinch > 0 && current > 0) Object.assign(look, zoomLook(look, current / last.current.pinch, look.basePitch));
      last.current = { ...last.current, pinch: current, at: now };
      requestRoomFrame();
      return;
    }
    const dx = event.clientX - last.current.x;
    const dy = event.clientY - last.current.y;
    const before = { yaw: look.yaw, pitch: look.pitch };
    Object.assign(look, dragLook(look, dx, dy, look.basePitch));
    const seconds = Math.max(0.001, (now - last.current.at) / 1000);
    // The spin a release leaves: the last moves' speed, smoothed.
    look.velocity = {
      yaw: look.velocity.yaw * 0.5 + ((look.yaw - before.yaw) / seconds) * 0.5,
      pitch: look.velocity.pitch * 0.5 + ((look.pitch - before.pitch) / seconds) * 0.5,
    };
    last.current = { x: event.clientX, y: event.clientY, at: now, pinch: 0 };
    requestRoomFrame();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) {
      // One finger left of a pinch carries on as a drag from where it is.
      const [rest] = [...pointers.current.values()];
      last.current = { x: rest.x, y: rest.y, at: performance.now(), pinch: 0 };
      return;
    }
    look.dragging = false;
    if (reducedMotion || performance.now() - last.current.at > RELEASE_MS) look.velocity = { yaw: 0, pitch: 0 };
    requestRoomFrame();
  };

  return (
    <section
      ref={element}
      aria-label="Palace"
      data-palace
      data-room-passthrough
      className="min-h-0 flex-1 cursor-grab touch-none select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
