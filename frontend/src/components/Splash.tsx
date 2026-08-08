import { For, onCleanup, onMount } from 'solid-js';
import { animate, createTimeline, stagger, svg, type Target } from 'animejs';
import {
  BOAR_VIEWBOX, CHROMA_OFFSET, EYE_IDS, SPLASH,
  boarFacets, boarStrokes, glitchBands, sparks, type BoarStroke,
} from '../lib/boar';
import { hashText } from '../lib/landscape/rng';
import { setSplashDone } from '../store';
import { runtime } from '../wails';

/** Where the "about" line goes. */
const ABOUT_URL = 'https://github.com/lakshmaji/yv';

/**
 * The launch splash: a neon boar drawn on over a CRT field, then glitched, then
 * gone — 2.5s, fixed, whether boot took 40ms or two seconds.
 *
 * Fixed rather than gated on boot, on purpose. Waiting for `LoadProjects` would
 * make the app's first impression a different length every launch, and on a warm
 * start it would be a flash rather than anything anyone could look at. Boot runs
 * underneath the whole time, so the splash costs nothing but its own duration.
 *
 * Layering, one animated concern per element as in Dinosaur.tsx / Drone.tsx:
 *
 *   .splash              exit fade + scale        (anime.js)
 *   .splash-grid         CRT field and sweep      (CSS)
 *   #boar-art            the strokes drawing on   (anime.js, svg.createDrawable)
 *   use.splash-chroma    channel ghosts           (anime.js, mirrors #boar-art)
 *   use.splash-band      glitch slices            (anime.js, mirrors #boar-art)
 *
 * The ghosts and the glitch slices are `<use>` of the same `#boar-art` group,
 * not further copies of the geometry. That is what keeps them exactly in step
 * with the draw-on — a real copy would need its own animation and would drift by
 * however much the two disagreed. Their colour comes from an feColorMatrix that
 * keeps two channels and drops the third, which is what chromatic aberration
 * physically is, rather than from a second palette to maintain.
 *
 * The offsets live in SVG `x` attributes rather than in a `transform`, because
 * anime.js animates transforms through the CSS property — which overrides the
 * attribute entirely, and would snap both ghosts back onto the original the
 * moment the glitch beat started.
 *
 * anime.js is script-driven, so — exactly as Drone.tsx notes — neither the
 * reduced-motion media query nor a `.no-motion` class can cancel it. It is
 * honoured here by hand: with the preference set there is no timeline at all,
 * just the finished drawing, a short hold and a plain fade.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const STROKES = boarStrokes();
/** Split once, at module load: the far side is drawn under the body fills. */
const BEHIND = STROKES.filter(s => s.behind);
const FRONT = STROKES.filter(s => !s.behind);
const FACETS = boarFacets();
const BANDS = glitchBands(hashText('yv-boar-glitch'), 5);
const SPARKS = sparks(hashText('yv-boar-sparks'), 18);

/**
 * Reads a per-element number back out of the markup, for anime.js.
 *
 * The geometry writes it into a data attribute and the timeline reads it here,
 * rather than the timeline closing over the arrays: anime hands the callback the
 * element, and matching an index back to the right entry of a separate array is
 * a correspondence nothing enforces.
 */
/** Where each stroke sits in the reveal, so its fill can follow its own outline. */
const REVEAL_INDEX = new Map(STROKES.map((s, i) => [s.id, i]));

function path(stroke: BoarStroke, reduced: boolean) {
  return (
    <path
      id={`stroke-${stroke.id}`}
      class="splash-stroke"
      d={stroke.d}
      fill={stroke.fill ?? 'none'}
      /*
       * Filled shapes start with NO fill, and get it back on their own beat.
       *
       * svg.createDrawable only animates the STROKE — the fill is untouched and
       * paints in full from the first frame. So the legs, hooves, snout, tusks
       * and eyes were all solid silhouettes before a single line had been drawn,
       * and the splash opened on four legs with the body assembling onto them.
       * No amount of reordering fixes that; the fills have to be hidden too.
       */
      fill-opacity={stroke.fill && !reduced ? 0 : undefined}
      data-reveal={REVEAL_INDEX.get(stroke.id) ?? 0}
      stroke={stroke.color}
      stroke-width={stroke.width}
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity={stroke.behind ? 0.85 : 1}
    />
  );
}

