/**
 * The frost's shaders (docs/PALACE.md, Web → Frost), GLSL in three's `ShaderMaterial` dialect
 * (`texture2D` and `gl_FragColor` are mapped to GLSL 3 by three on WebGL 2).
 *
 * - `fullscreen`: one oversized triangle in clip space, shared by every pass but the mask.
 * - `downsample`: the sharp scene to a quarter of its size, four bilinear taps that average each
 *   4 × 4 block exactly (no skipped texels, so no shimmer as things move).
 * - `kawaseDown` / `kawaseUp`: the dual-Kawase filter (Bjørge, SIGGRAPH 2015); halving and doubling
 *   the size with five and eight taps.
 * - `mask`: rounded rectangles as a signed distance field, one instanced quad per frosted panel,
 *   into a half-resolution R8 target, combined with MAX blending.
 * - `lens`: the liquid panels only (docs/GLASS.md, Liquid glass), the same instanced quads into a
 *   half-resolution RGBA8 target: the outward direction (the SDF's gradient, 0.5-centred) in R/G,
 *   the bevel's lens amount in B and the rim highlight's coverage in A.
 * - `composite`: the last Kawase upsample folded in, tone mapping and the output transfer applied
 *   to the sharp scene and the blurred copy, the copy saturated like CSS `saturate()`, and the two
 *   mixed by the mask. In a liquid panel's bevel the blurred copy is also read displaced outwards,
 *   red and blue a little further and nearer (the fringe), and the rim lit from the sun.
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

export const lensVertex = /* glsl */ `
attribute vec4 aShape;
attribute vec4 aQuad;
attribute float aRadius;
/** 1 for a liquid panel; anything else is collapsed to nothing. */
attribute float aLiquid;
uniform vec2 uResolution;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
void main() {
  vPixel = mix(aQuad.xy, aQuad.zw, position.xy);
  vShape = aShape;
  vRadius = aRadius;
  // Not liquid: all four corners on one point outside clip space, so the quad covers no pixel.
  gl_Position = aLiquid > 0.5 ? vec4(vPixel / uResolution * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const lensFragment = /* glsl */ `
/** Canvas pixels per lens texel. */
uniform float uTexelSize;
/** The bevel's width and the rim highlight's, canvas pixels. */
uniform float uBevel;
uniform float uRim;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
void main() {
  vec2 offset = vPixel - vShape.xy;
  vec2 q = abs(offset) - vShape.zw + vRadius;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vRadius;
  float coverage = clamp(0.5 - distance / uTexelSize, 0.0, 1.0);
  // Outside the panel: left as cleared (no direction, no lens, no rim), which the quad's margin needs.
  if (coverage <= 0.0) discard;
  // The rounded rectangle's gradient: radial in the corners, straight out along the nearer side elsewhere.
  vec2 side = vec2(offset.x < 0.0 ? -1.0 : 1.0, offset.y < 0.0 ? -1.0 : 1.0);
  vec2 corner = max(q, 0.0);
  vec2 normal = dot(corner, corner) > 0.0 ? normalize(corner) * side : (q.x > q.y ? vec2(side.x, 0.0) : vec2(0.0, side.y));
  // Depth into the bevel, 0 at the rim to 1 at its inner edge; a small panel is all bevel.
  float bevel = min(uBevel, min(vShape.z, vShape.w));
  float x = clamp(-distance / max(bevel, 1.0), 0.0, 1.0);
  // A convex squircle's height, (1 - (1 - x)^4)^(1/4): steep at the rim, flat inside. The lens pulls hardest where it is steep.
  float inner = 1.0 - x;
  float height = pow(max(0.0, 1.0 - inner * inner * inner * inner), 0.25);
  float amount = 1.0 - height;
  float rim = coverage * clamp(1.0 + distance / max(uRim, 0.5), 0.0, 1.0);
  gl_FragColor = vec4(normal * 0.5 + 0.5, amount, rim);
}
`;

export const compositeFragment = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBlur;
uniform sampler2D tMask;
uniform sampler2D tLens;
uniform vec2 uOffset;
uniform float uSaturation;
/** 1 when a liquid panel is on screen (the lens target holds something), 0 to skip its taps. */
uniform float uLens;
/** The lens's largest shift and the fringe's, in UV units per unit of direction. */
uniform vec2 uShift;
uniform vec2 uFringe;
/** The light's direction on screen (unit, Y up) and the highlight's colour times its strength, display values. */
uniform vec2 uSun;
uniform vec3 uHighlight;
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
  vec3 linear = kawaseUp(tBlur, vUv, uOffset).rgb;
  vec3 highlight = vec3(0.0);
  if (uLens > 0.0) {
    vec4 lens = texture2D(tLens, vUv);
    vec2 direction = lens.rg * 2.0 - 1.0;
    if (lens.b > 0.0) {
      // The bevel: the blurred room read further out, red and blue either side of green (three taps of the eighth-size copy).
      vec2 uv = vUv + direction * lens.b * uShift;
      vec2 fringe = direction * lens.b * uFringe;
      vec3 bent = vec3(texture2D(tBlur, uv + fringe).r, texture2D(tBlur, uv).g, texture2D(tBlur, uv - fringe).b);
      // Eased in from the band's inner edge, so the bevel has no seam against the upsampled interior.
      linear = mix(linear, bent, smoothstep(0.0, 0.25, lens.b));
    }
    float facing = max(0.0, dot(direction, uSun));
    highlight = uHighlight * lens.a * facing * facing;
  }
  vec3 blurred = display(linear);
  // CSS saturate(): a lerp away from Rec. 709 luma, applied to display values as the browser does.
  float luma = dot(blurred, vec3(0.2126, 0.7152, 0.0722));
  blurred = clamp(mix(vec3(luma), blurred, uSaturation), 0.0, 1.0);
  gl_FragColor = vec4(min(mix(sharp, blurred, mask) + highlight, 1.0), 1.0);
}
`;
