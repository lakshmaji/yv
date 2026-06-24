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
