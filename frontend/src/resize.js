import {
  sidebarCollapsed, setSidebarCollapsed,
  sidebarWidth, groupsWidth,
} from './state.js';

export function applyColumnWidths() {
  const sw = sidebarCollapsed ? 48 : sidebarWidth;
  document.body.style.gridTemplateColumns = `${sw}px ${groupsWidth}px 1fr`;
}

export function toggleSidebar() {
  setSidebarCollapsed(!sidebarCollapsed);
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebar-toggle-btn');
  sidebar.classList.toggle('collapsed', sidebarCollapsed);
  btn.textContent = sidebarCollapsed ? '›' : '‹';
  btn.title = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  applyColumnWidths();
}

export function initResize(handleId, getWidth, setWidth) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getWidth();
    handle.classList.add('dragging');
    const onMove = e => {
      setWidth(Math.max(80, startW + (e.clientX - startX)));
      applyColumnWidths();
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
