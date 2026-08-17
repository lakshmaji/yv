import { describe, it, expect } from 'vitest';
import { escHtml, lineClass, formatBytes, shortenPath } from './utils';

// formatBytes became load-bearing with the dashboard (chart tooltips, axis
// ticks, stat tiles), so it is pinned here.
describe('formatBytes', () => {
  const cases: [string, number, string][] = [
    ['zero', 0, '0 B'],
    ['bytes below a kilobyte', 512, '512 B'],
    ['one byte short of a kilobyte', 1023, '1023 B'],
    ['exactly one kilobyte', 1024, '1 KB'],
    ['kilobytes round to whole numbers', 1536, '2 KB'],
    ['exactly one megabyte', 1048576, '1 MB'],
    ['a typical process', 32 * 1048576, '32 MB'],
    ['exactly one gigabyte', 1073741824, '1.0 GB'],
    ['gigabytes keep one decimal', Math.round(1.5 * 1073741824), '1.5 GB'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it('does not crash on a negative value', () => {
    expect(() => formatBytes(-1)).not.toThrow();
  });
});

describe('escHtml', () => {
  const cases: [string, string, string][] = [
    ['plain text passes through', 'hello', 'hello'],
    ['ampersand', 'a & b', 'a &amp; b'],
    ['angle brackets', '<script>', '&lt;script&gt;'],
    ['double quotes', 'say "hi"', 'say &quot;hi&quot;'],
    ['escapes the ampersand first', '&lt;', '&amp;lt;'],
    ['empty string', '', ''],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(escHtml(input)).toBe(expected);
  });
});

describe('lineClass', () => {
  const cases: [string, string, string][] = [
    ['pre-hook marker', '[PRE] 1/2: nvm use', 'term-line line-pre'],
    ['post-hook marker', '[POST] 1/1: cleanup', 'term-line line-post'],
    ['error keyword', 'Error: something broke', 'term-line line-error'],
    ['ENOENT', 'ENOENT no such file', 'term-line line-error'],
    ['warning keyword', 'WARNING: deprecated api', 'term-line line-warn'],
    ['stack frame', '    at Object.foo (bar.js:1)', 'term-line line-stack'],
    ['ordinary output', 'Build succeeded', 'term-line'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(lineClass(input)).toBe(expected);
  });
});

describe('shortenPath', () => {
  const cases: [string, number, string][] = [
    // Short enough to show whole, so it keeps its leading slash.
    ['/Users/me', 3, '/Users/me'],
    ['/a/b/c', 3, '/a/b/c'],
    ['yv.yaml', 3, 'yv.yaml'],
    ['', 3, ''],
    // Long paths keep the end, which is the part that identifies them.
    ['/Users/me/code/storefront/yv.yaml', 3, '…/code/storefront/yv.yaml'],
    ['/Users/lakshmaji/conductor/workspaces/pos-app/yv.yaml', 3, '…/workspaces/pos-app/yv.yaml'],
    ['/Users/me/code/storefront/yv.yaml', 2, '…/storefront/yv.yaml'],
    // A relative path is treated the same way.
    ['a/b/c/d/e', 2, '…/d/e'],
    // Repeated and trailing separators must not produce empty segments.
    ['/a//b///c/d', 2, '…/c/d'],
  ];

  for (const [input, keep, want] of cases) {
    it(`${JSON.stringify(input)} keep=${keep} -> ${JSON.stringify(want)}`, () => {
      expect(shortenPath(input, keep)).toBe(want);
    });
  }

  // The whole point of shortening rather than CSS-truncating: no bidi
  // reordering, so the result never gains a trailing slash it did not have.
  it('never moves the leading separator to the end', () => {
    expect(shortenPath('/Users/me/code/app/yv.yaml')).not.toMatch(/\/$/);
  });
});
