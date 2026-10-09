"use client";

import { useEffect, useRef } from "react";
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
  OrthographicCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type IUniform,
  type Texture,
  type WebGLRenderer,
} from "three";
import { collectFrost, FLOATS_PER_PANEL, resetFrost, type FrostBuffer } from "./registry";
import {
  compositeFragment,
  downsampleFragment,
  fullscreenVertex,
  kawaseDownFragment,
  kawaseUpFragment,
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

const resize = (renderTarget: WebGLRenderTarget, width: number, height: number) => {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  // setSize reallocates on the GPU; only when the size really changed.
  if (renderTarget.width !== w || renderTarget.height !== h) renderTarget.setSize(w, h);
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
 * 5. a composite to the screen: the last Kawase upsample, tone mapping, saturation for the blurred
 *    copy, and the sharp scene and the copy mixed by the mask.
 *
 * Frames with no frosted panel on the page skip all of it and render the scene straight to the
 * screen. Targets are created once and resized only when the canvas's size changes.
 */
class FrostPipeline {
  private readonly renderer: WebGLRenderer;
  private readonly scene = target(HalfFloatType, { depth: true });
  private readonly quarter = target(HalfFloatType);
  private readonly eighth = target(HalfFloatType);
  private readonly sixteenth = target(HalfFloatType);
  private readonly mask = target(UnsignedByteType, { red: true });

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
    uOffset: { value: new Vector2() },
    uSaturation: { value: SATURATION },
  });

  private readonly buffer: FrostBuffer = { data: new Float32Array(32 * FLOATS_PER_PANEL) };
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
  private instances: InstancedInterleavedBuffer;

  private readonly clearColor = new Color();
  private reported = -1;

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

  /** One frame: the scene to the screen, frosted under every panel. `size` is the canvas in CSS pixels. */
  render(scene: Scene, camera: Camera, size: { left: number; top: number; width: number; height: number }) {
    const renderer = this.renderer;
    const canvas = renderer.domElement;
    const width = canvas.width;
    const height = canvas.height;
    const count = collectFrost({ ...size, bufferWidth: width, bufferHeight: height }, this.buffer);
    if (count !== this.reported) {
      this.reported = count;
      // For tests and measurement: how many panels the last frame frosted.
      canvas.dataset.frost = String(count);
    }
    if (count === 0) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    resize(this.scene, width, height);
    resize(this.quarter, width / 4, height / 4);
    resize(this.eighth, width / 8, height / 8);
    resize(this.sixteenth, width / 16, height / 16);
    resize(this.mask, width / 2, height / 2);
    const spread = SPREAD * Math.max(0.5, width / Math.max(1, size.width) / REFERENCE_DPR);

    renderer.setRenderTarget(this.scene);
    renderer.render(scene, camera);

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
    }
    this.instances.needsUpdate = true;
    this.maskMesh.geometry.instanceCount = count;
    (this.maskMaterial.uniforms.uResolution.value as Vector2).set(width, height);
    this.maskMaterial.uniforms.uTexelSize.value = width / this.mask.width;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.mask);
    renderer.render(this.maskScene, this.camera);
    renderer.setClearColor(this.clearColor, clearAlpha);

    this.composite.uniforms.tScene.value = this.scene.texture;
    this.composite.uniforms.tBlur.value = this.eighth.texture;
    this.composite.uniforms.tMask.value = this.mask.texture;
    texel(this.composite.uniforms.uOffset, this.eighth, spread);
    this.draw(this.composite, null);
  }

  dispose() {
    for (const each of [this.scene, this.quarter, this.eighth, this.sixteenth, this.mask]) each.dispose();
    for (const each of [this.downsample, this.kawaseDown, this.kawaseUp, this.composite, this.maskMaterial]) each.dispose();
    this.fullscreen.geometry.dispose();
    this.maskMesh.geometry.dispose();
  }
}

/**
 * Takes over the canvas's rendering (a positive `useFrame` priority stops R3F's own render) and
 * draws each frame through the frost pipeline. Mount it once inside the room's `Canvas`.
 */
export default function FrostPass() {
  const gl = useThree((state) => state.gl);
  const pipeline = useRef<FrostPipeline | null>(null);
  useEffect(() => {
    const created = new FrostPipeline(gl);
    pipeline.current = created;
    return () => {
      pipeline.current = null;
      created.dispose();
      resetFrost();
    };
  }, [gl]);
  useFrame((state) => {
    if (pipeline.current) pipeline.current.render(state.scene, state.camera, state.size);
    else state.gl.render(state.scene, state.camera);
  }, 1);
  return null;
}
