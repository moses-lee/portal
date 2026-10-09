"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { BufferAttribute, BufferGeometry, CanvasTexture, Color, FogExp2, MeshBasicMaterial, ShaderMaterial, Vector3, type Mesh } from "three";
import type { RoomWeather } from "@portal/contracts/room";
import { mulberry32 } from "@portal/shared/room";
import { ROOM } from "../layout";
import { skyColours, type RoomCondition, type SunClock } from "../sun";
import { WindowView } from "./Window";

/** The thunder flash, 0..1, decaying over ~150 ms; the sky and the fill light brighten with it. */
let flash = 0;
export function thunderFlash(): number {
  return flash;
}

/** The most drops or flakes ever drawn; fewer are drawn by setting the draw range, never by rebuilding. */
const MAX_PARTICLES = 600;

type Fall = { count: number; speed: number; snow: number; size: number; opacity: number };

const NONE: Fall = { count: 0, speed: 0, snow: 0, size: 0, opacity: 0 };
const FALLS: Partial<Record<RoomCondition, Fall>> = {
  drizzle: { count: 300, speed: 6, snow: 0, size: 14, opacity: 0.35 },
  rain: { count: 450, speed: 9, snow: 0, size: 18, opacity: 0.45 },
  "heavy-rain": { count: 600, speed: 12, snow: 0, size: 22, opacity: 0.55 },
  thunderstorm: { count: 600, speed: 12, snow: 0, size: 22, opacity: 0.55 },
  snow: { count: 450, speed: 0.9, snow: 1, size: 10, opacity: 0.85 },
};

/** Cloud cover (0..1) and how dark the clouds are, by condition; the provider's cloud cover nudges it. */
const CLOUDS: Record<RoomCondition, { cover: number; shade: number }> = {
  clear: { cover: 0.05, shade: 0 },
  "partly-cloudy": { cover: 0.55, shade: 0 },
  overcast: { cover: 1, shade: 0.35 },
  fog: { cover: 0.7, shade: 0.15 },
  drizzle: { cover: 0.9, shade: 0.3 },
  rain: { cover: 1, shade: 0.45 },
  "heavy-rain": { cover: 1, shade: 0.55 },
  snow: { cover: 0.9, shade: 0.2 },
  thunderstorm: { cover: 1, shade: 0.65 },
};

const FOG: Partial<Record<RoomCondition, number>> = {
  fog: 0.03,
  overcast: 0.008,
  drizzle: 0.008,
  rain: 0.01,
  "heavy-rain": 0.014,
  snow: 0.012,
  thunderstorm: 0.012,
};

