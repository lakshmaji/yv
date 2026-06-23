import { projects, selectedId } from './state.js';

export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function lineHtml(line) {
  const e = escHtml(line);
  if (/^\[PRE\] /.test(line)) {
    return `<span class="line-pre">${e}</span>\n`;
  }
  if (/^\[POST\] /.test(line)) {
    return `<span class="line-post">${e}</span>\n`;
  }
  if (/\b(error|Error|ERROR|exception|Exception|EXCEPTION|fatal|Fatal|FATAL|failed|Failed|FAILED|ENOENT|EACCES|ECONNREFUSED)\b/.test(line)) {
    return `<span class="line-error">${e}</span>\n`;
  }
  if (/\b(warning|Warning|WARNING|warn|Warn|WARN|deprecated|Deprecated)\b/.test(line)) {
    return `<span class="line-warn">${e}</span>\n`;
  }
  if (/^\s+at /.test(line)) {
    return `<span class="line-stack">${e}</span>\n`;
  }
  return e + '\n';
}

export function uid() {
  return crypto.randomUUID();
}

export function selectedProject() {
  return projects.find(p => p.id === selectedId) || null;
}
