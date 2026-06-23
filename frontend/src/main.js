import {
  go, projects, setProjects,
  sidebarWidth, setSidebarWidth,
  groupsWidth, setGroupsWidth,
  currentEditCmdId, currentSettingsProjectId,
} from './state.js';
import { uid, selectedProject } from './utils.js';
import { renderSidebar, renderGroups, renderMain, selectProject, addGroup } from './render.js';
import { updateRunningCount } from './terminal.js';
import { toggleSidebar, initResize } from './resize.js';
import { closeEditModal, addPreHookRow, addPostHookRow, closeProjectSettings } from './modals.js';
import { closeShortcutModal, saveShortcut } from './shortcuts.js';

// ── New project form ────────────────────────────────────────────────────────

document.getElementById('add-project-btn').addEventListener('click', () => {
  const form = document.getElementById('new-project-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    document.getElementById('np-name').focus();
  }
});

document.getElementById('np-cancel').addEventListener('click', () => {
  document.getElementById('new-project-form').classList.remove('visible');
  document.getElementById('np-name').value = '';
  document.getElementById('np-dir').value = '';
});

document.getElementById('np-pick').addEventListener('click', async () => {
  const path = await go.PickFolder();
  if (path) document.getElementById('np-dir').value = path;
});

document.getElementById('np-save').addEventListener('click', async () => {
  const name = document.getElementById('np-name').value.trim();
  const dir  = document.getElementById('np-dir').value.trim();
  if (!name || !dir) return;

  const proj = { id: uid(), name, workingDir: dir, commands: [] };
  projects.push(proj);

  const result = await go.SaveProjects(projects);
  if (result !== 'ok') {
    alert('Save failed: ' + result);
    projects.pop();
    return;
  }

  document.getElementById('new-project-form').classList.remove('visible');
  document.getElementById('np-name').value = '';
  document.getElementById('np-dir').value = '';

  selectProject(proj.id);
});

// ── Add group form ──────────────────────────────────────────────────────────

document.getElementById('add-group-btn').addEventListener('click', () => {
  const form = document.getElementById('add-group-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    document.getElementById('ag-name').focus();
  }
});

document.getElementById('ag-cancel').addEventListener('click', () => {
  document.getElementById('add-group-form').classList.remove('visible');
  document.getElementById('ag-name').value = '';
});

document.getElementById('ag-save').addEventListener('click', async () => {
  const name = document.getElementById('ag-name').value.trim();
  if (!name) return;
  await addGroup(name);
  document.getElementById('add-group-form').classList.remove('visible');
  document.getElementById('ag-name').value = '';
});

document.getElementById('ag-name').addEventListener('keydown', async e => {
  if (e.key === 'Enter') {
    const name = e.target.value.trim();
    if (!name) return;
    await addGroup(name);
    document.getElementById('add-group-form').classList.remove('visible');
    e.target.value = '';
  } else if (e.key === 'Escape') {
    document.getElementById('add-group-form').classList.remove('visible');
    e.target.value = '';
  }
});

// ── Export / Import ─────────────────────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', async () => {
  try {
    const path = await go.ExportProjects()
    if (path) alert(`Exported to ${path}`)
  } catch (err) {
    alert('Export failed: ' + err)
  }
})

document.getElementById('btn-import').addEventListener('click', async () => {
  try {
    const msg = await go.ImportProjects()
    if (!msg) return // cancelled
    setProjects(await go.LoadProjects())
    renderSidebar()
    renderGroups()
    renderMain()
    alert(msg)
  } catch (err) {
    alert('Import failed: ' + err)
  }
})

document.getElementById('btn-import-project').addEventListener('click', async () => {
  try {
    const msg = await go.ImportProject()
    if (!msg) return // cancelled
    setProjects(await go.LoadProjects())
    renderSidebar()
    renderGroups()
    renderMain()
    alert(msg)
  } catch (err) {
    alert('Import failed: ' + err)
  }
})

