import {useEffect, useState} from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the user has asked for reduced motion, kept live.
 *
 * CSS keyframes stop on their own when the media query flips. Script-driven
 * animation does not — it has to be told, and the OS setting can change while
 * the page is open, so the listener is the whole point of this hook.
 *
 * Returns `false` during server rendering and on the first client paint, which
 * is why anything that starts hidden also needs a `prefers-reduced-motion`
 * rule in CSS: the hook cannot un-hide it before hydration.
 */
export default function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
