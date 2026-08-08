import { describe, it, expect } from 'vitest';
import { formatReleaseNotes } from './releaseNotes';

describe('formatReleaseNotes', () => {
  const cases: Array<[string, string, string]> = [
    ['empty', '', ''],
    ['plain prose is untouched', 'A new version.', 'A new version.'],
    ['section heading', '### Minor Changes', 'Minor Changes'],
    ['any heading level', '# Big\n## Medium\n###### Small', 'Big\nMedium\nSmall'],
    ['a hash mid-line is not a heading', 'Fixes issue #42', 'Fixes issue #42'],
    ['bold version heading', '**0.2.0**', '0.2.0'],
    ['inline bold', 'Now **much** faster', 'Now much faster'],
    ['inline code', 'Renamed `foo` to `bar`', 'Renamed foo to bar'],
    [
      'a changeset-github credit line',
      '- [`abc1234`](https://github.com/x/y/commit/abc) Thanks [@someone](https://github.com/someone)! - Fixed it',
      '- abc1234 Thanks @someone! - Fixed it',
    ],
    ['bullets survive', '- one\n- two', '- one\n- two'],
    ['runs of blank lines collapse', 'a\n\n\n\n\nb', 'a\n\nb'],
    ['surrounding whitespace goes', '\n\n  Notes\n\n', 'Notes'],
    ['a url containing parentheses is fully consumed', '[wiki](https://x/Foo_(bar))', 'wiki'],
    ['trailing whitespace per line goes', 'a   \nb  ', 'a\nb'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(formatReleaseNotes(input)).toBe(expected);
  });

  it('formats a realistic changesets section', () => {
    const input = [
      '## 0.2.0',
      '',
      '### Minor Changes',
      '',
      '- Auto-update: yv checks for releases and **verifies** them.',
      '- About shows the running version.',
      '',
      '',
      '### Patch Changes',
      '',
      '- [`a1b2c3d`](https://github.com/lakshmaji/yv/commit/a1b2c3d) The heatmap fills its card.',
    ].join('\n');

    expect(formatReleaseNotes(input)).toBe(
      [
        '0.2.0',
        '',
        'Minor Changes',
        '',
        '- Auto-update: yv checks for releases and verifies them.',
        '- About shows the running version.',
        '',
        'Patch Changes',
        '',
        '- a1b2c3d The heatmap fills its card.',
      ].join('\n'),
    );
  });

  // The notes come off the network and land in a text node. They must stay
  // text: nothing here may turn a payload into markup, and the dialog renders
  // the result with {} rather than innerHTML for the same reason.
  it('does not turn anything into markup', () => {
    const hostile = '<img src=x onerror=alert(1)> **and** [a](javascript:alert(2))';
    const out = formatReleaseNotes(hostile);
    expect(out).toBe('<img src=x onerror=alert(1)> and a');
    expect(out).not.toContain('javascript:');
  });
});
