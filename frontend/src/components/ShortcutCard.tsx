import { For, createMemo } from 'solid-js';
import { getShortcutState, setEditingShortcut } from '../store';
import { runShortcut } from '../lib/commands';
import { escHtml } from '../lib/utils';
import type { Shortcut, Project } from '../types';

interface ShortcutCardProps {
  shortcut: Shortcut;
  project: Project;
  onDelete: (id: string) => void;
}

export default function ShortcutCard(props: ShortcutCardProps) {
  const state = () => getShortcutState(props.shortcut.id);

  const cardClass = createMemo(() => {
    const s = state();
    let cls = 'shortcut-card';
    if (s.running) cls += ' sc-running';
    else if (s.finalState) cls += ' sc-' + s.finalState;
    return cls;
  });

  function handleRun(e: MouseEvent) {
    e.stopPropagation();
    runShortcut(props.shortcut);
  }

  function handleEdit(e: MouseEvent) {
    e.stopPropagation();
    setEditingShortcut(props.shortcut.id);
  }

  function handleDelete(e: MouseEvent) {
    e.stopPropagation();
    props.onDelete(props.shortcut.id);
  }

  return (
    <div class={cardClass()} id={`shortcut-${props.shortcut.id}`}>
      <div class="shortcut-row">
        <span class="sc-name">{props.shortcut.name}</span>
        <div class="sc-steps">
          <For each={props.shortcut.commandIds}>
            {(cid, idx) => {
              const cmd = () => props.project.commands.find(c => c.id === cid);
              const stepState = () => state().steps[idx()];
              const stepClass = () => {
                const ss = stepState();
                return ss ? `sc-step sc-step-${ss}` : 'sc-step';
              };
              return (
                <>
                  {idx() > 0 && <span class="sc-arrow">→</span>}
                  <span class={stepClass()} data-index={idx()}>
                    {cmd() ? cmd()!.label : <em class="sc-missing">deleted</em>}
                  </span>
                </>
              );
            }}
          </For>
        </div>
        <div class="sc-actions">
          <button class="sc-edit-btn" title="Edit shortcut" onClick={handleEdit}>✎</button>
          <button class="sc-delete-btn" title="Delete shortcut" onClick={handleDelete}>✕</button>
          <button
            class="sc-run-btn"
            disabled={state().running}
            onClick={handleRun}
          >
            ▶ Run
          </button>
        </div>
      </div>
    </div>
  );
}
