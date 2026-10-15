/**
 * The light the liquid glass's rim highlight is lit by (docs/GLASS.md, Sun direction on screen):
 * `Sun` writes it whenever its light moves (about once a minute) and the frost pass reads it every
 * frame, so neither renders more often for the other. No React, no three.
 */
export type GlassLight = {
  /** Unit vector from the room towards the sun, or the moon at night, in room space (`directionFrom`). */
  x: number;
  y: number;
  z: number;
  /** The key light's intensity normalised to full day (0..1), weather included. */
  strength: number;
  /** The moon (or the night's stand-in) rather than the sun: a dim cool white instead of a warm one. */
  moon: boolean;
};

export const glassLight: GlassLight = { x: 0, y: 1, z: 0, strength: 0, moon: false };

export function setGlassLight(direction: readonly [number, number, number], strength: number, moon: boolean) {
  glassLight.x = direction[0];
  glassLight.y = direction[1];
  glassLight.z = direction[2];
  glassLight.strength = Math.min(1, Math.max(0, strength));
  glassLight.moon = moon;
}
