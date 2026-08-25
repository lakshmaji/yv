// @vitest-environment jsdom
// DOMPurify.sanitize needs a real DOM; every other test in this suite is pure
// logic and stays on the fast 'node' environment set in vite.config.js.
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders a heading', () => {
    expect(renderMarkdown('### Title')).toContain('<h3>Title</h3>');
  });

  it('renders a list', () => {
    const html = renderMarkdown('- one\n- two');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders a link', () => {
    const html = renderMarkdown('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('>docs<');
  });

  it('strips a script tag', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
  });

  it('strips an inline event handler', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('handles an empty description', () => {
    expect(renderMarkdown('')).toBe('');
  });
});
