import type {ReactNode} from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';
import {createTimeline, svg} from 'animejs';

import useReducedMotion from '@site/src/hooks/useReducedMotion';
import Bubble from './Bubble';
import Dino from './Dino';
import {
  DIALOG,
  PLANET,
  VIEW,
  arcBetween,
  arcMidpoint,
  buildScene,
  speechAnchor,
  sphereProject,
  standOn,
} from './scene';
import styles from './Planet.module.css';

const CLIP_ID = 'yv-planet-clip';

/**
 * A small world with dinosaurs on it, one of whom needs a command and gets it.
 *
 * The sequence — ask, nod, send, land, thank — is a single anime.js timeline
 * driving groups that each own exactly one transform. It loops, because the
 * point of the scene is that anyone who arrives mid-cycle still sees the whole
 * exchange within a few seconds.
 */
export default function Planet(): ReactNode {
  const reduced = useReducedMotion();
  const root = useRef<SVGSVGElement>(null);

  // A fixed seed renders on the server and on the first client paint; the real
  // one is drawn after mount, so every visit gets a different world without a
  // hydration mismatch.
  const [seed, setSeed] = useState(7);
  useEffect(() => setSeed(Math.floor(Math.random() * 1e9)), []);
  const {cast, scenery} = useMemo(() => buildScene(seed), [seed]);

  const trail = useMemo(
    () => arcBetween(cast.sender.deg, cast.asker.deg),
    [cast.sender.deg, cast.asker.deg],
  );
  const parked = useMemo(
    () => arcMidpoint(cast.sender.deg, cast.asker.deg),
    [cast.sender.deg, cast.asker.deg],
  );
  const say = speechAnchor(cast.asker.deg, cast.asker.scale);

  useEffect(() => {
    const el = root.current;
    if (!el || reduced) {
      return;
    }
    const q = <T extends SVGElement>(cls: string) => el.querySelector<T>(`.${cls}`);
    const ask = q<SVGGElement>(styles.askBubble);
    const thanks = q<SVGGElement>(styles.thanksBubble);
    const chip = q<SVGGElement>(styles.chip);
    const pop = q<SVGGElement>(styles.chipPop);
    const head = q<SVGGElement>(styles.senderHead);
    const hop = q<SVGGElement>(styles.askerHop);
    const line = q<SVGPathElement>(styles.trail);
    if (!ask || !thanks || !chip || !pop || !head || !hop || !line) {
      return;
    }

    const motion = svg.createMotionPath(line);

    const tl = createTimeline({loop: true, defaults: {ease: 'outQuad'}});
    tl
      // Frame 0 — reset, so the loop starts from the same state every cycle.
      .add(pop, {scale: 1, opacity: 1, duration: 1}, 0)
      // Frame 1 — the question.
      .add(ask, {opacity: [0, 1], scale: [0.3, 1], duration: 420, ease: 'outBack'}, 250)
      // Frame 2 — the sender hears it and nods.
      .add(head, {rotate: [0, -16, 0], duration: 760}, 1500)
      .add(ask, {opacity: 0, scale: 0.7, duration: 300}, 1850)
      // Frame 3 — the command flies across, along a path that is never painted.
      .add(chip, {opacity: [0, 1], duration: 220}, 2150)
      .add(
        chip,
        {
          translateX: motion.translateX,
          translateY: motion.translateY,
          duration: 1600,
          ease: 'inOutSine',
        },
        2150,
      )
      // Frame 4 — it lands, and the asker hops.
      .add(pop, {scale: [1, 1.3, 0.2], opacity: [1, 1, 0], duration: 440}, 3750)
      .add(hop, {translateY: [0, -10, 0], duration: 640, ease: 'outElastic'}, 3850)
      .add(chip, {opacity: 0, duration: 1}, 4210)
      // Frame 5 — thanks.
      .add(thanks, {opacity: [0, 1], scale: [0.3, 1], duration: 420, ease: 'outBack'}, 4250)
      .add(thanks, {opacity: 0, scale: 0.7, duration: 380}, 6250);

    return () => {
      tl.revert();
    };
  }, [reduced, seed]);

  return (
    <svg
      ref={root}
      className={styles.scene}
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      role="img"
      aria-label={`Three dinosaurs on a small planet. One asks "${DIALOG.question}", another sends it the command ${DIALOG.command}, and it replies "${DIALOG.thanks}".`}
    >
      <defs>
        <clipPath id={CLIP_ID}>
          <circle cx={PLANET.cx} cy={PLANET.cy} r={PLANET.r} />
        </clipPath>
        {/* Atmosphere: transparent until it is nearly at the rim, so the halo
            hugs the edge instead of fogging the whole disc. */}
        <radialGradient id="yv-planet-atmo">
          <stop offset="0.88" className={styles.atmoIn} />
          <stop offset="1" className={styles.atmoOut} />
        </radialGradient>
        {/* Off-centre shading, which is the only thing making the disc read as
            a sphere rather than a coin. */}
        <radialGradient id="yv-planet-shade" cx="0.34" cy="0.28" r="0.86">
          <stop offset="0.4" className={styles.shadeIn} />
          <stop offset="1" className={styles.shadeOut} />
        </radialGradient>
        {/* Open ocean, lit from the same direction as the shading. */}
        <radialGradient id="yv-planet-sea" cx="0.35" cy="0.3" r="0.82">
          <stop offset="0" className={styles.seaLit} />
          <stop offset="1" className={styles.seaDeep} />
        </radialGradient>
        {/* Rim light along the shadowed limb: light wrapping round the back of
            a ball. Painted as a stroke on the disc's own edge so it can only
            ever be a crescent. */}
        <linearGradient id="yv-planet-rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0.42" className={styles.rimOff} />
          <stop offset="1" className={styles.rimOn} />
        </linearGradient>
        <radialGradient id="yv-planet-spec">
          <stop offset="0" className={styles.specIn} />
          <stop offset="1" className={styles.specOut} />
        </radialGradient>
        {/* One gradient per colourway: the stops need the tone's own two
            variables, and a gradient in <defs> cannot read `currentColor` from
            whichever animal happens to reference it. */}
        <linearGradient id="yv-dino-a" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" className={styles.skinA1} />
          <stop offset="1" className={styles.skinA2} />
        </linearGradient>
        <linearGradient id="yv-dino-b" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" className={styles.skinB1} />
          <stop offset="1" className={styles.skinB2} />
        </linearGradient>
        <linearGradient id="yv-dino-c" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" className={styles.skinC1} />
          <stop offset="1" className={styles.skinC2} />
        </linearGradient>
      </defs>

      <circle
        cx={PLANET.cx}
        cy={PLANET.cy}
        r={PLANET.r + 22}
        fill="url(#yv-planet-atmo)"
      />
      <circle cx={PLANET.cx} cy={PLANET.cy} r={PLANET.r} className={styles.ocean} />

      {/* The surface turns slowly under everyone. CSS, so reduced motion stops
          it without the timeline having to know. */}
      <g className={styles.spin}>
        <g clipPath={`url(#${CLIP_ID})`}>
          {/* Three passes over the same ellipses: shallows, land, then a
              highlight inset toward the light. Drawn as whole layers rather than
              per-continent, so one landmass's shallows never paint over its
              neighbour's shore. */}
          {scenery.continents.map((c, i) => (
            <ellipse
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              cx={c.x}
              cy={c.y}
              rx={c.rx + 5}
              ry={c.ry + 5}
              transform={`${sphereProject(c.x, c.y)} rotate(${c.rot} ${c.x} ${c.y})`}
              className={styles.shelf}
            />
          ))}
          {scenery.continents.map((c, i) => (
            <ellipse
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              cx={c.x}
              cy={c.y}
              rx={c.rx}
              ry={c.ry}
              transform={`${sphereProject(c.x, c.y)} rotate(${c.rot} ${c.x} ${c.y})`}
              className={styles.land}
            />
          ))}
        </g>
        {scenery.hills.map((h, i) => (
          <path
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            transform={standOn(h.deg)}
            d={`M ${-h.w / 2} 1 Q 0 ${-h.h * 2.1} ${h.w / 2} 1 Z`}
            className={styles.hill}
          />
        ))}
        {scenery.trees.map((t, i) => (
          // eslint-disable-next-line react/no-array-index-key
          // Round canopies, not conifers: at this size a triangle reads as an
          // arrowhead pointing off the planet.
          <g key={i} transform={standOn(t.deg, t.scale)}>
            <path d="M 0 1 L 0 -9" className={styles.trunk} />
            <circle cx={0} cy={-14} r={8} className={styles.tree} />
            <circle cx={-5} cy={-9} r={5.5} className={styles.tree} />
            <circle cx={5} cy={-9} r={5.5} className={styles.tree} />
          </g>
        ))}
      </g>

      {/* Ice caps sit outside the spin group: the surface turns, the poles do
          not move with it.

          Each is a big circle centred beyond the pole, so what the clip leaves
          behind is a cap with a curved edge. An ellipse centred *on* the pole
          would be cut into a flat-bottomed lens instead, which reads as a slice
          taken out of the planet. */}
      <g clipPath={`url(#${CLIP_ID})`}>
        <circle
          cx={PLANET.cx}
          cy={PLANET.cy - PLANET.r - 108}
          r={126}
          className={styles.ice}
        />
        <circle
          cx={PLANET.cx}
          cy={PLANET.cy + PLANET.r + 112}
          r={126}
          className={styles.ice}
        />
      </g>

      <circle
        cx={PLANET.cx}
        cy={PLANET.cy}
        r={PLANET.r}
        fill="url(#yv-planet-shade)"
        pointerEvents="none"
      />
      <circle
        cx={PLANET.cx}
        cy={PLANET.cy}
        r={PLANET.r - 2.5}
        fill="none"
        stroke="url(#yv-planet-rim)"
        strokeWidth={5}
        pointerEvents="none"
      />
      {/* Specular: the wet-ball highlight. Small and soft, or it looks like a
          hole in the planet. */}
      <ellipse
        cx={PLANET.cx - PLANET.r * 0.4}
        cy={PLANET.cy - PLANET.r * 0.44}
        rx={PLANET.r * 0.38}
        ry={PLANET.r * 0.26}
        transform={`rotate(-32 ${PLANET.cx - PLANET.r * 0.4} ${PLANET.cy - PLANET.r * 0.44})`}
        fill="url(#yv-planet-spec)"
        pointerEvents="none"
      />

      <g className={styles.drift}>
        {scenery.clouds.map((c, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <g key={i} transform={standOn(c.deg)}>
            <g transform={`translate(0 ${-c.lift})`} className={styles.cloud}>
              <ellipse cx={0} cy={0} rx={c.w / 2} ry={c.w / 5} />
              <ellipse cx={-c.w / 5} cy={-c.w / 9} rx={c.w / 4} ry={c.w / 6} />
              <ellipse cx={c.w / 5} cy={-c.w / 10} rx={c.w / 5} ry={c.w / 7} />
            </g>
          </g>
        ))}
      </g>

      <g transform={standOn(cast.watcher.deg, cast.watcher.scale, cast.watcher.facing)}>
        <Dino species={cast.watcher.species} tone="c" />
      </g>

      <g transform={standOn(cast.sender.deg, cast.sender.scale, cast.sender.facing)}>
        <Dino species={cast.sender.species} tone="b" headClassName={styles.senderHead} />
      </g>
      <g transform={standOn(cast.asker.deg, cast.asker.scale, cast.asker.facing)}>
        <g className={styles.askerHop}>
          <Dino species={cast.asker.species} tone="a" />
        </g>
      </g>

      <path d={trail} className={styles.trail} />

      <g transform={`translate(${say.x} ${say.y})`}>
        <Bubble text={DIALOG.question} className={styles.askBubble} flip />
      </g>
      <g transform={`translate(${say.x - 8} ${say.y - 52})`}>
        <Bubble text={DIALOG.thanks} className={styles.thanksBubble} flip />
      </g>

      <g className={styles.chip} transform={`translate(${parked.x} ${parked.y})`}>
        <g className={styles.chipPop}>
          <rect x={-72} y={-14} width={144} height={28} rx={14} className={styles.chipBox} />
          <text x={0} y={0.5} className={styles.chipText}>
            {DIALOG.command}
          </text>
        </g>
      </g>
    </svg>
  );
}
