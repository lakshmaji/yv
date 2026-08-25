/**
 * Pure string manipulation behind the description toolbar buttons: given the
 * textarea's current text and selection, returns the new text and the
 * selection the caller should restore. No SolidJS, no DOM, so it is testable
 * without mounting EditCommandModal.
 */
export type MarkdownOp = 'bold' | 'italic' | 'code' | 'link' | 'list';

export interface MarkdownInsert {
  text: string;
  start: number;
  end: number;
}

const WRAP: Record<'bold' | 'italic' | 'code', string> = { bold: '**', italic: '_', code: '`' };

export function applyMarkdownOp(text: string, start: number, end: number, op: MarkdownOp): MarkdownInsert {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  if (op === 'bold' || op === 'italic' || op === 'code') {
    const marker = WRAP[op];
    const newText = before + marker + selected + marker + after;
    if (selected) return { text: newText, start, end: start + marker.length + selected.length + marker.length };
    const cursor = start + marker.length;
    return { text: newText, start: cursor, end: cursor };
  }

  if (op === 'link') {
    const label = selected || 'text';
    const newText = before + `[${label}](url)` + after;
    const labelStart = start + 1;
    return { text: newText, start: labelStart, end: labelStart + label.length };
  }

  // list — a template inserted at the cursor, not a multi-line prefix.
  const newText = before + '- ' + selected + after;
  const cursor = start + 2;
  return { text: newText, start: cursor, end: cursor + selected.length };
}