const FALL_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uSnow;
uniform float uSize;
uniform vec3 uBoxMin;
uniform vec3 uBoxSize;
attribute float aRand;
void main() {
  vec3 p = position;
  float fall = uTime * uSpeed * (0.75 + 0.5 * aRand);
  p.y = fract(p.y - fall / uBoxSize.y);
  p.x = fract(p.x + uSnow * 0.025 * sin(uTime * 0.8 + aRand * 6.2831) - (1.0 - uSnow) * 0.04 * fall / uBoxSize.y);
  vec4 mv = modelViewMatrix * vec4(uBoxMin + p * uBoxSize, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.6 + 0.8 * aRand) * (12.0 / -mv.z);
}`;

const FALL_FRAGMENT = /* glsl */ `
uniform float uSnow;
uniform float uOpacity;
uniform vec3 uColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float drop = (1.0 - smoothstep(0.03, 0.08, abs(c.x))) * (1.0 - smoothstep(0.25, 0.5, abs(c.y)));
  float flake = 1.0 - smoothstep(0.15, 0.5, length(c));
  float alpha = mix(drop, flake, uSnow) * uOpacity;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(uColor, alpha);
}`;

/** A soft round blob, drawn once, for the cloud sprites. */
function cloudTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  for (const [x, y, r] of [
    [40, 38, 22],
    [64, 30, 26],
    [88, 38, 20],
    [62, 42, 24],
  ] as const) {
    const gradient = context.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  return new CanvasTexture(canvas);
}

const CLOUD_SLOTS = [
  { x: -6, y: 2.6, scale: 7, speed: 0.12 },
  { x: -1, y: 1.4, scale: 9, speed: 0.08 },
  { x: 4, y: 3.2, scale: 6, speed: 0.15 },
  { x: 8, y: 0.6, scale: 8, speed: 0.1 },
  { x: 1.5, y: 4.2, scale: 5, speed: 0.18 },
] as const;
const CLOUD_SPAN = 22;

/**
 * The weather's three.js objects behind a small API, created once per mount: the particle field
 * (positions in a unit box, scaled in the shader), its material, and the cloud sprites' materials.
 */
function createWeatherRig() {
  const random = mulberry32(7);
  const positions = new Float32Array(MAX_PARTICLES * 3);
  const seeds = new Float32Array(MAX_PARTICLES);
  for (let index = 0; index < MAX_PARTICLES; index++) {
    positions[index * 3] = random();
    positions[index * 3 + 1] = random();
    positions[index * 3 + 2] = random();
    seeds[index] = random();
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("aRand", new BufferAttribute(seeds, 1));
  const fallMaterial = new ShaderMaterial({
    vertexShader: FALL_VERTEX,
    fragmentShader: FALL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uSnow: { value: 0 },
      uSize: { value: 0 },
      uOpacity: { value: 0 },
      uColor: { value: new Color("#dfe8f2") },
      uBoxMin: { value: new Vector3(ROOM.window.x - 3, -3, ROOM.back - 7) },
      uBoxSize: { value: new Vector3(6, 8, 6.6) },
    },
  });
  const texture = cloudTexture();
  const cloudMaterials = CLOUD_SLOTS.map(() => new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, fog: false, opacity: 0 }));
  const uniforms = fallMaterial.uniforms;
  return {
    geometry,
    fallMaterial,
    cloudMaterials,
    setFall(fall: Fall, dpr: number) {
      geometry.setDrawRange(0, fall.count);
      uniforms.uSpeed.value = fall.speed;
      uniforms.uSnow.value = fall.snow;
      uniforms.uSize.value = fall.size * dpr;
      uniforms.uOpacity.value = fall.opacity;
    },
    /** Tint the clouds from the horizon, darkened by `shade`; low `cover` shows the first few only. */
    setClouds(horizon: string, shade: number, cover: number) {
      const tint = new Color(horizon).lerp(new Color("#ffffff"), 0.45).multiplyScalar(1 - shade);
      cloudMaterials.forEach((material, index) => {
        material.color.copy(tint);
        material.opacity = Math.max(0, Math.min(1, cover * CLOUD_SLOTS.length - index)) * 0.85;
      });
    },
    tick(time: number) {
      uniforms.uTime.value = time;
    },
    dispose() {
      geometry.dispose();
      fallMaterial.dispose();
      texture.dispose();
      for (const material of cloudMaterials) material.dispose();
    },
  };
}

/**
 * The weather through the window (docs/PALACE.md, Weather through the window): rain or snow as up to
 * 600 points in a box outside the glass, moved in the vertex shader; five cloud sprites scrolling
 * past; a thunder flash; fog density on grey days. Everything is mounted from the start and driven
 * by draw range, opacity and visibility, so a change of weather never compiles a shader.
 */
export default function Weather({
  weather,
  clock,
  reducedMotion,
}: {
  weather: RoomWeather | null;
  clock: SunClock;
  reducedMotion: boolean;
}) {
  const condition: RoomCondition = weather?.condition ?? "clear";
  const dpr = useThree((state) => state.viewport.dpr);

  const rig = useMemo(() => createWeatherRig(), []);
  useEffect(() => () => rig.dispose(), [rig]);

  const fall = FALLS[condition] ?? NONE;
  useEffect(() => rig.setFall(fall, dpr), [rig, fall, dpr]);

  const colours = skyColours(clock.sun.altitude, condition);
  const reported = weather ? weather.cloudCover / 100 : null;
  const clouds = CLOUDS[condition];
  const cover = reported === null ? clouds.cover : (clouds.cover + reported) / 2;
  useEffect(() => rig.setClouds(colours.horizon, clouds.shade, cover), [rig, colours.horizon, clouds.shade, cover]);

  const get = useThree((state) => state.get);
  const fogDensity = FOG[condition] ?? 0;
  useEffect(() => {
    const fog = get().scene.fog;
    if (!(fog instanceof FogExp2)) return;
    fog.density = fogDensity;
    fog.color.set(colours.horizon).lerp(new Color("#8b8f94"), 0.5);
  }, [get, fogDensity, colours.horizon]);

  const cloudMeshes = useRef<(Mesh | null)[]>([]);
  const nextFlash = useRef(0);
  useFrame((state, delta) => {
    if (reducedMotion) {
      flash = 0;
      return;
    }
    const time = state.clock.elapsedTime;
    rig.tick(time);
    cloudMeshes.current.forEach((mesh, index) => {
      if (!mesh) return;
      const slot = CLOUD_SLOTS[index];
      mesh.position.x = ((((slot.x + time * slot.speed + CLOUD_SPAN / 2) % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN) - CLOUD_SPAN / 2;
    });
    if (condition === "thunderstorm") {
      if (time >= nextFlash.current) {
        flash = 1;
        nextFlash.current = time + 4 + Math.random() * 9;
      } else flash = Math.max(0, flash - delta * 7);
    } else flash = 0;
  });

  return (
    <group>
      <points geometry={rig.geometry} material={rig.fallMaterial} visible={!reducedMotion && fall.count > 0} frustumCulled={false} />
      <WindowView distance={42}>
        {CLOUD_SLOTS.map((slot, index) => (
          <mesh
            key={index}
            ref={(mesh) => {
              cloudMeshes.current[index] = mesh;
            }}
            position={[slot.x, slot.y, 0]}
            material={rig.cloudMaterials[index]}
            renderOrder={-1}
          >
            <planeGeometry args={[slot.scale, slot.scale / 2]} />
          </mesh>
        ))}
      </WindowView>
    </group>
  );
}

