// Colours for the Discovery map, held in one place the way lib/chartTheme.ts
// holds CHART_COLORS. These are deliberately NOT the app's theme tokens: the
// map is a picture with its own light, not a chrome surface, so tying it to
// --surface / --accent would flatten it.

export const LAND = {
  /** Open water, dark centre → lighter shelf near the shore. */
  waterDeep: '#0a2036',
  waterMid: '#123a5c',
  waterShallow: '#1d5c86',
  foam: '#8fd0e8',

  /** Grass biome, lit from the top-left. */
  grassLight: '#a8c94f',
  grassMid: '#7aa838',
  grassDark: '#4e7a2c',

  /**
   * Highland stone: sunlit facet, away-facing facet, silhouette.
   *
   * The spread between `rockLight` and `rockMid` is what gives a ridge volume —
   * the original palette put them a few percent apart and every summit read as a
   * flat paper cone. `rockLight` deliberately stops well short of white, or the
   * snow cap disappears into the rock it is sitting on.
   */
  rockLight: '#b9bec4',
  rockMid: '#7c848c',
  rockDark: '#5d646c',
  rockShade: '#464d55',
  snow: '#f2f6f8',
  /** Snow on the shaded side — cool, not grey, or the cap looks dirty. */
  snowShade: '#c3d3e0',
  scree: '#6e767e',

  /** Red-rock canyon region on the map's edge. */
  redLight: '#d98552',
  redMid: '#ad5730',
  redDark: '#7d3a21',
  redShade: '#68301c',

  /** Conifers. */
  treeLight: '#3f8f4a',
  treeMid: '#2b6b38',
  treeDark: '#1c4726',
  trunk: '#4a3524',

  /** Trails, huts, ruins. */
  trail: '#d8c99a',
  hutRoof: '#c0503a',
  hutWall: '#e2d3b4',
  ruin: '#9aa0a6',

  /**
   * The survey drone. Deliberately a cool grey against the warm land, so a small
   * machine reads as machinery rather than as another animal.
   *
   * The two light colours are the whole status display: amber while the network
   * is still being searched, green once devices have been found.
   */
  droneShell: '#cfd8e0',
  droneShellDark: '#78838f',
  droneBlade: '#e8eef4',
  droneLightIdle: '#f5a524',
  droneLightLocked: '#3fd97f',

  /** Shared shading. */
  shadow: '#04121e',
  fog: '#dce8f2',
} as const;

export type LandColorKey = keyof typeof LAND;

/** Every biome's three-stop ramp, so Terrain can render terraces generically. */
export const BIOME_RAMPS = {
  grass: [LAND.grassDark, LAND.grassMid, LAND.grassLight],
  highland: [LAND.rockDark, LAND.rockMid, LAND.rockLight],
  redrock: [LAND.redDark, LAND.redMid, LAND.redLight],
  snowfield: [LAND.rockMid, LAND.rockLight, LAND.snow],
} as const;

export type BiomeKind = keyof typeof BIOME_RAMPS;

export const BIOME_KINDS = Object.keys(BIOME_RAMPS) as BiomeKind[];

/** Ramp stop for terrace level `i`, clamped rather than wrapped. */
export function biomeColor(kind: BiomeKind, level: number): string {
  const ramp = BIOME_RAMPS[kind];
  return ramp[Math.min(ramp.length - 1, Math.max(0, level))];
}

/**
 * The three facet tones of one rock type, brightest first: the sunlit face, the
 * away-facing face, and the silhouette showing as an edge behind both.
 */
export interface RockRamp {
  light: string;
  mid: string;
  shade: string;
}

export const GREY_ROCK: RockRamp = {
  light: LAND.rockLight,
  mid: LAND.rockMid,
  shade: LAND.rockShade,
};

export const RED_ROCK: RockRamp = {
  light: LAND.redLight,
  mid: LAND.redMid,
  shade: LAND.redShade,
};

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;

function clamp255(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)));
}

/**
 * Lightens (amount > 0) or darkens (amount < 0) a hex colour by mixing toward
 * white or black. Used to give each peak a small seeded tone offset, so a
 * mountain range has internal variation instead of every summit sharing one grey.
 *
 * Returns the input unchanged if it isn't a hex colour — these values end up in
 * `fill` attributes, so silently passing through beats emitting `#NaNNaNNaN`.
 */
export function shade(hex: string, amount: number): string {
  const m = HEX6.exec(hex) ?? HEX3.exec(hex);
  if (!m) return hex;
  const digits = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const target = amount >= 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const channel = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    out.push(clamp255(channel + (target - channel) * t).toString(16).padStart(2, '0'));
  }
  return `#${out.join('')}`;
}

/** A peak's own ramp: the shared rock tones nudged by its seeded `tone`. */
export function rockRamp(base: RockRamp, tone: number): RockRamp {
  // ±8% is enough to read as variation without any summit looking mis-coloured.
  const amount = tone * 0.08;
  return {
    light: shade(base.light, amount),
    mid: shade(base.mid, amount),
    shade: shade(base.shade, amount),
  };
}
