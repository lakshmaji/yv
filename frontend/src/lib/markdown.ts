import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Renders a command description for display. This is the one place markdown
 * becomes HTML in the app — every reader of `cmd.description` goes through
 * here rather than calling `marked`/`DOMPurify` directly, so sanitization
 * can't be forgotten at a second call site.
 */
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }));
}
