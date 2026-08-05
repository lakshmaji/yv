import { describe, it, expect } from 'vitest';
import {
  ENV_BG_PRESETS, ENV_TEXT_PRESETS, isValidColor, envChipStyle, swatchStyle,
} from './envColors';

describe('presets', () => {
  const cases: Array<{ name: string; presets: typeof ENV_BG_PRESETS }> = [
    { name: 'background', presets: ENV_BG_PRESETS },
    { name: 'text', presets: ENV_TEXT_PRESETS },
  ];

  for (const tc of cases) {
    it(`${tc.name}: first entry is the default (empty) value`, () => {
      expect(tc.presets[0].value).toBe('');
    });

    it(`${tc.name}: every colour is valid`, () => {
      for (const preset of tc.presets) {
        expect(isValidColor(preset.value)).toBe(true);
      }
    });

    it(`${tc.name}: values and names are unique`, () => {
      expect(new Set(tc.presets.map(p => p.value)).size).toBe(tc.presets.length);
      expect(new Set(tc.presets.map(p => p.name)).size).toBe(tc.presets.length);
    });
  }
});

describe('isValidColor', () => {
  const cases: Array<{ name: string; color: string | undefined; want: boolean }> = [
    { name: 'undefined means default', color: undefined, want: true },
    { name: 'empty means default', color: '', want: true },
    { name: 'six digit lowercase', color: '#1f6feb', want: true },
    { name: 'six digit uppercase', color: '#1F6FEB', want: true },
    { name: 'three digit', color: '#fff', want: true },
    { name: 'missing hash', color: '1f6feb', want: false },
    { name: 'named colour', color: 'red', want: false },
    { name: 'five digits', color: '#12345', want: false },
    { name: 'seven digits', color: '#1234567', want: false },
    { name: 'non-hex digit', color: '#12345g', want: false },
    { name: 'css injection attempt', color: '#fff;background:url(x)', want: false },
  ];

  for (const tc of cases) {
    it(tc.name, () => expect(isValidColor(tc.color)).toBe(tc.want));
  }
});

describe('envChipStyle', () => {
  const cases: Array<{
    name: string;
    env: { bgColor?: string; textColor?: string } | null | undefined;
    want: Record<string, string>;
  }> = [
    { name: 'null environment', env: null, want: {} },
    { name: 'undefined environment', env: undefined, want: {} },
    { name: 'no colours set', env: {}, want: {} },
    {
      name: 'background only',
      env: { bgColor: '#1f6feb' },
      want: { background: '#1f6feb', 'border-color': '#1f6feb' },
    },
    {
      name: 'text only',
      env: { textColor: '#ffffff' },
      want: { color: '#ffffff' },
    },
    {
      name: 'both colours',
      env: { bgColor: '#238636', textColor: '#0d1117' },
      want: { background: '#238636', 'border-color': '#238636', color: '#0d1117' },
    },
    {
      name: 'empty strings are ignored',
      env: { bgColor: '', textColor: '' },
      want: {},
    },
    {
      name: 'invalid background is dropped, valid text kept',
      env: { bgColor: 'red; content: hack', textColor: '#fff' },
      want: { color: '#fff' },
    },
    {
      name: 'invalid text is dropped, valid background kept',
      env: { bgColor: '#fff', textColor: 'javascript:alert(1)' },
      want: { background: '#fff', 'border-color': '#fff' },
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => expect(envChipStyle(tc.env)).toEqual(tc.want));
  }
});

describe('swatchStyle', () => {
  const cases: Array<{ name: string; value: string; want: Record<string, string> }> = [
    { name: 'default swatch has no inline colour', value: '', want: {} },
    { name: 'colour swatch', value: '#da3633', want: { background: '#da3633', 'border-color': '#da3633' } },
  ];

  for (const tc of cases) {
    it(tc.name, () => expect(swatchStyle(tc.value)).toEqual(tc.want));
  }
});
