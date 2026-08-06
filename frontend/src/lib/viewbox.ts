// Which part of an SVG viewBox a container actually shows.
//
// `preserveAspectRatio="… slice"` scales the viewBox to *cover* its container
// and crops the overflow, so with a container that isn't the viewBox's aspect
// ratio some of those coordinates are off-screen. Anything positioned in viewBox
// space that must stay visible — a label, a marker, a dinosaur — has to be placed
// against the visible rect rather than the full one.

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Insets {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/**
 * The visible sub-rect of `view`, in viewBox coordinates, when drawn into
 * `container` with xMidYMid slice.
 *
 * Falls back to the whole viewBox for a container of unknown or zero size,
 * which is what a component sees before its first layout pass.
 */
export function visibleViewBox(view: Size, container: Size): Rect {
  if (
    !(container.width > 0) || !(container.height > 0) ||
    !(view.width > 0) || !(view.height > 0)
  ) {
    return { x: 0, y: 0, width: view.width, height: view.height };
  }

  // slice covers the container, so the scale is the larger of the two ratios.
  const scale = Math.max(container.width / view.width, container.height / view.height);
  const visibleW = Math.min(view.width, container.width / scale);
  const visibleH = Math.min(view.height, container.height / scale);

  // xMidYMid centres the overflow, so the crop is split evenly on both sides.
  return {
    x: (view.width - visibleW) / 2,
    y: (view.height - visibleH) / 2,
    width: visibleW,
    height: visibleH,
  };
}

/** Shrinks a rect. Never returns a negative size — it collapses to zero instead. */
export function insetRect(rect: Rect, insets: Insets): Rect {
  const { left = 0, right = 0, top = 0, bottom = 0 } = insets;
  const width = Math.max(0, rect.width - left - right);
  const height = Math.max(0, rect.height - top - bottom);
  return { x: rect.x + left, y: rect.y + top, width, height };
}

/**
 * Snaps a rect to a grid, rounding *inward* on every edge.
 *
 * Used to damp a ResizeObserver: without it every pixel of a window drag would
 * change the placement bounds, and anything sampled from them would flicker
 * around the screen for the whole drag.
 *
 * Inward matters. Rounding the origin and the size independently — the obvious
 * implementation — can push the far edge past where it started, so a "safe"
 * rect ends up larger than the area it was meant to stay inside. The result here
 * is always contained by the input.
 */
export function quantizeRect(rect: Rect, step: number): Rect {
  if (!(step > 0)) return rect;
  const x = Math.ceil(rect.x / step) * step;
  const y = Math.ceil(rect.y / step) * step;
  const right = Math.floor((rect.x + rect.width) / step) * step;
  const bottom = Math.floor((rect.y + rect.height) / step) * step;
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}
