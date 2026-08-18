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

    const drawable = svg.createDrawable(line);
    const motion = svg.createMotionPath(line);

    const tl = createTimeline({loop: true, defaults: {ease: 'outQuad'}});
    tl
      // Frame 0 — reset, so the loop starts from the same state every cycle.
      .add(drawable, {draw: '0 0', duration: 1}, 0)
      .add(line, {opacity: 1, duration: 1}, 0)
      .add(pop, {scale: 1, opacity: 1, duration: 1}, 0)
      // Frame 1 — the question.
      .add(ask, {opacity: [0, 1], scale: [0.3, 1], duration: 420, ease: 'outBack'}, 250)
      // Frame 2 — the sender hears it and nods.
      .add(head, {rotate: [0, -16, 0], duration: 760}, 1500)
      .add(ask, {opacity: 0, scale: 0.7, duration: 300}, 1850)
      // Frame 3 — the link draws itself, then the command travels along it.
      .add(drawable, {draw: ['0 0', '0 1'], duration: 700, ease: 'inOutQuad'}, 2050)
      .add(chip, {opacity: [0, 1], duration: 200}, 2300)
      .add(
        chip,
        {
          translateX: motion.translateX,
          translateY: motion.translateY,
          duration: 1500,
          ease: 'inOutSine',
        },
        2300,
      )
      // Frame 4 — it lands, and the asker hops.
      .add(pop, {scale: [1, 1.3, 0.2], opacity: [1, 1, 0], duration: 440}, 3800)
      .add(hop, {translateY: [0, -10, 0], duration: 640, ease: 'outElastic'}, 3900)
      .add(drawable, {draw: '1 1', duration: 600, ease: 'inOutQuad'}, 3950)
      .add(chip, {opacity: 0, duration: 1}, 4260)
      // Frame 5 — thanks.
      .add(thanks, {opacity: [0, 1], scale: [0.3, 1], duration: 420, ease: 'outBack'}, 4300)
      .add(thanks, {opacity: 0, scale: 0.7, duration: 380}, 6300);

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
          {scenery.continents.map((c, i) => (
            <ellipse
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              cx={c.x}
              cy={c.y}
              rx={c.rx}
              ry={c.ry}
              transform={`rotate(${c.rot} ${c.x} ${c.y})`}
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
          <g key={i} transform={standOn(t.deg, t.scale)}>
            <path d="M 0 1 L 0 -7" className={styles.trunk} />
            <path d="M 0 -3 L -7 -3 L 0 -20 L 7 -3 Z" className={styles.tree} />
          </g>
        ))}
      </g>

      <circle
        cx={PLANET.cx}
        cy={PLANET.cy}
        r={PLANET.r}
        fill="url(#yv-planet-shade)"
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
