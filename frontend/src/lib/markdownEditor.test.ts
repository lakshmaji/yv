import { describe, it, expect } from 'vitest';
import { applyMarkdownOp } from './markdownEditor';

describe('applyMarkdownOp', () => {
  const cases: Array<{
    name: string;
    text: string;
    start: number;
    end: number;
    op: Parameters<typeof applyMarkdownOp>[3];
    want: ReturnType<typeof applyMarkdownOp>;
  }> = [
    {
      name: 'bold wraps a selection',
      text: 'hello world',
      start: 6, end: 11, op: 'bold',
      want: { text: 'hello **world**', start: 6, end: 15 },
    },
    {
      name: 'bold with no selection inserts markers and places the cursor between them',
      text: 'hello ',
      start: 6, end: 6, op: 'bold',
      want: { text: 'hello ****', start: 8, end: 8 },
    },
    {
      name: 'italic wraps a selection',
      text: 'hello world',
      start: 0, end: 5, op: 'italic',
      want: { text: '_hello_ world', start: 0, end: 7 },
    },
    {
      name: 'code wraps a selection',
      text: 'run make',
      start: 4, end: 8, op: 'code',
      want: { text: 'run `make`', start: 4, end: 10 },
    },
    {
      name: 'link with a selection uses it as the label',
      text: 'see docs',
      start: 4, end: 8, op: 'link',
      want: { text: 'see [docs](url)', start: 5, end: 9 },
    },
    {
      name: 'link with no selection inserts a placeholder label',
      text: '',
      start: 0, end: 0, op: 'link',
      want: { text: '[text](url)', start: 1, end: 5 },
    },
    {
      name: 'list inserts a template at the cursor',
      text: 'notes:\n',
      start: 7, end: 7, op: 'list',
      want: { text: 'notes:\n- ', start: 9, end: 9 },
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      expect(applyMarkdownOp(tc.text, tc.start, tc.end, tc.op)).toEqual(tc.want);
    });
  }
});
