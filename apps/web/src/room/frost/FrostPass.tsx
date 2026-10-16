"use client";

import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  HalfFloatType,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  MaxEquation,
  Mesh,
  NoBlending,
  OrthographicCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type IUniform,
  type Texture,
  type WebGLRenderer,
} from "three";
import { glassLight } from "./light";
import { collectFrost, FLOATS_PER_PANEL, resetFrost, type FrostBuffer } from "./registry";
import {
  compositeFragment,
  downsampleFragment,
  fullscreenVertex,
  kawaseDownFragment,
  kawaseUpFragment,
  lensFragment,
  lensVertex,
  maskFragment,
  maskVertex,
} from "./shaders";

/** CSS `saturate(135%)`, as the panels' backdrop filter had. */
export const SATURATION = 1.35;
/**
 * The Kawase taps' reach in source texels at a pixel ratio of 1.5, the canvas's cap; scaled with
 * the ratio so the blur is the same size in CSS pixels on any screen. 2.5 matched CSS
 * `blur(28px) saturate(135%)` side by side over the room at ratios 1 and 2.
 */
export const SPREAD = 2.5;
const REFERENCE_DPR = 1.5;

/**
 * Liquid glass (docs/GLASS.md, Liquid glass), in CSS pixels: the bevel's width inside a liquid
 * panel's edge, the most the room is shifted outwards at its rim (the subtle setting; it falls off
 * inwards with the bevel's slope, to none at its inner edge), the fringe's extra shift for red and
 * blue, and the rim highlight's width.
 */
export const BEVEL_PX = 18;
export const LENS_SHIFT_PX = 8;
export const FRINGE_PX = 1.5;
export const RIM_PX = 1.5;
/** The rim highlight at full daylight, added to display values before the DOM tint goes over it. */
export const HIGHLIGHT = 0.55;
/** Warm white from the sun, cool white from the moon (sRGB, 0..1). */
const SUN_WHITE = new Color(1, 0.945, 0.863);
const MOON_WHITE = new Color(0.85, 0.9, 1);
/**
 * The targets' empty values, as written (the targets have no colour space, so three converts nothing).
 * The lens's is cleared with alpha 1: three premultiplies the clear colour by its alpha (the context's
 * `premultipliedAlpha`), so alpha 0 would clear the direction to (0, 0), that is (-1, -1).
 */
const BLACK = new Color(0, 0, 0);
const LENS_EMPTY = new Color(0.5, 0.5, 0);
const LENS_EMPTY_ALPHA = 1;

/** The lens target's distance range in canvas pixels: the rim and a lens texel either side, four times over (steps of ~1/15 px). */
export const lensRange = (rim: number, texelSize: number) => 4 * (rim + texelSize);

const pass = (fragmentShader: string, uniforms: Record<string, IUniform>) =>
  new ShaderMaterial({ vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });

const target = (type: typeof HalfFloatType | typeof UnsignedByteType, options: { depth?: boolean; red?: boolean } = {}) =>
  new WebGLRenderTarget(1, 1, {
    type,
    format: options.red ? RedFormat : undefined,
    depthBuffer: options.depth ?? false,
    stencilBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
  });

/** Whether the target had to change size (its contents are gone then). */
const resize = (renderTarget: WebGLRenderTarget, width: number, height: number): boolean => {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  // setSize reallocates on the GPU; only when the size really changed.
  if (renderTarget.width === w && renderTarget.height === h) return false;
  renderTarget.setSize(w, h);
  return true;
};

/** Sets `uniform` to one texel of `renderTarget` in UV units, times `spread`. */
const texel = (uniform: IUniform, renderTarget: WebGLRenderTarget, spread = 1) =>
  (uniform.value as Vector2).set(spread / renderTarget.width, spread / renderTarget.height);

/**
 * The frost pipeline (docs/PALACE.md, Web → Frost), owned by one renderer:
 *
 * 1. the scene into a full-size render target (half float, before tone mapping);
 * 2. a 4 × 4 box downsample to a quarter of the size;
 * 3. three dual-Kawase passes: down to an eighth, down to a sixteenth, up to an eighth;
 * 4. the frosted panels as rounded rectangles into a half-size R8 mask;
 * 5. the liquid panels alone into a half-size RGBA8 lens target (direction and opacity, bevel amount, distance to the edge);
 * 6. a composite to the screen: the last Kawase upsample, tone mapping, saturation for the blurred
 *    copy, and the sharp scene and the copy mixed by the mask; in a liquid panel's bevel the copy is
 *    read bent outwards with a colour fringe, and the rim gets a highlight lit from the sun.
 *
 * Every frame takes this path, so every material compiles once, for a render target (linear, no tone
 * mapping), and the composite alone encodes for the screen. Frames with no frosted panel skip the
 * blur and the mask (cleared once) and run the composite, which then passes the scene through;
 * frames with no liquid panel leave the lens target cleared and the composite skips its taps.
 * Targets are created once and resized only when the canvas's size changes.
 */
