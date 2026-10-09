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
/** The shadow camera frames the room and the floor the camera sees beyond its open sides. */
const FRUSTUM = 10;
const WARM_WHITE = new Color("#fff1dc");
/** The sun's and the sky's strength at full day: the room is lit mostly by the sky, so it reads cream, not grey. */
const KEY = 3.4;
const FILL = 5.2;
/** At night the fill stays at this, cool from the night sky's colour: a room you can still see by. */
const NIGHT_FILL = 0.95;
const MOON_KEY = 0.9;
const NIGHT_SKY = new Color("#8f9cc8");

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
  // The moon is a stronger key than the ramp's dim tail would make it, so its light through the window still reads.
  const moonlight = ramp.moon ? MOON_KEY * (0.5 + 0.5 * clock.moon.fraction) : 0;
  const intensity = ramp.moon ? Math.max(ramp.sun * KEY, moonlight) * through : ramp.sun * KEY * through;
  // The fill is the sky's colour washed towards warm white, so the room reads cream by day, not blue.
  // At night it turns to a moonlit blue-grey over the last of the twilight.
  const dusk = Math.min(1, Math.max(0, (clock.sun.altitude / DEGREE + 8) / 8));
  const sky = `#${NIGHT_SKY.clone().lerp(new Color(skyColours(clock.sun.altitude, condition).zenith).lerp(WARM_WHITE, 0.6), dusk * dusk * (3 - 2 * dusk)).getHexString()}`;
  const fill = Math.max(NIGHT_FILL, ramp.sky * FILL) * (1 + 0.35 * (1 - through));
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
