// Notifications inbox — bell icon on the home view opens a full-screen
// list of recent activity (sends, receives, stakes, earns).
//
// Storage: localStorage key `vault.inbox.v1` = array of
//   { id, type, title, subtitle, ts, read }
// Capped at 100 entries; oldest are dropped on overflow.
const Inbox = (() => {
  const STORE_KEY = 'vault.inbox.v1';
  const MAX_ENTRIES = 100;
  const $ = id => document.getElementById(id);

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function save(arr) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr.slice(0, MAX_ENTRIES))); } catch {}
  }

  function add({ type, title, subtitle, ts }) {
    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      type, title, subtitle,
      ts: ts || Date.now(),
      read: false,
    };
    const arr = load();
    arr.unshift(item);
    save(arr);
    updateBell();
  }

  function unreadCount() { return load().filter(x => !x.read).length; }

  function markAllRead() {
    const arr = load().map(x => ({ ...x, read: true }));
    save(arr);
    updateBell();
  }

  function clearAll() {
    save([]);
    render();
    updateBell();
  }

  function updateBell() {
    const dot = $('inbox-dot');
    if (!dot) return;
    dot.style.display = unreadCount() > 0 ? '' : 'none';
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function render() {
    const list = $('inbox-list');
    if (!list) return;
    const items = load();
    if (!items.length) {
      list.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--text2);font-size:14px">
        No activity yet.<br><span style="font-size:12px;color:var(--text3)">Sends, receives, stake, and earn updates will show up here.</span>
      </div>`;
      return;
    }
    list.innerHTML = items.map(it => `
      <div class="inbox-item">
        <div class="inbox-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </div>
        <div class="inbox-text">
          <div class="inbox-title">${escapeHtml(it.title)}</div>
          <div class="inbox-subtitle">${escapeHtml(it.subtitle || '')}</div>
        </div>
        <div class="inbox-date">${formatDate(it.ts)}</div>
      </div>
    `).join('');
  }

  function open() {
    if (typeof showView === 'function') showView('inbox');
    render();
    // Mark read after a brief delay so the user can see anything new before
    // the dot disappears.
    setTimeout(() => markAllRead(), 400);
  }

  function init() {
    $('inbox-btn')?.addEventListener('click', open);
    $('inbox-back')?.addEventListener('click', () => showView('home'));
    updateBell();
  }

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { add, render, markAllRead, unreadCount, clearAll, open, updateBell };
})();

window.Inbox = Inbox;