function fromData(key: string, fallback: number) {
  return (target?: Target): number => {
    const n = Number((target as HTMLElement | undefined)?.dataset?.[key]);
    return Number.isFinite(n) ? n : fallback;
  };
}

export default function Splash() {
  let rootRef!: HTMLDivElement;
  let artRef!: SVGGElement;
  let timeline: ReturnType<typeof createTimeline> | null = null;

  // Read once, at mount. Unlike the discovery map this thing is on screen for
  // two and a half seconds, so there is no window in which changing the OS
  // setting mid-splash is worth reacting to.
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true;

  let leaving = false;

  /**
   * Leaves. The ONLY thing that dismisses the splash — there is no timer behind
   * it, so the fade is a response to the user rather than something they raced.
   *
   * Guarded, because click-anywhere and the button both land here and a second
   * fade would restart the first one from full opacity.
   */
  function leave(): void {
    if (leaving) return;
    leaving = true;
    timeline?.pause();
    animate(rootRef, {
      opacity: 0,
      scale: reduced ? 1 : 1.05,
      duration: reduced ? SPLASH.reducedFade : SPLASH.exitDur,
      ease: 'inQuad',
      onComplete: () => setSplashDone(true),
    });
  }

  function replay(): void {
    if (leaving || reduced) return;
    timeline?.restart();
  }

  onMount(() => {
    // Click anywhere continues, space replays. Both stay in the shipped app
    // rather than being review scaffolding: 2.5s is short, but it is 2.5s the
    // user did not ask for, and anyone who wants to watch the thing again
    // should not have to relaunch to do it.
    //
    // Space is preventDefault'd — it scrolls by default, and the app underneath
    // is already mounted and listening.
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      replay();
    };
    const onClick = () => leave();
    window.addEventListener('keydown', onKey);
    rootRef.addEventListener('click', onClick);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey);
      rootRef.removeEventListener('click', onClick);
    });

    // Reduced motion: everything is already at its final state in the markup,
    // so there is nothing to reveal and no timeline to build. It simply sits
    // there until the user clicks, which is what it does anyway.
    if (reduced) return;

    // Collected in STROKES order, not DOM order. The two differ on purpose: the
    // legs are painted under the body but revealed after it, so querying the DOM
    // would hand the stagger the paint order and open the splash on four legs.
    const strokePaths = STROKES
      .map(s => artRef.querySelector<SVGPathElement>(`#stroke-${s.id}`))
      .filter((el): el is SVGPathElement => el !== null);
    const facetPaths = Array.from(artRef.querySelectorAll<SVGPathElement>('.splash-facet'));
    const bandUses = Array.from(rootRef.querySelectorAll<SVGUseElement>('.splash-band'));
    const sparkDots = Array.from(rootRef.querySelectorAll<SVGCircleElement>('.splash-spark'));
    // Both eyes, together — a face that lights one first is winking.
    const eyePaths = EYE_IDS
      .map(id => artRef.querySelector<SVGPathElement>(`#stroke-${id}`))
      .filter((el): el is SVGPathElement => el !== null);

    // `0, 0` is the initial draw extent: nothing on screen yet. Without it the
    // finished boar paints for one frame before the timeline takes over, which
    // reads as a flicker rather than as a reveal.
    const drawables = svg.createDrawable(strokePaths, 0, 0);

    // No onComplete. The timeline finishing is not an event anything acts on —
    // the splash settles and waits, and only the user ends it.
    timeline = createTimeline({ defaults: { ease: 'outQuad' } });

    // The strokes draw themselves on in boarStrokes order — skull, face, snout,
    // then the tusks that frame it, eyes last. Each half-stroke arrives beside
    // its mirror, so the face never builds itself lopsided. The stagger is what
    // makes that order legible; without it the whole wireframe simply appears.
    timeline.add(
      drawables,
      { draw: '0 1', duration: SPLASH.drawDur, ease: 'inOut(2)' },
      stagger(SPLASH.drawStagger, { start: SPLASH.drawStart }),
    );

    // Each filled shape gains its fill just after its own outline is drawn, so
    // the animal solidifies in the same order it is drawn rather than all at
    // once. Delay comes off the element's own reveal index — the filled paths
    // are a subset, so a stagger over them would restart at zero and drift out
    // of step with the outlines it is meant to follow.
    const filled = strokePaths.filter(el => el.getAttribute('fill-opacity') !== null);
    if (filled.length) {
      timeline.add(
        filled,
        {
          'fill-opacity': 1,
          duration: 380,
          delay: (target?: Target) =>
            SPLASH.drawStart + fromData('reveal', 0)(target) * SPLASH.drawStagger + 130,
        },
        0,
      );
    }

    // Facets wash in behind, so the animal gains mass rather than staying a
    // diagram. Each keeps its own opacity: flattening them to one value is what
    // makes flat shading look like a mistake.
    if (facetPaths.length) {
      timeline.add(
        facetPaths,
        { opacity: fromData('opacity', 0.12), duration: SPLASH.facetsDur },
        SPLASH.facetsAt,
      );
    }

    // Two glitch hits: slices of the finished head jump sideways and flash.
    if (bandUses.length) {
      timeline.add(
        bandUses,
        {
          opacity: [
            { to: 0.9, duration: 40 },
            { to: 0, duration: 60, delay: 60 },
            { to: 0.75, duration: 40, delay: 60 },
            { to: 0, duration: 80 },
          ],
          translateX: fromData('dx', 0),
          ease: 'steps(3)',
        },
        SPLASH.glitchAt,
      );
    }

    // The ghosts pull apart on the same beat and settle back, so the split reads
    // as the picture tearing rather than as two drawings that were always there.
    timeline.add(
      '.splash-chroma',
      { opacity: [0.5, 0.8, 0.45], scale: [1, 1.015, 1], duration: SPLASH.glitchDur },
      SPLASH.glitchAt,
    );

    // The eyes switching on is the moment the head stops being a drawing.
    if (eyePaths.length) {
      timeline.add(
        eyePaths,
        { opacity: [0.35, 1], duration: 420 },
        SPLASH.eyeAt,
      );
    }

    if (sparkDots.length) {
      timeline.add(
        sparkDots,
        {
          opacity: [{ to: 1, duration: 60 }, { to: 0, duration: 300 }],
          translateY: -14,
          delay: fromData('delay', 0),
        },
        SPLASH.sparksAt,
      );
    }

    timeline.add(
      '.splash-mark',
      { opacity: [0, 1], translateY: [10, 0], duration: SPLASH.markDur },
      SPLASH.markAt,
    );

    // A beat of nothing, so the timeline's own end is `settleAt` rather than
    // whenever the last visible thing happened to finish — which is what makes
    // a replay run for the same length every time.
    timeline.add(rootRef, { opacity: 1, duration: 1 }, SPLASH.settleAt - 1);

    onCleanup(() => timeline?.pause());
  });

  return (
    <div
      class="splash"
      classList={{ 'splash-static': reduced }}
      ref={rootRef}
      /*
       * No context menu. The webview's default one offers Reload and Inspect
       * Element over what is meant to read as an application launching, and the
       * splash is the one screen with nothing on it worth right-clicking — no
       * text to copy, no image to save. Scoped to the splash rather than the
       * document: the rest of the app has terminals full of output people
       * legitimately want to copy out of.
       */
      onContextMenu={e => e.preventDefault()}
    >
      <div class="splash-grid" />
      <div class="splash-vignette" />

      <svg
        class="splash-boar"
        viewBox={`0 0 ${BOAR_VIEWBOX.w} ${BOAR_VIEWBOX.h}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          {/* Neon bloom. Two blurs merged under the source rather than one wide
              one: a single pass reads as soft focus, doubling it gives the tight
              core plus halo that a lit tube actually has. */}
          <filter id="boar-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="wide" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="0.7" result="tight" />
            <feMerge>
              <feMergeNode in="wide" />
              <feMergeNode in="tight" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Keep two channels, drop the third — the ghost is the same drawing
              seen through one side of a split beam, not a recoloured copy. */}
          <filter id="boar-chroma-c">
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0.13  0 0 0 0 0.91  0 0 0 0 1  0 0 0 1 0"
            />
          </filter>
          <filter id="boar-chroma-m">
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 1  0 0 0 0 0.18  0 0 0 0 0.73  0 0 0 1 0"
            />
          </filter>

          <For each={BANDS}>
            {(band, i) => (
              <clipPath id={`boar-band-${i()}`}>
                <rect x="0" y={band.y} width={BOAR_VIEWBOX.w} height={band.h} />
              </clipPath>
            )}
          </For>
        </defs>

        <g filter="url(#boar-glow)">
          {/* Forward references: both ghosts sit behind the drawing they mirror,
              which in SVG means being written before it. */}
          <use
            class="splash-chroma"
            href="#boar-lines"
            filter="url(#boar-chroma-c)"
            x={-CHROMA_OFFSET}
            opacity={0.5}
          />
          <use
            class="splash-chroma"
            href="#boar-lines"
            filter="url(#boar-chroma-m)"
            x={CHROMA_OFFSET}
            opacity={0.5}
          />

          <g id="boar-art" ref={artRef}>
            {/* The far side of the animal, under the body — which is the whole
                of what makes it the far side. */}
            <For each={BEHIND}>{stroke => path(stroke, reduced)}</For>

            <For each={FACETS}>
              {facet => (
                <path
                  class="splash-facet"
                  d={facet.d}
                  fill={facet.color}
                  data-opacity={facet.opacity}
                  opacity={reduced ? facet.opacity : 0}
                />
              )}
            </For>

            {/* The linework, and only the linework, is what the chroma ghosts
                copy. Splitting the fills out of their reach is what stopped the
                whole animal coming out mauve: a channel filter tints everything
                it is handed, and handed a body it tints the body. */}
            <g id="boar-lines">
              <For each={FRONT}>{stroke => path(stroke, reduced)}</For>
            </g>
          </g>

          <For each={BANDS}>
            {(band, i) => (
              <use
                class="splash-band"
                href="#boar-art"
                clip-path={`url(#boar-band-${i()})`}
                data-dx={band.dx}
                opacity={0}
              />
            )}
          </For>
        </g>

        <g class="splash-sparks">
          <For each={SPARKS}>
            {spark => (
              <circle
                class="splash-spark"
                cx={spark.x}
                cy={spark.y}
                r={spark.r}
                fill={spark.color}
                data-delay={spark.delay}
                opacity={0}
              />
            )}
          </For>
        </g>
      </svg>

      <div
        class="splash-mark"
        style={{
          // Feeds the wordmark's glitch keyframes their start time, so the CSS
          // and the anime.js beat cannot drift apart.
          '--mark-at': `${SPLASH.markAt}ms`,
          ...(reduced ? { opacity: 1 } : {}),
        }}
      >
        <span class="splash-mark-name" data-text="yv">yv</span>
        <span class="splash-mark-sub">local dev command runner</span>
      </div>

      {/* The controls are worth naming: a splash nobody knows they can skip is
          one they sit through. The link stops the click propagating, or opening
          it would dismiss the splash out from under the browser it just
          launched. */}
      <div class="splash-hint">
        <a
          class="splash-hint-link"
          href={ABOUT_URL}
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
            runtime.BrowserOpenURL(ABOUT_URL);
          }}
        >
          about
        </a>
        <span class="splash-hint-sep">·</span>
        click to continue
        <span class="splash-hint-sep">·</span>
        <kbd>space</kbd> to replay
      </div>
    </div>
  );
}
