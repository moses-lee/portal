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
 *   into a half-resolution R8 target, combined with MAX blending; each scaled by its panel's
 *   opacity (a panel fading out takes its frost with it).
 * - `lens`: the liquid panels only (docs/GLASS.md, Liquid glass), the same instanced quads into a
 *   half-resolution RGBA8 target: the outward direction (the SDF's gradient, 0.5-centred, its length
 *   the panel's opacity) in R/G, the bevel's lens amount in B and the signed distance to the edge
 *   in A (0.5 at the edge, rising outwards, `uRange` canvas pixels from 0 to 1). The target is
 *   cleared to (0.5, 0.5, 0, 1): no direction, no lens, far outside.
 * - `composite`: the last Kawase upsample folded in, tone mapping and the output transfer applied
 *   to the sharp scene and the blurred copy, the copy saturated like CSS `saturate()`, and the two
 *   mixed by the mask. In a liquid panel's bevel the blurred copy is also read displaced outwards,
 *   red and blue a little further and nearer (the fringe), and the rim, worked out at full
 *   resolution from the interpolated distance, is lit from the sun.
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
/** The panel's effective opacity, 0..1. */
attribute float aOpacity;
/** The canvas's drawing buffer, pixels. */
uniform vec2 uResolution;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
varying float vOpacity;
void main() {
  vPixel = mix(aQuad.xy, aQuad.zw, position.xy);
  vShape = aShape;
  vRadius = aRadius;
  vOpacity = aOpacity;
  gl_Position = vec4(vPixel / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const maskFragment = /* glsl */ `
/** Canvas pixels per mask texel: the edge is antialiased over one texel. */
uniform float uTexelSize;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
varying float vOpacity;
void main() {
  vec2 q = abs(vPixel - vShape.xy) - vShape.zw + vRadius;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vRadius;
  float coverage = clamp(0.5 - distance / uTexelSize, 0.0, 1.0);
  gl_FragColor = vec4(coverage * vOpacity, 0.0, 0.0, 1.0);
}
`;

export const lensVertex = /* glsl */ `
attribute vec4 aShape;
attribute vec4 aQuad;
attribute float aRadius;
/** 1 for a liquid panel; anything else is collapsed to nothing. */
attribute float aLiquid;
attribute float aOpacity;
uniform vec2 uResolution;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
varying float vOpacity;
void main() {
  vPixel = mix(aQuad.xy, aQuad.zw, position.xy);
  vShape = aShape;
  vRadius = aRadius;
  vOpacity = aOpacity;
  // Not liquid: all four corners on one point outside clip space, so the quad covers no pixel.
  gl_Position = aLiquid > 0.5 ? vec4(vPixel / uResolution * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const lensFragment = /* glsl */ `
/** Canvas pixels per lens texel. */
uniform float uTexelSize;
/** The bevel's width, canvas pixels. */
uniform float uBevel;
/** The distance A encodes from 0 to 1, canvas pixels (centred on the edge). */
uniform float uRange;
varying vec2 vPixel;
varying vec4 vShape;
varying float vRadius;
varying float vOpacity;
void main() {
  vec2 offset = vPixel - vShape.xy;
  vec2 q = abs(offset) - vShape.zw + vRadius;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vRadius;
  // More than a texel outside: left as cleared. The texel just outside is written, so the bilinear
  // taps at the rim read the panel's direction and distance rather than a blend with nothing.
  if (distance > uTexelSize) discard;
  // The rounded rectangle's gradient: radial in the corners, straight out along the nearer side elsewhere.
  vec2 side = vec2(offset.x < 0.0 ? -1.0 : 1.0, offset.y < 0.0 ? -1.0 : 1.0);
  vec2 corner = max(q, 0.0);
  vec2 normal = dot(corner, corner) > 0.0 ? normalize(corner) * side : (q.x > q.y ? vec2(side.x, 0.0) : vec2(0.0, side.y));
  // Depth into the bevel, 0 at the rim to 1 at its inner edge; a small panel is all bevel.
  float bevel = min(uBevel, min(vShape.z, vShape.w));
  float x = clamp(-distance / max(bevel, 1.0), 0.0, 1.0);
  // A convex squircle, height (1 - (1 - x)^4)^(1/4), as tall as the bevel is wide. The room is bent by
  // the surface's tilt, sin(atan(slope)): 1 at the rim, about 0.4 a third of the way in, 0.13
  // halfway, and 0 at the inner edge with a flat tangent there, so the bend fades in without a seam.
  float inner = 1.0 - x;
  float inner3 = inner * inner * inner;
  float slope = inner3 * pow(max(1.0 - inner3 * inner, 1e-6), -0.75);
  float amount = slope * inversesqrt(1.0 + slope * slope);
  gl_FragColor = vec4(normal * (0.5 * vOpacity) + 0.5, amount, clamp(0.5 + distance / uRange, 0.0, 1.0));
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
/** The lens target's distance range (see \`lens\`) and the rim highlight's width, canvas pixels. */
uniform float uRange;
uniform float uRim;
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
    // The panel's opacity is the direction's length; the cleared target's is about 0.
    float fade = length(direction);
    if (fade > 0.01) {
      if (lens.b > 0.0) {
        // The bevel: the blurred room read further out, red and blue either side of green (taps of the
        // eighth-size copy), added as a difference from the same copy here to the upsampled interior:
        // no shift, no change, so the bevel has no seam at its inner edge.
        vec2 shift = direction * lens.b;
        vec2 uv = vUv + shift * uShift;
        vec2 fringe = shift * uFringe;
        vec3 here = texture2D(tBlur, vUv).rgb;
        vec3 bent = vec3(texture2D(tBlur, uv + fringe).r, texture2D(tBlur, uv).g, texture2D(tBlur, uv - fringe).b);
        linear = max(linear + bent - here, 0.0);
      }
      // The rim at full resolution: the distance to the edge, interpolated, antialiased over a pixel either side.
      float edge = (lens.a - 0.5) * uRange;
      float rim = clamp(0.5 - edge, 0.0, 1.0) * clamp(0.5 + edge + uRim, 0.0, 1.0);
      float facing = max(0.0, dot(direction / fade, uSun));
      highlight = uHighlight * rim * fade * facing * facing;
    }
  }
  vec3 blurred = display(linear);
  // CSS saturate(): a lerp away from Rec. 709 luma, applied to display values as the browser does.
  float luma = dot(blurred, vec3(0.2126, 0.7152, 0.0722));
  blurred = clamp(mix(vec3(luma), blurred, uSaturation), 0.0, 1.0);
  gl_FragColor = vec4(min(mix(sharp, blurred, mask) + highlight, 1.0), 1.0);
}
`;
