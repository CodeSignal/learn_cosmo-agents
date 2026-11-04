// app.js — the shell: loads the session, shows the agent switcher (when the task allows
// switching), hosts each agent UI in its own frame so switching keeps its state, and shows the
// task's own web app (if it has one) in the App pane beside the agent.
import Modal from './design-system/components/modal/modal.js';
import Dropdown from './design-system/components/dropdown/dropdown.js';

const stage = document.getElementById('agent-stage');
const message = document.getElementById('stage-message');
const messageText = document.getElementById('stage-message-text');
const switcherEl = document.getElementById('agent-switcher');
const statusEl = document.getElementById('agent-status');
const frames = new Map();
let session = null;
let helpModal = null;

function showMessage(text) {
  messageText.textContent = text;
  message.hidden = false;
}

function setStatus(text, variant) {
  statusEl.innerHTML = '';
  if (!text) return;
  const tag = document.createElement('div');
  tag.className = `tag ${variant || 'secondary'}`;
  tag.textContent = text;
  statusEl.appendChild(tag);
}

async function fetchJson(url, options, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, options);
      const body = await res.json();
      return { ok: res.ok, status: res.status, body };
    } catch (error) {
      console.error(`Request to ${url} failed (attempt ${i}):`, error);
      if (i >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

function show(agentId) {
  const agent = session.agents.find((a) => a.id === agentId);
  for (const [id, frame] of frames) frame.hidden = id !== agentId;
  if (!agent.available) {
    showMessage(`${agent.label} is not available yet.`);
    setStatus('Not built yet', 'warning');
    return;
  }
  message.hidden = true;
  setStatus('');
  if (!frames.has(agentId)) {
    const frame = document.createElement('iframe');
    frame.className = 'agent-frame';
    frame.title = agent.label;
    frame.src = `/_cosmo/agents/${agentId}/`;
    stage.appendChild(frame);
    frames.set(agentId, frame);
  }
}

async function switchTo(agentId) {
  try {
    const { ok, body } = await fetchJson('/_cosmo/api/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agentId }),
    });
    if (!ok) {
      setStatus(body.reason || 'Switch refused', 'error');
      return;
    }
    session = body;
    show(session.active);
  } catch (error) {
    setStatus('Could not switch agents', 'error');
  }
}

function renderSwitcher() {
  switcherEl.innerHTML = '';
  if (session.allowSwitch && session.agents.length > 1) {
    new Dropdown('#agent-switcher', {
      placeholder: 'Coding agent',
      items: session.agents.map((a) => ({ value: a.id, label: a.label })),
      selectedValue: session.active,
      width: 220,
      onSelect: (value) => switchTo(value),
    });
  } else {
    const label = document.createElement('span');
    label.className = 'label-medium agent-label';
    label.textContent = session.agents.find((a) => a.id === session.active).label;
    switcherEl.appendChild(label);
  }
}

async function initializeHelpModal() {
  let content;
  try {
    content = await (await fetch(`${import.meta.env.BASE_URL}help-content.html`)).text();
  } catch (error) {
    console.error('Failed to load help content:', error);
    content = '<p>Help content could not be loaded.</p>';
  }
  helpModal = Modal.createHelpModal({ title: 'Help', content });
  document.getElementById('btn-help').addEventListener('click', () => helpModal.open());
}

// Per-viewer conveniences only; storage may be unavailable.
function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

/** The App pane: the task's web app beside the agent, resizable, opened from the header. */
function setupAppPane(app) {
  const button = document.getElementById('btn-app');
  const pane = document.getElementById('app-pane');
  const divider = document.getElementById('app-divider');
  const frame = document.getElementById('app-frame');
  const workspace = pane.parentElement;
  document.getElementById('app-address').textContent = `Port ${app.port} · ${app.path}`;
  document.getElementById('app-open').href = app.path;
  document.getElementById('app-reload').addEventListener('click', () => {
    frame.src = app.path;
  });

  const setWidth = (px) => {
    const max = workspace.clientWidth - 320;
    const width = Math.max(240, Math.min(max, px));
    pane.style.setProperty('--app-width', `${width}px`);
    divider.setAttribute('aria-valuenow', String(Math.round(width)));
    return width;
  };
  const saved = Number(remember('cosmo.app.width'));
  if (saved) pane.style.setProperty('--app-width', `${saved}px`);

  const setOpen = (open) => {
    pane.hidden = !open;
    divider.hidden = !open;
    button.textContent = open ? 'Hide app' : 'Show app';
    button.setAttribute('aria-pressed', String(open));
    if (open && !frame.getAttribute('src')) frame.src = app.path;
    remember('cosmo.app.open', open ? '1' : '0');
  };
  button.hidden = false;
  button.addEventListener('click', () => setOpen(pane.hidden));
  setOpen(remember('cosmo.app.open') === '1');

  divider.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const right = workspace.getBoundingClientRect().right;
    const move = (e) => setWidth(right - e.clientX);
    const stop = () => {
      document.body.classList.remove('resizing');
      divider.removeEventListener('pointermove', move);
      remember('cosmo.app.width', String(Math.round(pane.getBoundingClientRect().width)));
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', stop, { once: true });
    divider.addEventListener('pointercancel', stop, { once: true });
  });
  divider.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? 32 : event.key === 'ArrowRight' ? -32 : 0;
    if (!step) return;
    event.preventDefault();
    remember('cosmo.app.width', String(setWidth(pane.getBoundingClientRect().width + step)));
  });
}

async function initialize() {
  await initializeHelpModal();
  // An agent UI asks for help instead of opening its vendor's website.
  window.addEventListener('message', (event) => {
    if (event.origin === window.location.origin && event.data?.type === 'agentsim:help') helpModal.open();
  });
  try {
    const { ok, body } = await fetchJson('/_cosmo/api/session');
    if (!ok) throw new Error(body.error || 'session unavailable');
    session = body;
  } catch (error) {
    console.error('Failed to load the session:', error);
    showMessage('The coding agent could not be started. Reload the preview to try again.');
    setStatus('Unavailable', 'error');
    return;
  }
  renderSwitcher();
  show(session.active);
  if (session.app) setupAppPane(session.app);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
