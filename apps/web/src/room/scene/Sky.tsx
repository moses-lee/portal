"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import { BackSide, Color, ShaderMaterial } from "three";
import type { RoomCondition, SunClock } from "../sun";
import { skyColours } from "../sun";
import { thunderFlash } from "./Weather";
import { WindowView } from "./Window";

const DOME_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * The camera looks down through the window, so what it sees there is below the true horizon; the
 * gradient's horizon sits low (`uHorizonAt`) so the window shows sky, with a dark band of land under it.
 */
const DOME_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform float uHorizonAt;
uniform float uFlash;
varying vec3 vDirection;
void main() {
  float h = vDirection.y - uHorizonAt;
  vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
  vec3 colour = h < 0.0 ? mix(uHorizon * 0.55, uGround, smoothstep(0.0, 0.05, -h)) : sky;
  colour += uFlash * vec3(0.55, 0.58, 0.7);
  gl_FragColor = vec4(colour, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const MOON_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** A disc lit from the side by phase: 0 new, 0.5 full; the terminator is a sphere's, softened. */
const MOON_FRAGMENT = /* glsl */ `
uniform float uPhase;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  vec3 n = vec3(p, sqrt(1.0 - r2));
  float angle = uPhase * 6.28318530718;
  vec3 light = vec3(sin(angle), 0.0, -cos(angle));
  float lit = smoothstep(-0.06, 0.12, dot(n, light));
  vec3 colour = mix(vec3(0.07, 0.08, 0.12), vec3(0.96, 0.94, 0.86), lit);
  float edge = 1.0 - smoothstep(0.9, 1.0, r2);
  gl_FragColor = vec4(colour, edge * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const DEGREE = Math.PI / 180;

/*
 * The shaders end as three's own materials do (tone mapping, then the output transfer), so they are
 * encoded exactly once whatever they render into: into the frost's scene target both are no-ops and
 * the composite encodes the frame (`FrostPass`).
 */

/** The dome's and the moon's materials behind a small API, created once per mount. */
function createSkyRig() {
  const dome = new ShaderMaterial({
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new Color() },
      uHorizon: { value: new Color() },
      uGround: { value: new Color("#1f2a22") },
      uHorizonAt: { value: -0.56 },
      uFlash: { value: 0 },
    },
  });
  const moon = new ShaderMaterial({
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { uPhase: { value: 0.5 }, uOpacity: { value: 1 } },
  });
  return {
    dome,
    moon,
    setColours(zenith: string, horizon: string, ground: string) {
      dome.uniforms.uZenith.value.set(zenith);
      dome.uniforms.uHorizon.value.set(horizon);
      dome.uniforms.uGround.value.set(ground);
    },
    setMoon(phase: number, opacity: number) {
      moon.uniforms.uPhase.value = phase;
      moon.uniforms.uOpacity.value = opacity;
    },
    setFlash(flash: number) {
      dome.uniforms.uFlash.value = flash;
    },
    dispose() {
      dome.dispose();
      moon.dispose();
    },
  };
}

/** The sky (docs/PALACE.md, Lighting): a gradient dome from the sun ramp, stars at night, the moon by phase. */
export default function Sky({ clock, condition }: { clock: SunClock; condition: RoomCondition }) {
  const rig = useMemo(() => createSkyRig(), []);
  useEffect(() => () => rig.dispose(), [rig]);

  const altitude = clock.sun.altitude;
  const colours = skyColours(altitude, condition);
  // Land under the horizon: green-grey by day, nearly black at night.
  const ground = altitude > 0 ? "#43553f" : "#121813";
  useEffect(() => rig.setColours(colours.zenith, colours.horizon, ground), [rig, colours.zenith, colours.horizon, ground]);

  const clearish = condition === "clear" || condition === "partly-cloudy";
  const degrees = altitude / DEGREE;
  const starsVisible = degrees < -6 && clearish;
  const moonUp = clock.moon.altitude > 0 && degrees < 4 && condition !== "fog" && condition !== "overcast";
  // The moon in the window: its azimuth and altitude spread across what the glass frames.
  const moonX = Math.max(-1, Math.min(1, Math.sin(clock.moon.azimuth))) * 3.2;
  const moonY = -1.2 + Math.min(1, clock.moon.altitude / (55 * DEGREE)) * 3.4;
  useEffect(() => rig.setMoon(clock.moon.phase, clearish ? 1 : 0.55), [rig, clock.moon.phase, clearish]);

  useFrame(() => rig.setFlash(thunderFlash()));

  return (
    <group>
      <mesh material={rig.dome} renderOrder={-2}>
        <sphereGeometry args={[90, 32, 16]} />
      </mesh>
      <group visible={starsVisible}>
        <Stars radius={60} depth={20} count={1000} factor={3} saturation={0} fade speed={0.4} />
      </group>
      <WindowView distance={55}>
        <mesh material={rig.moon} position={[moonX, moonY, 0]} visible={moonUp} renderOrder={-1}>
          <planeGeometry args={[2.1, 2.1]} />
        </mesh>
      </WindowView>
    </group>
  );
}
