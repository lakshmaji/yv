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

  /** Highland: grey stone with snow above the treeline. */
  rockLight: '#b9bec4',
  rockMid: '#8b9299',
  rockDark: '#5d646c',
  snow: '#f2f6f8',

  /** Red-rock canyon region on the map's edge. */
  redLight: '#d98552',
  redMid: '#b45c33',
  redDark: '#7d3a21',

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
