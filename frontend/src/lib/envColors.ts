/**
 * Preset colours for environments, plus the single helper that turns an
 * environment into inline styles. Pure and framework-free so it is unit
 * testable, and shared by every surface that paints an environment (selector
 * trigger, dropdown menu, manage modal) — one source of truth for the look.
 */
import type { Environment } from '../types';

export interface ColorPreset {
  name: string;
  value: string;
}

/** Background swatches. The empty value means "use the default theme". */
export const ENV_BG_PRESETS: ColorPreset[] = [
  { name: 'Default', value: '' },
  { name: 'Slate', value: '#30363d' },
  { name: 'Blue', value: '#1f6feb' },
  { name: 'Green', value: '#238636' },
  { name: 'Teal', value: '#0f766e' },
  { name: 'Amber', value: '#9e6a03' },
  { name: 'Red', value: '#da3633' },
  { name: 'Purple', value: '#6e40c9' },
  { name: 'Pink', value: '#bf3989' },
];

/** Text swatches, kept short: light, dark, or muted. */
export const ENV_TEXT_PRESETS: ColorPreset[] = [
  { name: 'Default', value: '' },
  { name: 'White', value: '#ffffff' },
  { name: 'Ink', value: '#0d1117' },
  { name: 'Muted', value: '#8b949e' },
];

/** Matches the Go-side rule in internal/env.ValidateColor. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True for an empty string (default theme) or a valid #rgb / #rrggbb colour. */
export function isValidColor(color: string | undefined): boolean {
  if (!color) return true;
  return HEX_RE.test(color);
}

/** Inline style for an environment chip. Omits keys the environment leaves unset. */
export function envChipStyle(env: Pick<Environment, 'bgColor' | 'textColor'> | null | undefined) {
  const style: Record<string, string> = {};
  if (!env) return style;
  if (isValidColor(env.bgColor) && env.bgColor) {
    style['background'] = env.bgColor;
    style['border-color'] = env.bgColor;
  }
  if (isValidColor(env.textColor) && env.textColor) {
    style['color'] = env.textColor;
  }
  return style;
}

/** Inline style for a colour swatch button. Empty value renders as a "none" chip. */
export function swatchStyle(value: string) {
  return value ? { background: value, 'border-color': value } : {};
}