class FrostPipeline {
  private readonly renderer: WebGLRenderer;
  private readonly scene = target(HalfFloatType, { depth: true });
  private readonly quarter = target(HalfFloatType);
  private readonly eighth = target(HalfFloatType);
  private readonly sixteenth = target(HalfFloatType);
  private readonly mask = target(UnsignedByteType, { red: true });
  private readonly lens = target(UnsignedByteType);

  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fullscreen = new Mesh(this.fullscreenGeometry());
  private readonly fullscreenScene = new Scene().add(this.fullscreen);

  private readonly downsample = pass(downsampleFragment, { tInput: { value: null }, uTexel: { value: new Vector2() } });
  private readonly kawaseDown = pass(kawaseDownFragment, { tInput: { value: null }, uOffset: { value: new Vector2() } });
  private readonly kawaseUp = pass(kawaseUpFragment, { tInput: { value: null }, uOffset: { value: new Vector2() } });
  private readonly composite = pass(compositeFragment, {
    tScene: { value: null },
    tBlur: { value: null },
    tMask: { value: null },
    tLens: { value: null },
    uOffset: { value: new Vector2() },
    uSaturation: { value: SATURATION },
    uLens: { value: 0 },
    uShift: { value: new Vector2() },
    uFringe: { value: new Vector2() },
    uSun: { value: new Vector2(0, 1) },
    uHighlight: { value: new Color(0, 0, 0) },
    uRange: { value: 1 },
    uRim: { value: RIM_PX },
  });

