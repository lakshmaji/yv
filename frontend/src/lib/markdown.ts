import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Renders a command description for display. This is the one place markdown
 * becomes HTML in the app — every reader of `cmd.description` goes through
 * here rather than calling `marked`/`DOMPurify` directly, so sanitization
 * can't be forgotten at a second call site.
 */
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }), {
    // The rendered result goes straight into innerHTML in the main app
    // window, not a sandboxed iframe — a `style` attribute survives
    // DOMPurify's defaults and `position: fixed` escapes the modal box, so a
    // hand-written or cloned description could paint over the whole window.
    FORBID_TAGS: ['style'],
    FORBID_ATTR: ['style'],
  });
}
