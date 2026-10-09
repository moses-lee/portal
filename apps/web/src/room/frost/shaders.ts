/**
 * The frost's shaders (docs/PALACE.md, Web → Frost), GLSL in three's `ShaderMaterial` dialect
 * (`texture2D` and `gl_FragColor` are mapped to GLSL 3 by three on WebGL 2).
 *
 * - `fullscreen`: one oversized triangle in clip space, shared by every pass but the mask.
 * - `downsample`: the sharp scene to a quarter of its size, four bilinear taps that average each
 *   4 × 4 block exactly (no skipped texels, so no shimmer as the camera drifts).
 * - `kawaseDown` / `kawaseUp`: the dual-Kawase filter (Bjørge, SIGGRAPH 2015); halving and doubling
 *   the size with five and eight taps.
 * - `mask`: rounded rectangles as a signed distance field, one instanced quad per frosted panel,
 *   into a half-resolution R8 target, combined with MAX blending.
 * - `composite`: the last Kawase upsample folded in, tone mapping and the output transfer applied
 *   to the sharp scene and the blurred copy, the copy saturated like CSS `saturate()`, and the two
 *   mixed by the mask.
 */

export const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const downsampleFragment = /* glsl */ `
uniform sampler2D tInput;
/** One texel of the input. */
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(tInput, vUv + uTexel * vec2(-1.0, -1.0));
  sum += texture2D(tInput, vUv + uTexel * vec2(1.0, -1.0));
  sum += texture2D(tInput, vUv + uTexel * vec2(-1.0, 1.0));
  sum += texture2D(tInput, vUv + uTexel * vec2(1.0, 1.0));
  gl_FragColor = sum * 0.25;
}
`;

export const kawaseDownFragment = /* glsl */ `
uniform sampler2D tInput;
/** One texel of the input, times the spread. */
uniform vec2 uOffset;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(tInput, vUv) * 4.0;
  sum += texture2D(tInput, vUv - uOffset);
  sum += texture2D(tInput, vUv + uOffset);
  sum += texture2D(tInput, vUv + vec2(uOffset.x, -uOffset.y));
  sum += texture2D(tInput, vUv - vec2(uOffset.x, -uOffset.y));
  gl_FragColor = sum * 0.125;
}
`;

/** The upsample taps, shared by the upsample pass and the composite. */
const kawaseUpFunction = /* glsl */ `
vec4 kawaseUp(sampler2D source, vec2 uv, vec2 offset) {
  vec4 sum = texture2D(source, uv + vec2(-offset.x * 2.0, 0.0));
  sum += texture2D(source, uv + vec2(-offset.x, offset.y)) * 2.0;
  sum += texture2D(source, uv + vec2(0.0, offset.y * 2.0));
  sum += texture2D(source, uv + vec2(offset.x, offset.y)) * 2.0;
  sum += texture2D(source, uv + vec2(offset.x * 2.0, 0.0));
  sum += texture2D(source, uv + vec2(offset.x, -offset.y)) * 2.0;
  sum += texture2D(source, uv + vec2(0.0, -offset.y * 2.0));
  sum += texture2D(source, uv + vec2(-offset.x, -offset.y)) * 2.0;
  return sum / 12.0;
}
`;

export const kawaseUpFragment = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uOffset;
varying vec2 vUv;
${kawaseUpFunction}
void main() {
  gl_FragColor = kawaseUp(tInput, vUv, uOffset);
}
`;

export const maskVertex = /* glsl */ `
/** The panel's centre and half size, canvas pixels from the bottom left. */
attribute vec4 aShape;
/** The quad to cover: the panel plus a pixel of margin, cut to its clipping ancestors. x0, y0, x1, y1. */
attribute vec4 aQuad;
attribute float aRadius;
/** The canvas's drawing buffer, pixels. */
uniform vec2 uResolution;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
void main() {
  vPixel = mix(aQuad.xy, aQuad.zw, position.xy);
  vShape = aShape;
  vRadius = aRadius;
  gl_Position = vec4(vPixel / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const maskFragment = /* glsl */ `
/** Canvas pixels per mask texel: the edge is antialiased over one texel. */
uniform float uTexelSize;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
void main() {
  vec2 q = abs(vPixel - vShape.xy) - vShape.zw + vRadius;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vRadius;
  float coverage = clamp(0.5 - distance / uTexelSize, 0.0, 1.0);
  gl_FragColor = vec4(coverage, 0.0, 0.0, 1.0);
}
`;

export const compositeFragment = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBlur;
uniform sampler2D tMask;
uniform vec2 uOffset;
uniform float uSaturation;
varying vec2 vUv;
${kawaseUpFunction}
vec3 display(vec3 linear) {
#ifdef TONE_MAPPING
  linear = toneMapping(linear);
#endif
  return linearToOutputTexel(vec4(linear, 1.0)).rgb;
}
void main() {
  vec3 sharp = display(texture2D(tScene, vUv).rgb);
  float mask = texture2D(tMask, vUv).r;
  if (mask <= 0.0) {
    gl_FragColor = vec4(sharp, 1.0);
    return;
  }
  vec3 blurred = display(kawaseUp(tBlur, vUv, uOffset).rgb);
  // CSS saturate(): a lerp away from Rec. 709 luma, applied to display values as the browser does.
  float luma = dot(blurred, vec3(0.2126, 0.7152, 0.0722));
  blurred = clamp(mix(vec3(luma), blurred, uSaturation), 0.0, 1.0);
  gl_FragColor = vec4(mix(sharp, blurred, mask), 1.0);
}
`;
