import { go, projects, currentEditShortcutId, setCurrentEditShortcutId } from './state.js';
import { escHtml, uid, selectedProject } from './utils.js';
import { runShortcut, setShortcutRunning, setShortcutStep } from './commands.js';
// renderMain is imported lazily via a live binding to break the render ↔ shortcuts cycle.
// It is only ever called inside async function bodies (never at module init time), so the
// binding is fully resolved by the time any of these functions execute.
import { renderMain } from './render.js';

export function renderShortcuts(proj) {
  const list = document.getElementById('shortcuts-list');
  if (!list) return;
  list.innerHTML = '';
  if (!proj || !proj.shortcuts) return;
  for (const sc of proj.shortcuts) {
    list.appendChild(buildShortcutCard(sc, proj));
  }
}

export function buildShortcutCard(sc, proj) {
  const card = document.createElement('div');
  card.className = 'shortcut-card';
  card.id = 'shortcut-' + sc.id;

  const steps = sc.commandIds.map((cid, idx) => {
    const cmd = proj.commands.find(c => c.id === cid);
    const label = cmd ? escHtml(cmd.label) : '<em class="sc-missing">deleted</em>';
    return `<span class="sc-step" data-index="${idx}">${label}</span>`;
  }).join('<span class="sc-arrow">→</span>');

  card.innerHTML = `
    <div class="shortcut-row">
      <span class="sc-name">${escHtml(sc.name)}</span>
      <div class="sc-steps">${steps}</div>
      <div class="sc-actions">
        <button class="sc-edit-btn" title="Edit shortcut">✎</button>
        <button class="sc-delete-btn" title="Delete shortcut">✕</button>
        <button class="sc-run-btn">▶ Run</button>
      </div>
    </div>
  `;

  card.querySelector('.sc-run-btn').addEventListener('click', e => {
    e.stopPropagation();
    runShortcut(sc);
  });
  card.querySelector('.sc-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    openShortcutModal(sc);
  });
  card.querySelector('.sc-delete-btn').addEventListener('click', async e => {
    e.stopPropagation();
    await deleteShortcut(sc.id);
  });

  return card;
}

export function openShortcutModal(sc) {
  const proj = selectedProject();
  if (!proj) return;
  setCurrentEditShortcutId(sc ? sc.id : null);
  document.getElementById('sc-modal-title').textContent = sc ? 'Edit Shortcut' : 'New Shortcut';
  document.getElementById('sc-name-input').value = sc ? sc.name : '';
  const container = document.getElementById('sc-cmd-checkboxes');
  container.innerHTML = '';

  // When editing, render in saved order first, then append unchecked ones
  const orderedCmds = sc
    ? [
        ...sc.commandIds.map(id => proj.commands.find(c => c.id === id)).filter(Boolean),
        ...proj.commands.filter(c => !sc.commandIds.includes(c.id)),
      ]
    : proj.commands;

  for (const cmd of orderedCmds) {
    const checked = sc && sc.commandIds.includes(cmd.id) ? 'checked' : '';
    const cbId = 'sc-cb-' + cmd.id;
    const row = document.createElement('div');
    row.className = 'sc-cmd-checkbox-row';
    row.innerHTML = `
      <span class="sc-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <label class="sc-cmd-cb-label-wrap" for="${cbId}">
        <input type="checkbox" class="sc-cmd-cb" id="${cbId}" value="${escHtml(cmd.id)}" ${checked}>
        <span class="sc-cmd-cb-label">${escHtml(cmd.label)}</span>
      </label>
      <span class="sc-cmd-cb-snippet">${escHtml(cmd.command)}</span>
    `;
    container.appendChild(row);
  }

  initShortcutDrag(container);
  document.getElementById('sc-modal').style.display = 'flex';
  const nameInput = document.getElementById('sc-name-input');
  nameInput.classList.remove('input-error');
  nameInput.addEventListener('input', () => nameInput.classList.remove('input-error'));
  nameInput.focus();
}

export function initShortcutDrag(container) {
  let dragging = null;

  container.addEventListener('dragstart', e => {
    const handle = e.target.closest('.sc-drag-handle');
    if (!handle) { e.preventDefault(); return; }
    dragging = handle.closest('.sc-cmd-checkbox-row');
    if (!dragging) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(dragging, 20, dragging.offsetHeight / 2);
    setTimeout(() => dragging.classList.add('sc-dragging'), 0);
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragging) return;
    const target = e.target.closest('.sc-cmd-checkbox-row');
    if (!target || target === dragging) return;
    const rect = target.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      container.insertBefore(dragging, target);
    } else {
      container.insertBefore(dragging, target.nextSibling);
    }
  });

  container.addEventListener('dragend', () => {
    if (dragging) dragging.classList.remove('sc-dragging');
    dragging = null;
  });
}

export function closeShortcutModal() {
  document.getElementById('sc-modal').style.display = 'none';
  setCurrentEditShortcutId(null);
}

export async function saveShortcut() {
  const proj = selectedProject();
  if (!proj) return;
  const nameInput = document.getElementById('sc-name-input');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.classList.add('input-error');
    nameInput.focus();
    return;
  }
  nameInput.classList.remove('input-error');
  // Read in current DOM order so drag-reordering is respected
  const commandIds = Array.from(
    document.querySelectorAll('#sc-cmd-checkboxes .sc-cmd-checkbox-row')
  ).filter(row => row.querySelector('.sc-cmd-cb')?.checked)
   .map(row => row.querySelector('.sc-cmd-cb').value);
  if (commandIds.length === 0) { alert('Select at least one command.'); return; }
  if (!proj.shortcuts) proj.shortcuts = [];
  if (currentEditShortcutId) {
    const sc = proj.shortcuts.find(s => s.id === currentEditShortcutId);
    if (sc) { sc.name = name; sc.commandIds = commandIds; }
  } else {
    proj.shortcuts.push({ id: uid(), name, commandIds });
  }
  const result = await go.SaveProjects(projects);
  if (result !== 'ok') { alert('Save failed: ' + result); return; }
  closeShortcutModal();
  renderMain();
}

export async function deleteShortcut(id) {
  const proj = selectedProject();
  if (!proj || !proj.shortcuts) return;
  proj.shortcuts = proj.shortcuts.filter(s => s.id !== id);
  const result = await go.SaveProjects(projects);
  if (result !== 'ok') { alert('Save failed: ' + result); return; }
  renderMain();
}
