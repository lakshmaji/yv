import { For, Show, createEffect, createSignal } from 'solid-js';
import {
  envModalOpen, setEnvModalOpen, projectEnvs, setProjectEnvs, selectedId,
} from '../../store';
import { go } from '../../wails';
import { uid } from '../../lib/utils';
import type { Environment, EnvVar, ProjectEnvs } from '../../types';

/** Same rule the Go side enforces — kept here to fail fast in the UI. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Environment manager: create/rename/delete environments and edit their
 * variables. Secret values are masked until revealed. Nothing is persisted
 * until Save, which hands the whole set to Go (secrets never touch projects.json).
 */
export default function EnvironmentsModal() {
  const [envs, setEnvs] = createSignal<Environment[]>([]);
  const [activeId, setActiveId] = createSignal('');
  const [editingId, setEditingId] = createSignal('');
  const [revealed, setRevealed] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal('');

  // Snapshot the store when the modal opens so Cancel discards cleanly.
  createEffect(() => {
    if (!envModalOpen()) return;
    const snapshot = projectEnvs();
    const copy = snapshot.environments.map(e => ({ ...e, vars: (e.vars || []).map(v => ({ ...v })) }));
    setEnvs(copy);
    setActiveId(snapshot.activeId);
    setEditingId(copy[0]?.id || '');
    setRevealed(new Set<string>());
    setError('');
  });

  const editing = () => envs().find(e => e.id === editingId()) || null;

  function updateEnv(id: string, patch: Partial<Environment>) {
    setEnvs(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  }

  function updateVars(id: string, updater: (vars: EnvVar[]) => EnvVar[]) {
    setEnvs(prev => prev.map(e => (e.id === id ? { ...e, vars: updater(e.vars || []) } : e)));
  }

  function addEnvironment() {
    const env: Environment = { id: uid(), name: `env-${envs().length + 1}`, vars: [] };
    setEnvs([...envs(), env]);
    setEditingId(env.id);
  }

  function deleteEnvironment(id: string) {
    const remaining = envs().filter(e => e.id !== id);
    setEnvs(remaining);
    if (activeId() === id) setActiveId('');
    if (editingId() === id) setEditingId(remaining[0]?.id || '');
  }

  function addVar(id: string) {
    updateVars(id, vars => [...vars, { key: '', value: '', secret: true }]);
  }

  function toggleReveal(rowKey: string) {
    setRevealed(prev => {
      const next = new Set<string>(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }

  /** Returns an error message, or '' when the draft is valid. */
  function validate(draft: Environment[]): string {
    const names = new Set<string>();
    for (const env of draft) {
      const name = env.name.trim();
      if (!name) return 'Every environment needs a name.';
      if (names.has(name.toLowerCase())) return `Duplicate environment name "${name}".`;
      names.add(name.toLowerCase());

      const keys = new Set<string>();
      for (const v of env.vars || []) {
        const key = v.key.trim();
        if (!key) continue; // blank rows are dropped on save
        if (!KEY_RE.test(key)) return `"${key}" is not a valid variable name (use A–Z, 0–9, _).`;
        if (keys.has(key)) return `Duplicate variable "${key}" in "${name}".`;
        keys.add(key);
      }
    }
    return '';
  }

  function close() {
    setEnvModalOpen(false);
    setError('');
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  async function handleSave() {
    const projectId = selectedId();
    if (!projectId) return;

    const draft = envs();
    const problem = validate(draft);
    if (problem) { setError(problem); return; }

    const payload: ProjectEnvs = {
      environments: draft.map(e => ({
        ...e,
        name: e.name.trim(),
        vars: (e.vars || []).filter(v => v.key.trim() !== '').map(v => ({ ...v, key: v.key.trim() })),
      })),
      activeId: draft.some(e => e.id === activeId()) ? activeId() : '',
    };

    const result = await go.SaveEnvironments(projectId, payload);
    if (result !== 'ok') { setError(result); return; }

    setProjectEnvs(await go.GetEnvironments(projectId));
    close();
  }

  return (
    <Show when={envModalOpen()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box env-modal">
          <div class="modal-title">Environments</div>
          <div class="env-modal-hint">
            Variables of the active environment are injected into every command of this project.
            They are stored outside <code>projects.json</code>, so exports never include secrets.
          </div>

          <div class="env-modal-body">
            <div class="env-list">
              <For each={envs()}>
                {env => (
                  <button
                    class="env-list-item"
                    classList={{ selected: env.id === editingId() }}
                    type="button"
                    onClick={() => setEditingId(env.id)}
                  >
                    <span class="env-list-name">{env.name || 'unnamed'}</span>
                    <Show when={env.id === activeId()}>
                      <span class="env-list-active">active</span>
                    </Show>
                  </button>
                )}
              </For>
              <button class="env-list-add" type="button" onClick={addEnvironment}>+ New</button>
            </div>

            <div class="env-detail">
              <Show
                when={editing()}
                fallback={<div class="env-detail-empty">Create an environment to add variables.</div>}
              >
                {env => (
                  <>
                    <div class="modal-field-label">Name</div>
                    <div class="env-detail-name-row">
                      <input
                        placeholder="e.g. staging"
                        value={env().name}
                        onInput={e => updateEnv(env().id, { name: e.currentTarget.value })}
                      />
                      <label class="env-active-toggle" title="Use this environment when running commands">
                        <input
                          type="checkbox"
                          checked={env().id === activeId()}
                          onChange={e => setActiveId(e.currentTarget.checked ? env().id : '')}
                        />
                        Active
                      </label>
                    </div>

                    <div class="modal-field-label">Variables</div>
                    <div class="env-vars">
                      <For each={env().vars || []}>
                        {(v, i) => {
                          const rowKey = () => `${env().id}:${i()}`;
                          const isRevealed = () => !v.secret || revealed().has(rowKey());
                          return (
                            <div class="env-var-row">
                              <input
                                class="env-var-key"
                                placeholder="KEY"
                                value={v.key}
                                onInput={e => updateVars(env().id, vars =>
                                  vars.map((row, idx) => (idx === i() ? { ...row, key: e.currentTarget.value } : row)))
                                }
                              />
                              <input
                                class="env-var-value"
                                type={isRevealed() ? 'text' : 'password'}
                                placeholder="value"
                                value={v.value}
                                onInput={e => updateVars(env().id, vars =>
                                  vars.map((row, idx) => (idx === i() ? { ...row, value: e.currentTarget.value } : row)))
                                }
                              />
                              <button
                                class="env-var-btn"
                                type="button"
                                title={v.secret ? 'Stored as a secret (masked)' : 'Mark as secret'}
                                onClick={() => updateVars(env().id, vars =>
                                  vars.map((row, idx) => (idx === i() ? { ...row, secret: !row.secret } : row)))
                                }
                              >{v.secret ? '🔒' : '🔓'}</button>
                              <button
                                class="env-var-btn"
                                type="button"
                                disabled={!v.secret}
                                title={isRevealed() ? 'Hide value' : 'Reveal value'}
                                onClick={() => toggleReveal(rowKey())}
                              >{isRevealed() ? '🙈' : '👁'}</button>
                              <button
                                class="env-var-btn env-var-del"
                                type="button"
                                title="Remove variable"
                                onClick={() => updateVars(env().id, vars => vars.filter((_, idx) => idx !== i()))}
                              >✕</button>
                            </div>
                          );
                        }}
                      </For>
                      <button class="env-var-add" type="button" onClick={() => addVar(env().id)}>
                        + Add variable
                      </button>
                    </div>

                    <div class="danger-zone">
                      <button class="btn-danger" type="button" onClick={() => deleteEnvironment(env().id)}>
                        Delete "{env().name || 'unnamed'}"
                      </button>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </div>

          <Show when={error()}>
            <div class="env-modal-error">{error()}</div>
          </Show>

          <div class="modal-footer">
            <button class="btn-cancel" type="button" onClick={close}>Cancel</button>
            <button class="btn-primary" type="button" onClick={handleSave}>Save</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
