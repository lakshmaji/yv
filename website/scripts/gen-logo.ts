// Renders the app's own boar mark to a static SVG for the docs navbar.
//
//   bun run scripts/gen-logo.ts
//
// The mark lives in the Wails frontend as pure geometry (`frontend/src/lib/boar.ts`),
// which is a different workspace with a different framework — so rather than
// wiring a cross-package import into the Docusaurus build, this renders it once
// to a file. Re-run it if the boar changes.
//
// The alternative was scaling build/appicon.png down, but that icon is a
// wireframe over a nebula: at 32px it resolves to mud.

import {BOAR_VIEWBOX, boarFacets, boarStrokes} from '../../frontend/src/lib/boar';

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const facet = (f: {d: string; color: string; opacity: number}) =>
  `<path d="${attr(f.d)}" fill="${f.color}" opacity="${f.opacity}"/>`;

const stroke = (s: {d: string; color: string; width: number; fill?: string}) =>
  `<path d="${attr(s.d)}" fill="${s.fill ?? 'none'}" stroke="${s.color}" ` +
  `stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`;

const strokes = boarStrokes();

// Legs are marked `behind`: the body fills have to be what hides where they
// join, or they read as boxes hung off the belly.
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOAR_VIEWBOX.w} ${BOAR_VIEWBOX.h}" role="img" aria-label="yv">`,
  ...strokes.filter((s) => s.behind).map(stroke),
  ...boarFacets().map(facet),
  ...strokes.filter((s) => !s.behind).map(stroke),
  '</svg>',
].join('\n');

await Bun.write('static/img/logo.svg', `${svg}\n`);
console.log(`wrote static/img/logo.svg (${strokes.length} strokes)`);