  private readonly buffer: FrostBuffer = { data: new Float32Array(32 * FLOATS_PER_PANEL), liquid: 0 };
  private readonly maskMaterial = new ShaderMaterial({
    vertexShader: maskVertex,
    fragmentShader: maskFragment,
    uniforms: { uResolution: { value: new Vector2() }, uTexelSize: { value: 2 } },
    blending: CustomBlending,
    blendEquation: MaxEquation,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  private maskMesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly maskScene = new Scene();
  /** Written, not blended: liquid panels never overlap, and A is a distance, not an opacity. */
  private readonly lensMaterial = new ShaderMaterial({
    vertexShader: lensVertex,
    fragmentShader: lensFragment,
    uniforms: { uResolution: { value: new Vector2() }, uTexelSize: { value: 2 }, uBevel: { value: BEVEL_PX }, uRange: { value: 1 } },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  /** The lens pass's mesh: the mask's instanced geometry, drawn again with the lens material. */
  private lensMesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly lensScene = new Scene();
  private readonly sun = new Vector3();
  private instances: InstancedInterleavedBuffer;

  private readonly clearColor = new Color();
  private readonly space = { left: 0, top: 0, width: 0, height: 0, bufferWidth: 0, bufferHeight: 0 };
  private reported = -1;
  /** The mask holds nothing (cleared since the last panel was drawn into it, at its current size). */
  private maskEmpty = false;
  /** The same for the lens target. */
  private lensEmpty = false;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    // Rendering to half float needs an extension WebGL 2 nearly always has; without it, 8 bits (clipped highlights in the blur only).
    const halfFloat = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
    if (!halfFloat) for (const each of [this.scene, this.quarter, this.eighth, this.sixteenth]) each.texture.type = UnsignedByteType;
    this.fullscreen.frustumCulled = false;
    const built = this.maskGeometry();
    this.instances = built.instances;
    this.maskMesh = new Mesh(built.geometry, this.maskMaterial);
    this.maskMesh.frustumCulled = false;
    this.maskScene.add(this.maskMesh);
    this.lensMesh = new Mesh(built.geometry, this.lensMaterial);
    this.lensMesh.frustumCulled = false;
    this.lensScene.add(this.lensMesh);
  }

  private fullscreenGeometry() {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    return geometry;
  }

  /** A unit quad instanced over the registry's buffer, rebuilt when the buffer grows. */
  private maskGeometry() {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    const instances = new InstancedInterleavedBuffer(this.buffer.data, FLOATS_PER_PANEL, 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute("aShape", new InterleavedBufferAttribute(instances, 4, 0));
    geometry.setAttribute("aQuad", new InterleavedBufferAttribute(instances, 4, 4));
    geometry.setAttribute("aRadius", new InterleavedBufferAttribute(instances, 1, 8));
    geometry.setAttribute("aLiquid", new InterleavedBufferAttribute(instances, 1, 9));
    geometry.setAttribute("aOpacity", new InterleavedBufferAttribute(instances, 1, 10));
    geometry.instanceCount = 0;
    return { geometry, instances };
  }

  private draw(material: ShaderMaterial, output: WebGLRenderTarget | null) {
    this.fullscreen.material = material;
    this.renderer.setRenderTarget(output);
    this.renderer.render(this.fullscreenScene, this.camera);
  }

  private blur(input: Texture, from: WebGLRenderTarget, output: WebGLRenderTarget, material: ShaderMaterial, spread: number) {
    material.uniforms.tInput.value = input;
    texel(material.uniforms.uOffset, from, spread);
    this.draw(material, output);
  }

  /**
   * Compiles every material in `scene` for the scene target, where every frame renders it (no tone
   * mapping, linear output: other programs than the screen's), without waiting on the driver where
   * `KHR_parallel_shader_compile` lets it. The synchronous part runs with the target bound.
   */
  compile(scene: Scene, camera: Camera): Promise<unknown> {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.scene);
    try {
      return renderer.compileAsync(scene, camera);
    } finally {
      renderer.setRenderTarget(previous);
    }
  }

  /** One frame: the scene to the screen, frosted under every panel. `size` is the canvas in CSS pixels. */
  render(scene: Scene, camera: Camera, size: { left: number; top: number; width: number; height: number }) {
    const renderer = this.renderer;
    const canvas = renderer.domElement;
    const width = canvas.width;
    const height = canvas.height;
    const space = this.space;
    space.left = size.left;
    space.top = size.top;
    space.width = size.width;
    space.height = size.height;
    space.bufferWidth = width;
    space.bufferHeight = height;
    const count = collectFrost(space, this.buffer);
    if (count !== this.reported) {
      this.reported = count;
      // For tests and measurement: how many panels the last frame frosted.
      canvas.dataset.frost = String(count);
    }

    resize(this.scene, width, height);
    resize(this.quarter, width / 4, height / 4);
    resize(this.eighth, width / 8, height / 8);
    resize(this.sixteenth, width / 16, height / 16);
    if (resize(this.mask, width / 2, height / 2)) this.maskEmpty = false;
    if (resize(this.lens, width / 2, height / 2)) this.lensEmpty = false;
    const dpr = width / Math.max(1, size.width);
    const spread = SPREAD * Math.max(0.5, width / Math.max(1, size.width) / REFERENCE_DPR);

    renderer.setRenderTarget(this.scene);
    renderer.render(scene, camera);

    if (count === 0) {
      // No panel: no blur; an empty mask makes the composite pass the scene through.
      if (!this.maskEmpty) {
        this.clear(this.mask);
        this.maskEmpty = true;
      }
      this.compose(spread, false, dpr, camera);
      return;
    }
    this.maskEmpty = false;

    this.downsample.uniforms.tInput.value = this.scene.texture;
    texel(this.downsample.uniforms.uTexel, this.scene);
    this.draw(this.downsample, this.quarter);
    this.blur(this.quarter.texture, this.quarter, this.eighth, this.kawaseDown, spread);
    this.blur(this.eighth.texture, this.eighth, this.sixteenth, this.kawaseDown, spread);
    this.blur(this.sixteenth.texture, this.sixteenth, this.eighth, this.kawaseUp, spread);

    if (this.instances.array !== this.buffer.data) {
      // The registry grew its buffer: a new GPU buffer to match.
      this.maskMesh.geometry.dispose();
      const built = this.maskGeometry();
      this.instances = built.instances;
      this.maskMesh.geometry = built.geometry;
      this.lensMesh.geometry = built.geometry;
    }
    this.instances.needsUpdate = true;
    this.maskMesh.geometry.instanceCount = count;
    (this.maskMaterial.uniforms.uResolution.value as Vector2).set(width, height);
    this.maskMaterial.uniforms.uTexelSize.value = width / this.mask.width;
    this.withClearColour(this.mask, () => {
      renderer.setRenderTarget(this.mask);
      renderer.render(this.maskScene, this.camera);
    });

    const liquid = this.buffer.liquid > 0;
    if (liquid) {
      this.lensEmpty = false;
      const lens = this.lensMaterial.uniforms;
      (lens.uResolution.value as Vector2).set(width, height);
      lens.uTexelSize.value = width / this.lens.width;
      lens.uBevel.value = BEVEL_PX * dpr;
      lens.uRange.value = lensRange(RIM_PX * dpr, width / this.lens.width);
      this.withClearColour(this.lens, () => {
        renderer.setRenderTarget(this.lens);
        renderer.render(this.lensScene, this.camera);
      });
    } else if (!this.lensEmpty) {
      this.clear(this.lens);
      this.lensEmpty = true;
    }
    this.compose(spread, liquid, dpr, camera);
  }

  /**
   * Runs `draw` with the clear colour set to `target`'s empty value, then puts the renderer's back:
   * black for the mask; for the lens, a 0.5-centred zero direction, no lens, and a distance far
   * outside (A = 1, which also keeps three's premultiplication from zeroing the direction).
   */
  private withClearColour(output: WebGLRenderTarget, draw: () => void) {
    const renderer = this.renderer;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    if (output === this.lens) renderer.setClearColor(LENS_EMPTY, LENS_EMPTY_ALPHA);
    else renderer.setClearColor(BLACK, 0);
    draw();
    renderer.setClearColor(this.clearColor, clearAlpha);
  }

  private clear(output: WebGLRenderTarget) {
    this.withClearColour(output, () => {
      this.renderer.setRenderTarget(output);
      this.renderer.clear(true, false, false);
    });
  }

  /**
   * The scene and its blurred copy to the screen, mixed by the mask; with `liquid`, the lens and the
   * rim highlight too, lit from `glassLight` turned into a direction on screen by `camera`.
   */
  private compose(spread: number, liquid: boolean, dpr: number, camera: Camera) {
    const uniforms = this.composite.uniforms;
    uniforms.tScene.value = this.scene.texture;
    uniforms.tBlur.value = this.eighth.texture;
    uniforms.tMask.value = this.mask.texture;
    uniforms.tLens.value = this.lens.texture;
    texel(uniforms.uOffset, this.eighth, spread);
    uniforms.uLens.value = liquid ? 1 : 0;
    if (liquid) {
      const width = this.scene.width;
      const height = this.scene.height;
      (uniforms.uShift.value as Vector2).set((LENS_SHIFT_PX * dpr) / width, (LENS_SHIFT_PX * dpr) / height);
      (uniforms.uFringe.value as Vector2).set((FRINGE_PX * dpr) / width, (FRINGE_PX * dpr) / height);
      uniforms.uRange.value = this.lensMaterial.uniforms.uRange.value;
      uniforms.uRim.value = RIM_PX * dpr;
      // The light's room-space direction in the camera's view space: X right, Y up, as the canvas's pixels are here.
      const sun = this.sun.set(glassLight.x, glassLight.y, glassLight.z).transformDirection(camera.matrixWorldInverse);
      const length = Math.hypot(sun.x, sun.y);
      // Straight along the view axis it lights no edge in particular: the top, faded.
      const facing = Math.min(1, length * 4);
      (uniforms.uSun.value as Vector2).set(length > 1e-4 ? sun.x / length : 0, length > 1e-4 ? sun.y / length : 1);
      (uniforms.uHighlight.value as Color).copy(glassLight.moon ? MOON_WHITE : SUN_WHITE).multiplyScalar(HIGHLIGHT * glassLight.strength * facing);
    }
    this.draw(this.composite, null);
  }

  dispose() {
    for (const each of [this.scene, this.quarter, this.eighth, this.sixteenth, this.mask, this.lens]) each.dispose();
    for (const each of [this.downsample, this.kawaseDown, this.kawaseUp, this.composite, this.maskMaterial, this.lensMaterial]) each.dispose();
    this.fullscreen.geometry.dispose();
    this.maskMesh.geometry.dispose();
  }
}

/** One pipeline per renderer, made for whichever comes first: the compile before the first frame, or the first frame. */
const pipelines = new WeakMap<WebGLRenderer, FrostPipeline>();

function pipelineFor(renderer: WebGLRenderer): FrostPipeline {
  let pipeline = pipelines.get(renderer);
  if (!pipeline) {
    pipeline = new FrostPipeline(renderer);
    pipelines.set(renderer, pipeline);
  }
  return pipeline;
}

/**
 * Compiles the room's shaders before its first frame, for the frost pass's scene target that every
 * frame renders into (docs/PALACE.md, Less waiting): resolves when the programs are ready, polled
 * without blocking where the browser compiles in parallel. What mounts later compiles on first use.
 */
export function compileRoom(renderer: WebGLRenderer, scene: Scene, camera: Camera): Promise<unknown> {
  return pipelineFor(renderer).compile(scene, camera);
}

/**
 * Takes over the canvas's rendering (a positive `useFrame` priority stops R3F's own render) and
 * draws each frame through the frost pipeline. Mount it once inside the room's `Canvas`.
 */
export default function FrostPass() {
  const gl = useThree((state) => state.gl);
  useEffect(
    () => () => {
      pipelines.get(gl)?.dispose();
      pipelines.delete(gl);
      resetFrost();
    },
    [gl],
  );
  useFrame((state) => {
    // Made on demand rather than in an effect, so not even the first frame renders another way.
    pipelineFor(state.gl).render(state.scene, state.camera, state.size);
  }, 1);
  return null;
}
