"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, type DirectionalLight, type HemisphereLight } from "three";
import { kelvinToRgb, sunRamp } from "@portal/shared/room";
import { useMediaQuery } from "@/components/useMediaQuery";
import { directionFrom, skyColours, sunThrough, type RoomCondition, type SunClock } from "../sun";
import { thunderFlash } from "./Weather";

const DEGREE = Math.PI / 180;
/** The key light never comes from lower than this, so a setting sun still reaches in through the window. */
const LOWEST = 4 * DEGREE;
/** With the moon down too, a cool light from high over the window. */
const NO_MOON = { altitude: 35 * DEGREE, azimuth: 0 };
const DISTANCE = 20;
/** The shadow camera frames the room and no more (the walls run on past it). */
const FRUSTUM = 7.5;
const WARM_WHITE = new Color("#fff1dc");

/**
 * The sun (docs/PALACE.md, Lighting): one shadow-casting directional light placed from the sun's
 * altitude and azimuth, coloured by the Kelvin ramp, dimmed by grey weather; below the horizon it
 * is the moon, dim and cool. A hemisphere light gives sky and ground fill from the same ramp. The
 * shadow map renders only when the light moves (`autoUpdate` is off on the renderer).
 */
export default function Sun({ clock, condition }: { clock: SunClock; condition: RoomCondition }) {
  const get = useThree((state) => state.get);
  const small = useMediaQuery("(max-width: 640px)");
  const light = useRef<DirectionalLight>(null);
  const hemisphere = useRef<HemisphereLight>(null);

  const ramp = sunRamp(clock.sun.altitude);
  const body = !ramp.moon ? clock.sun : clock.moon.altitude > 0 ? clock.moon : NO_MOON;
  const [x, y, z] = directionFrom(Math.max(LOWEST, body.altitude), body.azimuth);
  const rgb = kelvinToRgb(ramp.kelvin);
  const through = sunThrough(condition);
  const moonlight = ramp.moon ? 0.45 + 0.55 * clock.moon.fraction : 1;
  const intensity = ramp.sun * 3.2 * through * moonlight;
  // The fill is the sky's colour washed towards warm white, so the room reads cream by day, not blue.
  const sky = `#${new Color(skyColours(clock.sun.altitude, condition).zenith).lerp(WARM_WHITE, 0.6).getHexString()}`;
  const fill = ramp.sky * 3.2 * (1 + 0.35 * (1 - through));
  const mapSize = small ? 512 : 1024;

  useEffect(() => {
    const key = light.current;
    if (!key) return;
    if (key.shadow.mapSize.x !== mapSize) {
      key.shadow.mapSize.set(mapSize, mapSize);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    get().gl.shadowMap.needsUpdate = true;
  }, [get, x, y, z, mapSize]);

  useFrame(() => {
    if (hemisphere.current) hemisphere.current.intensity = fill + thunderFlash() * 1.5;
  });

  return (
    <>
      <directionalLight
        ref={light}
        position={[x * DISTANCE, y * DISTANCE, z * DISTANCE]}
        intensity={intensity}
        color={[rgb.r, rgb.g, rgb.b]}
        castShadow
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-camera-left={-FRUSTUM}
        shadow-camera-right={FRUSTUM}
        shadow-camera-top={FRUSTUM}
        shadow-camera-bottom={-FRUSTUM}
        shadow-camera-near={1}
        shadow-camera-far={DISTANCE * 2.2}
      />
      <hemisphereLight ref={hemisphere} color={sky} groundColor="#a27a55" intensity={fill} />
    </>
  );
}
