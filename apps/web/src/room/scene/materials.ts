/**
 * The room's palette and shared materials (docs/PALACE.md, decision 3): matte flat colours with one
 * roughness, no metal. Materials are created once per colour and shared, so the scene compiles a
 * handful of programs at start and none later.
 */
import { Color, MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from "three";
import { ROOM } from "../layout";

/** The one roughness every surface shares. */
export const ROUGHNESS = 0.86;

export const palette = {
  wall: "#e8d6bb",
  wallTrim: "#d9c09c",
  floor: "#b7875c",
  floorDark: "#9c6f48",
  rug: "#c8765e",
  rugBorder: "#ecc47c",
  wood: "#8e5d3d",
  woodLight: "#b88a5f",
  frame: "#f1e7d4",
  chair: "#6f9172",
  shade: "#f4d58c",
  brass: "#c9a46a",
  brick: "#b06a50",
  firebox: "#2c1b15",
  hallway: "#3b2b21",
  sill: "#efe3cb",
  glass: "#dfeefa",
} as const;

const matte = new Map<string, MeshStandardMaterial>();

/** The shared matte material for a colour. */
export function matteMaterial(color: string): MeshStandardMaterial {
  let material = matte.get(color);
  if (!material) {
    material = new MeshStandardMaterial({ color: new Color(color), roughness: ROUGHNESS, metalness: 0 });
    matte.set(color, material);
  }
  return material;
}

const shell = new Map<string, MeshStandardMaterial>();

/**
 * The shell's material: matte, with corner darkening baked into the shader from world position
 * (where the floor meets a wall, and the two walls meet, it falls off over about a metre). Cheaper
 * than ambient occlusion and stable: it never changes, so it compiles once.
 */
export function shellMaterial(color: string): MeshStandardMaterial {
  let material = shell.get(color);
  if (!material) {
    material = new MeshStandardMaterial({ color: new Color(color), roughness: ROUGHNESS, metalness: 0 });
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRoomWorld;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvRoomWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRoomWorld;")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            float reach = 1.1;
            float nearFloor = 1.0 - smoothstep(0.0, reach, vRoomWorld.y);
            float nearLeft = 1.0 - smoothstep(0.0, reach, vRoomWorld.x - (${ROOM.left.toFixed(2)}));
            float nearBack = 1.0 - smoothstep(0.0, reach, vRoomWorld.z - (${ROOM.back.toFixed(2)}));
            // A surface is "near" its own plane everywhere; the corner is where a second one is near too.
            float occlusion = clamp(nearFloor + nearLeft + nearBack - max(nearFloor, max(nearLeft, nearBack)), 0.0, 1.0);
            diffuseColor.rgb *= 1.0 - 0.5 * occlusion * occlusion;
          }`,
        );
    };
    material.customProgramCacheKey = () => "room-shell";
    shell.set(color, material);
  }
  return material;
}

/**
 * Asks three.js to upload a changed buffer (an instance matrix or colour). A function rather than an
 * assignment in the component, so per-frame updates to objects a component made in a hook do not
 * read to React's compiler as mutating hook values.
 */
export function markForUpload(attribute: { needsUpdate: boolean } | null | undefined) {
  if (attribute) attribute.needsUpdate = true;
}

/** Sets a lit material's glow, for the same reason as `markForUpload`. */
export function setGlow(material: MeshStandardMaterial, intensity: number) {
  material.emissiveIntensity = intensity;
}

/** Sets how many instances an instanced mesh draws, for the same reason as `markForUpload`. */
export function setDrawCount(mesh: { count: number }, count: number) {
  mesh.count = count;
}
