export function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function lineClass(line: string): string {
  if (/^\[PRE\] /.test(line)) return 'term-line line-pre';
  if (/^\[POST\] /.test(line)) return 'term-line line-post';
  if (/\b(error|Error|ERROR|exception|Exception|EXCEPTION|fatal|Fatal|FATAL|failed|Failed|FAILED|ENOENT|EACCES|ECONNREFUSED)\b/.test(line)) return 'term-line line-error';
  if (/\b(warning|Warning|WARNING|warn|Warn|WARN|deprecated|Deprecated)\b/.test(line)) return 'term-line line-warn';
  if (/^\s+at /.test(line)) return 'term-line line-stack';
  return 'term-line';
}

export function uid(): string {
  return crypto.randomUUID();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/**
 * Shortens a filesystem path to its last `keep` segments.
 *
 * A row has room for roughly one line of path, and the useful end of a path is
 * the *last* part — the repository folder is what identifies it, the home
 * directory prefix is the same on every row.
 *
 * The obvious CSS answer, `direction: rtl` with an ellipsis, is wrong for a
 * path: the leading "/" is a bidi-neutral character, so it gets reordered to
 * the far end and "/Users/me/code" renders as "Users/me/code/". Shortening the
 * string avoids the reordering entirely.
 */
export function shortenPath(path: string, keep = 3): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= keep) return path;
  return '…/' + parts.slice(-keep).join('/');
}
