/**
 * Tidies a CHANGELOG section for display in the update dialog.
 *
 * Release notes reach us as markdown, because changesets writes markdown and the
 * release body is that file's section verbatim. Shown raw, the dialog reads
 * "### Minor Changes" and "**0.2.0**" — the punctuation of a format nobody is
 * looking at the source of.
 *
 * This is deliberately *not* a markdown renderer. A real one is a dependency and
 * an HTML-injection surface for text that arrives over the network, to display
 * perhaps two headings and a list. Stripping the handful of markers changesets
 * actually emits gets the same result with neither.
 */
export function formatReleaseNotes(markdown: string): string {
  if (!markdown) return '';

  const lines = markdown.split('\n').map((line) => {
    let out = line;

    // "### Minor Changes" -> "Minor Changes". The heading level carries no
    // meaning here: everything renders at one size.
    out = out.replace(/^\s{0,3}#{1,6}\s+/, '');

    // A version heading is the whole line and duplicates what the dialog
    // already shows two rows above.
    out = out.replace(/^\*\*(.+)\*\*$/, '$1');

    // "- [`abc1234`](https://…) Thanks [@someone](https://…)!" — the label is
    // the readable half; the URL is not clickable in this box anyway.
    //
    // The target allows one level of nested parentheses. A plainer [^)]* stops
    // at the first ")", so a URL containing one — a Wikipedia article, a
    // javascript:alert(1) someone tried — is only half consumed and leaves a
    // stray bracket in the middle of the sentence.
    out = out.replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');

    // Emphasis and inline code markers, left over once links are flattened.
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
    out = out.replace(/`([^`]+)`/g, '$1');

    return out.trimEnd();
  });

  return lines
    .join('\n')
    // Changesets separates every entry with a blank line and each section with
    // two; collapsing runs keeps a long release from being mostly whitespace.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
