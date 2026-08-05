import { For, Show, createSignal, onCleanup } from 'solid-js';
import {
  projectEnvs, setProjectEnvs, setEnvModalOpen,
  activeEnv, activeEnvVarCount, selectedId,
} from '../store';
import { go } from '../wails';
import { envChipStyle } from '../lib/envColors';

/**
 * Top-right environment switcher. Picking an environment persists the choice
 * immediately; its variables are injected by Go on the next command run.
 */
export default function EnvSelector() {
  const [open, setOpen] = createSignal(false);

  function handleDocClick(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest('#env-selector')) setOpen(false);
  }
  document.addEventListener('click', handleDocClick);
  onCleanup(() => document.removeEventListener('click', handleDocClick));

  async function activate(envId: string) {
    const projectId = selectedId();
    if (!projectId) return;
    const next = { ...projectEnvs(), activeId: envId };
    setProjectEnvs(next);
    setOpen(false);
    const result = await go.SaveEnvironments(projectId, next);
    if (result !== 'ok') alert('Save failed: ' + result);
  }

  const label = () => activeEnv()?.name ?? 'No environment';

  return (
    <div id="env-selector">
      <button
        class="env-trigger"
        classList={{ 'env-active': !!activeEnv(), 'env-tinted': !!activeEnv()?.bgColor }}
        type="button"
        title="Active environment"
        style={envChipStyle(activeEnv())}
        onClick={() => setOpen(!open())}
      >
        <span class="env-dot" />
        <span class="env-name">{label()}</span>
        <Show when={activeEnvVarCount() > 0}>
          <span class="env-var-count">{activeEnvVarCount()}</span>
        </Show>
        <span class="env-caret">▾</span>
      </button>

      <Show when={open()}>
        <div class="env-menu">
          <div class="env-menu-label">Environment</div>
          <button
            class="env-menu-item"
            classList={{ selected: !activeEnv() }}
            type="button"
            onClick={() => activate('')}
          >
            None
          </button>
          <For each={projectEnvs().environments}>
            {env => (
              <button
                class="env-menu-item"
                classList={{ selected: env.id === projectEnvs().activeId }}
                type="button"
                onClick={() => activate(env.id)}
              >
                <span class="env-menu-swatch" style={envChipStyle(env)} />
                <span class="env-menu-name">{env.name}</span>
                <span class="env-menu-count">{env.vars?.length || 0} vars</span>
              </button>
            )}
          </For>
          <Show when={projectEnvs().environments.length === 0}>
            <div class="env-menu-empty">No environments yet</div>
          </Show>
          <button
            class="env-menu-manage"
            type="button"
            onClick={() => { setOpen(false); setEnvModalOpen(true); }}
          >
            ⚙ Manage environments…
          </button>
        </div>
      </Show>
    </div>
  );
}
