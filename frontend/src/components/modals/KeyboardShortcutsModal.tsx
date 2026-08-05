import { Show, For, createSignal, createMemo } from 'solid-js';
import { shortcutsModalOpen, setShortcutsModalOpen } from '../../store';

// A single physical key on the rendered keyboard. `code` is the identifier a
// shortcut references to light the key up; keys with no code are decorative.
type Key = { code?: string; label: string; w?: number };

// A keyboard shortcut: its human label, the pretty combo chips shown on the
// right, and the set of key `code`s it lights up on the keyboard when hovered.
type Shortcut = { label: string; combo: string[]; keys: string[] };

const KB_ROWS: Key[][] = [
  [
    { code: 'esc', label: 'esc', w: 1.4 },
    { label: 'F1' }, { label: 'F2' }, { label: 'F3' }, { label: 'F4' },
    { label: 'F5' }, { label: 'F6' }, { label: 'F7' }, { label: 'F8' },
    { label: 'F9' }, { label: 'F10' }, { label: 'F11' }, { label: 'F12' },
  ],
  [
    { code: '`', label: '`' }, { code: '1', label: '1' }, { code: '2', label: '2' },
    { code: '3', label: '3' }, { code: '4', label: '4' }, { code: '5', label: '5' },
    { code: '6', label: '6' }, { code: '7', label: '7' }, { code: '8', label: '8' },
    { code: '9', label: '9' }, { code: '0', label: '0' }, { code: '-', label: '-' },
    { code: '=', label: '=' }, { code: 'delete', label: 'delete', w: 1.6 },
  ],
  [
    { code: 'tab', label: 'tab', w: 1.4 },
    { code: 'q', label: 'Q' }, { code: 'w', label: 'W' }, { code: 'e', label: 'E' },
    { code: 'r', label: 'R' }, { code: 't', label: 'T' }, { code: 'y', label: 'Y' },
    { code: 'u', label: 'U' }, { code: 'i', label: 'I' }, { code: 'o', label: 'O' },
    { code: 'p', label: 'P' }, { code: '[', label: '[' }, { code: ']', label: ']' },
    { code: '\\', label: '\\', w: 1.1 },
  ],
  [
    { code: 'caps', label: 'caps', w: 1.7 },
    { code: 'a', label: 'A' }, { code: 's', label: 'S' }, { code: 'd', label: 'D' },
    { code: 'f', label: 'F' }, { code: 'g', label: 'G' }, { code: 'h', label: 'H' },
    { code: 'j', label: 'J' }, { code: 'k', label: 'K' }, { code: 'l', label: 'L' },
    { code: ';', label: ';' }, { code: '\'', label: '\'' },
    { code: 'return', label: 'return', w: 1.9 },
  ],
  [
    { code: 'shift', label: 'shift', w: 2.2 },
    { code: 'z', label: 'Z' }, { code: 'x', label: 'X' }, { code: 'c', label: 'C' },
    { code: 'v', label: 'V' }, { code: 'b', label: 'B' }, { code: 'n', label: 'N' },
    { code: 'm', label: 'M' }, { code: ',', label: ',' }, { code: '.', label: '.' },
    { code: '/', label: '/' }, { code: 'shift', label: 'shift', w: 2.2 },
  ],
  [
    { code: 'fn', label: 'fn' },
    { code: 'ctrl', label: 'control', w: 1.4 },
    { code: 'opt', label: 'option', w: 1.3 },
    { code: 'cmd', label: 'command', w: 1.6 },
    { code: 'space', label: '', w: 6 },
    { code: 'cmd', label: 'command', w: 1.6 },
    { code: 'opt', label: 'option', w: 1.3 },
    { code: 'left', label: '←' }, { code: 'up', label: '↑' },
    { code: 'down', label: '↓' }, { code: 'right', label: '→' },
  ],
];

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'General',
    items: [
      { label: 'Open Spotlight Search', combo: ['⌘', 'K'], keys: ['cmd', 'k'] },
      { label: 'Stop All Commands', combo: ['⌘', '.'], keys: ['cmd', '.'] },
      { label: 'Keyboard Shortcuts', combo: ['⌘', '/'], keys: ['cmd', '/'] },
      { label: 'Close / Cancel', combo: ['esc'], keys: ['esc'] },
    ],
  },
  {
    title: 'Interactive Command',
    items: [
      { label: 'Send Input', combo: ['↵'], keys: ['return'] },
      { label: 'Interrupt', combo: ['⌃', 'C'], keys: ['ctrl', 'c'] },
      { label: 'Send EOF', combo: ['⌃', 'D'], keys: ['ctrl', 'd'] },
    ],
  },
  {
    title: 'Spotlight',
    items: [
      { label: 'Move Selection', combo: ['↑', '↓'], keys: ['up', 'down'] },
      { label: 'Reveal Command', combo: ['↵'], keys: ['return'] },
      { label: 'Reveal & Run', combo: ['⌘', '↵'], keys: ['cmd', 'return'] },
      { label: 'Close', combo: ['esc'], keys: ['esc'] },
    ],
  },
];

// Every key that participates in any shortcut — these carry the resting
// highlight so the "live" keys stand out even before hovering a row.
const ACTIVE = new Set<string>(GROUPS.flatMap(g => g.items).flatMap(s => s.keys));

export default function KeyboardShortcutsModal() {
  // Keys lit with the strong glow — driven by the currently hovered shortcut.
  const [hot, setHot] = createSignal<Set<string>>(new Set());
  const hotKeys = createMemo(() => hot());

  function close() {
    setShortcutsModalOpen(false);
    setHot(new Set<string>());
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  return (
    <Show when={shortcutsModalOpen()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box kb-modal">
          <div class="kb-header">
            <div class="modal-title">Keyboard Shortcuts</div>
            <button class="kb-close" onClick={close} title="Close">✕</button>
          </div>

          <div class="kb-keyboard">
            <For each={KB_ROWS}>
              {(row) => (
                <div class="kb-row">
                  <For each={row}>
                    {(key) => (
                      <div
                        class="kb-key"
                        classList={{
                          active: !!key.code && ACTIVE.has(key.code),
                          hot: !!key.code && hotKeys().has(key.code),
                          'kb-space': key.code === 'space',
                        }}
                        style={{ 'flex-grow': String(key.w ?? 1) }}
                      >
                        {key.label}
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>

          <div class="kb-groups">
            <For each={GROUPS}>
              {(group) => (
                <div class="kb-group">
                  <div class="kb-group-title">{group.title}</div>
                  <For each={group.items}>
                    {(item) => (
                      <div
                        class="kb-shortcut"
                        onMouseEnter={() => setHot(new Set(item.keys))}
                        onMouseLeave={() => setHot(new Set<string>())}
                      >
                        <span class="kb-shortcut-label">{item.label}</span>
                        <span class="kb-combo">
                          <For each={item.combo}>
                            {(chip) => <kbd>{chip}</kbd>}
                          </For>
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>

          <div class="modal-footer">
            <button class="btn-primary" onClick={close}>Close</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