// ── Bootstrap ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Edit modal wiring
  document.getElementById('edit-cancel-btn').addEventListener('click', closeEditModal);

  document.getElementById('edit-cmd-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-cmd-modal')) closeEditModal();
  });

  document.getElementById('edit-dir-pick').addEventListener('click', async () => {
    const path = await go.PickFolder();
    if (path) document.getElementById('edit-dir').value = path;
  });

  document.getElementById('add-pre-hook-btn').addEventListener('click', () => addPreHookRow());
  document.getElementById('add-post-hook-btn').addEventListener('click', () => addPostHookRow());

  document.getElementById('edit-save-btn').addEventListener('click', async () => {
    if (!currentEditCmdId) return;
    const proj = selectedProject();
    if (!proj) return;
    const cmd = proj.commands.find(c => c.id === currentEditCmdId);
    if (!cmd) return;

    const label      = document.getElementById('edit-label').value.trim();
    const group      = document.getElementById('edit-group').value.trim();
    const command    = document.getElementById('edit-command').value.trim();
    const workingDir = document.getElementById('edit-dir').value.trim();
    if (!label || !command) return;

    const preCommands = Array.from(
      document.querySelectorAll('#pre-hooks-list .pre-hook-input')
    ).map(i => i.value.trim()).filter(Boolean);

    const postCommands = Array.from(
      document.querySelectorAll('#post-hooks-list .post-hook-row')
    ).map(row => {
      const command = row.querySelector('.post-hook-input').value.trim();
      const t = row.querySelector('.post-hook-timeout').value.trim();
      const timeout = t ? parseInt(t, 10) : 0;
      return command ? { command, timeout: timeout > 0 ? timeout : 0 } : null;
    }).filter(Boolean);

    cmd.label        = label;
    cmd.group        = group;
    cmd.command      = command;
    cmd.workingDir   = workingDir;
    cmd.preCommands  = preCommands;
    cmd.postCommands = postCommands;

    const result = await go.SaveProjects(projects);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      return;
    }

    closeEditModal();
    renderGroups();
    renderMain();
  });

  document.getElementById('sc-cancel-btn').addEventListener('click', closeShortcutModal);
  document.getElementById('sc-save-btn').addEventListener('click', saveShortcut);
  document.getElementById('sc-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('sc-modal')) closeShortcutModal();
  });

  // Project settings modal
  document.getElementById('ps-cancel-btn').addEventListener('click', closeProjectSettings);
  document.getElementById('project-settings-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('project-settings-modal')) closeProjectSettings();
  });
  document.getElementById('ps-dir-pick').addEventListener('click', async () => {
    const picked = await go.PickFolder();
    if (picked) document.getElementById('ps-dir').value = picked;
  });
  document.getElementById('ps-save-btn').addEventListener('click', async () => {
    if (!currentSettingsProjectId) return;
    const name = document.getElementById('ps-name').value.trim();
    const dir  = document.getElementById('ps-dir').value.trim();
    if (!name) return;
    const result = await go.UpdateProject(currentSettingsProjectId, name, dir);
    if (result !== 'ok') { alert('Save failed: ' + result); return; }
    setProjects(await go.LoadProjects());
    closeProjectSettings();
    renderSidebar();
    renderGroups();
    renderMain();
  });
  document.getElementById('ps-export-json').addEventListener('click', async () => {
    if (!currentSettingsProjectId) return;
    try {
      const path = await go.ExportProject(currentSettingsProjectId, 'json');
      if (path) alert('Exported to ' + path);
    } catch (err) { alert('Export failed: ' + err); }
  });
  document.getElementById('ps-export-yaml').addEventListener('click', async () => {
    if (!currentSettingsProjectId) return;
    try {
      const path = await go.ExportProject(currentSettingsProjectId, 'yaml');
      if (path) alert('Exported to ' + path);
    } catch (err) { alert('Export failed: ' + err); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeEditModal(); closeShortcutModal(); closeProjectSettings(); }
  });

  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);

  initResize('rh-sidebar',
    () => sidebarWidth,
    setSidebarWidth
  );
  initResize('rh-groups',
    () => groupsWidth,
    setGroupsWidth
  );

  try {
    setProjects(await go.LoadProjects());
  } catch (e) {
    setProjects([]);
  }
  renderSidebar();
  renderGroups();
  if (projects.length > 0) {
    selectProject(projects[0].id);
  }
  updateRunningCount();
});
