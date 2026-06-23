import {
  projects,
  setCurrentEditCmdId,
  setCurrentSettingsProjectId,
} from './state.js';
import { escHtml } from './utils.js';

export function addPreHookRow(value = '') {
  const list = document.getElementById('pre-hooks-list');
  const row = document.createElement('div');
  row.className = 'pre-hook-row';
  row.innerHTML = `
    <input class="pre-hook-input" placeholder="shell command…" value="${escHtml(value)}" />
    <button class="pre-hook-del-btn" type="button">✕</button>
  `;
  row.querySelector('.pre-hook-del-btn').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

export function addPostHookRow(command = '', timeout = '') {
  const list = document.getElementById('post-hooks-list');
  const row = document.createElement('div');
  row.className = 'post-hook-row';
  const timeoutVal = timeout ? escHtml(String(timeout)) : '';
  row.innerHTML = `
    <input class="post-hook-input" placeholder="shell command…" value="${escHtml(command)}" />
    <input class="post-hook-timeout" type="number" placeholder="120" value="${timeoutVal}" min="1" max="3600" title="Timeout in seconds (default: 120)" />
    <span class="post-hook-timeout-label">s</span>
    <button class="pre-hook-del-btn" type="button">✕</button>
  `;
  row.querySelector('.pre-hook-del-btn').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

export function openEditModal(cmd) {
  setCurrentEditCmdId(cmd.id);
  document.getElementById('edit-label').value   = cmd.label || '';
  document.getElementById('edit-group').value   = cmd.group || '';
  document.getElementById('edit-command').value = cmd.command || '';
  document.getElementById('edit-dir').value     = cmd.workingDir || '';

  const list = document.getElementById('pre-hooks-list');
  list.innerHTML = '';
  for (const pre of (cmd.preCommands || [])) {
    addPreHookRow(pre);
  }

  const postList = document.getElementById('post-hooks-list');
  postList.innerHTML = '';
  for (const post of (cmd.postCommands || [])) {
    addPostHookRow(post.command, post.timeout || '');
  }

  document.getElementById('edit-cmd-modal').style.display = 'flex';
  document.getElementById('edit-label').focus();
}

export function closeEditModal() {
  document.getElementById('edit-cmd-modal').style.display = 'none';
  setCurrentEditCmdId(null);
}

export function openProjectSettings(projectId) {
  const p = projects.find(x => x.id === projectId);
  if (!p) return;
  setCurrentSettingsProjectId(projectId);
  document.getElementById('ps-name').value = p.name || '';
  document.getElementById('ps-dir').value  = p.workingDir || '';
  document.getElementById('project-settings-modal').style.display = 'flex';
  document.getElementById('ps-name').focus();
}

export function closeProjectSettings() {
  document.getElementById('project-settings-modal').style.display = 'none';
  setCurrentSettingsProjectId(null);
}
