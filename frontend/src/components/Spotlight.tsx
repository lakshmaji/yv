import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  projects, spotlightOpen, setSpotlightOpen,
  searchQuery, setSearchQuery,
  setSelectedId, setSelectedGroup, setHighlightedCmd,
} from '../store';
import { searchAllProjects, hasHooks } from '../lib/search';
import { runCommand } from '../lib/commands';
import type { CommandConfig } from '../types';

/**
 * macOS Spotlight-style global command palette. Searches every command of every
 * project — label, shell text, group, project name, and pre/post hook commands —
 * over a blurred backdrop.
 *
 * ↑ / ↓ move · ↵ reveal the command · ⌘↵ reveal and run · Esc close
 */
export default function Spotlight() {
  const [cursor, setCursor] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;

  const results = createMemo(() => searchAllProjects(projects, searchQuery()));

  // Any new query starts from the top result.
  createEffect(() => {
    searchQuery();
    setCursor(0);
  });

  onMount(() => inputRef?.focus());

  // Keep the highlighted row scrolled into view while arrowing through results.
  createEffect(() => {
    const index = cursor();
    const row = listRef?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  });

  function close() {
    setSpotlightOpen(false);
    setSearchQuery('');
  }

  /** Navigates to a command so its row is visible in the main panel. */
  function reveal(projectId: string, cmd: CommandConfig) {
    setSelectedId(projectId);
    setSelectedGroup(cmd.group || 'All');
    setHighlightedCmd(cmd.id);
    close();
  }

  function activate(index: number, run: boolean) {
    const hit = results()[index];
    if (!hit) return;
    reveal(hit.projectId, hit.cmd);
    if (run) runCommand(hit.cmd);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const count = results().length;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (count) setCursor((cursor() + 1) % count);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (count) setCursor((cursor() - 1 + count) % count);
        return;
      case 'Enter':
        e.preventDefault();
        activate(cursor(), e.metaKey || e.ctrlKey);
        return;
    }
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  // Escape must work even when focus has left the input (e.g. after a click).
  function handleWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && spotlightOpen()) close();
  }
  window.addEventListener('keydown', handleWindowKey);
  onCleanup(() => window.removeEventListener('keydown', handleWindowKey));

  return (
    <div id="spotlight-overlay" onClick={handleOverlayClick}>
      <div id="spotlight-panel">
        <div class="spotlight-search">
          <span class="spotlight-icon">⌕</span>
          <input
            ref={inputRef}
            id="spotlight-input"
            type="text"
            placeholder="Search commands, groups, hooks — all projects"
            autocomplete="off"
            spellcheck={false}
            value={searchQuery()}
            onInput={e => setSearchQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <Show when={searchQuery()}>
            <span class="spotlight-count">{results().length}</span>
          </Show>
        </div>

        <Show when={searchQuery().trim()}>
          <div class="spotlight-results" ref={listRef}>
            <For each={results()}>
              {(hit, i) => (
                <div
                  class="spotlight-row"
                  classList={{ selected: i() === cursor() }}
                  data-index={i()}
                  onMouseEnter={() => setCursor(i())}
                  onClick={e => activate(i(), e.metaKey || e.ctrlKey)}
                >
                  <div class="spotlight-row-main">
                    <span class="spotlight-row-label">{hit.cmd.label}</span>
                    <span class="spotlight-row-cmd">{hit.cmd.command}</span>
                  </div>
                  <div class="spotlight-row-meta">
                    {/* Hooks are searched too, so flag rows that have them. */}
                    <Show when={hasHooks(hit.cmd)}>
                      <span class="spotlight-row-group">hooks</span>
                    </Show>
                    <span class="spotlight-row-project">{hit.projectName}</span>
                    <Show when={hit.cmd.group}>
                      <span class="spotlight-row-group">{hit.cmd.group}</span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
            <Show when={results().length === 0}>
              <div class="spotlight-empty">No commands match “{searchQuery()}”</div>
            </Show>
          </div>
        </Show>

        <div class="spotlight-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> reveal</span>
          <span><kbd>⌘</kbd><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
