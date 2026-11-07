// fastos app: choose a folder of Prolog repos, optimise them with mnns, see what was kept.
import { api, notify } from '/shared/api.js';
import { MARKER } from './lib/fastos.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};
const APP = location.pathname.split('/')[2] || 'fastos';
const DEFAULTS = { folder: 'Dropbox/GitHub-private2', mnns: 'Dropbox/GitHub-private2/mnns', runs: 3, suffix: '_fast', stackLimit: '4G', goal: 'main', test: '', keepUntested: false };
let st = { ...DEFAULTS };
let info;
let job = null;
let pending = '';
let total = 0;

const save = () => api.state.set('fastos', st).catch(() => {});
const fmt = (ms) => (ms === undefined || ms === null || Number.isNaN(ms) ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

async function show(folder) {
  let data;
  try {
    data = await api.files.list(folder);
  } catch (err) {
    $('repoCount').textContent = err.message;
    return;
  }
  st.folder = data.path;
  save();
  const parts = st.folder ? st.folder.split('/') : [];
  $('crumbs').replaceChildren(el('button', { textContent: 'Home', onclick: () => show('') }),
    ...parts.map((p, i) => el('button', { textContent: p, onclick: () => show(parts.slice(0, i + 1).join('/')) })));
  const dirs = data.entries.filter((e) => e.type === 'dir');
  const here = data.entries.some((e) => /\.pl$/i.test(e.name));
  const list = $('folders');
  list.replaceChildren(...dirs.map((d) => {
    const li = el('li', {}, el('span', { className: 'icon', textContent: '📁' }), el('span', { className: 'name', textContent: d.name }));
    li.addEventListener('click', () => show(d.path));
    li.dataset.path = d.path;
    return li;
  }));
  // which subfolders are repos (have .git or .pl files)?
  let repos = here ? 1 : 0;
  if (!here) {
    await Promise.all(dirs.slice(0, 80).map(async (d) => {
      const sub = await api.files.list(d.path, true).catch(() => null);
      if (sub?.entries.some((e) => e.name === '.git' || /\.pl$/i.test(e.name))) {
        repos++;
        list.querySelector(`li[data-path="${CSS.escape(d.path)}"]`)?.classList.add('repo');
      }
    }));
  }
  $('repoCount').textContent = here ? 'This folder is a repo: fastos will optimise it.' : repos ? `${repos} repo${repos === 1 ? '' : 's'} here: fastos will optimise each one.` : 'No Prolog repos here. Open a repo, or a folder of repos.';
  $('start').disabled = !repos || !!job;
}

function readOptions() {
  st.mnns = $('mnns').value.trim();
  st.runs = Number($('runs').value) || 3;
  st.suffix = $('suffix').value.trim() || '_fast';
  st.stackLimit = $('stackLimit').value.trim() || '4G';
  st.goal = $('goal').value.trim() || 'main';
  st.test = $('test').value.trim();
  st.keepUntested = $('keepUntested').checked;
  save();
}

function fillOptions() {
  for (const k of ['mnns', 'runs', 'suffix', 'stackLimit', 'goal', 'test']) $(k).value = st[k];
  $('keepUntested').checked = !!st.keepUntested;
}

async function start() {
  readOptions();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const args = [`${info.appsDir}/${APP}/runner.mjs`, st.folder, '--mnns', st.mnns, '--runs', String(st.runs), '--suffix', st.suffix, '--stack-limit', st.stackLimit, '--goal', st.goal];
  if (st.test) args.push('--test', st.test);
  if (st.keepUntested) args.push('--keep-untested');
  try {
    const j = await api.jobs.start({ cmd: 'node', args, cwd: '', label: `fastos: ${st.folder || 'Home'}` });
    st.lastJobId = j.id;
    save();
    attach(j);
  } catch (err) {
    $('status').textContent = err.message;
    $('status').className = 'error';
  }
}

function attach(j) {
  job = j;
  pending = '';
  total = 0;
  $('results').replaceChildren();
  $('output').replaceChildren();
  $('bar').style.width = '0';
  $('start').disabled = true;
  $('interrupt').disabled = false;
  $('status').textContent = 'Running…';
  $('status').className = 'quiet';
  api.jobs.stream(j.id, {
    output: ({ stream, text }) => {
      if (stream !== 'stdout') return $('output').append(el('span', { className: stream, textContent: text }));
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith(MARKER)) {
          try { onMarker(JSON.parse(line.slice(MARKER.length))); } catch {}
        } else $('output').append(el('span', { textContent: `${line}\n` }));
      }
    },
    end: (s) => {
      job = null;
      $('interrupt').disabled = true;
      $('start').disabled = false;
      st.lastJobId = null;
      save();
      if (s.status === 'cancelled') $('status').textContent = 'Interrupted';
      if (document.hidden) notify('fastos', $('status').textContent);
    }
  });
}

function onMarker(m) {
  if (m.event === 'begin') {
    total = m.repos.length;
    $('status').textContent = `0 of ${total} repos`;
  }
  if (m.event === 'repo') {
    const part = m.status === 'optimising' && m.of ? (m.done / m.of) * 0.6 + 0.2 : m.status.includes('original') ? 0.1 : m.status.includes('optimised') ? 0.85 : 0;
    $('bar').style.width = `${((m.index + part) / Math.max(1, m.total)) * 100}%`;
    $('step').textContent = `${m.repo}: ${m.status}${m.file ? ` ${m.file} (${m.done + 1} of ${m.of})` : ''}`;
  }
  if (m.event === 'result') {
    $('bar').style.width = `${((m.index + 1) / Math.max(1, m.total)) * 100}%`;
    $('status').textContent = `${m.index + 1} of ${m.total} repos`;
    $('results').append(resultRow(m.result));
  }
  if (m.event === 'end') {
    $('step').textContent = '';
    $('bar').style.width = '100%';
    if (m.error) {
      $('status').textContent = m.error;
      $('status').className = 'error';
      return;
    }
    const saved = m.results.filter((r) => r.status?.startsWith('saved')).length;
    $('status').textContent = `Done: ${saved} of ${m.results.length} repo${m.results.length === 1 ? '' : 's'} optimised and saved`;
    $('status').className = saved ? 'ok' : 'quiet';
  }
}

const LABELS = { saved: 'Saved', 'saved-untested': 'Saved (untested)', rejected: 'Not saved', unchanged: 'Nothing to do', skipped: 'Skipped', failed: 'Failed' };

function resultRow(r) {
  const copy = r.command ? el('button', { textContent: 'Copy', onclick: async () => { await navigator.clipboard.writeText(r.command).catch(() => {}); } }) : null;
  return el('tr', {},
    el('td', { textContent: r.repo }),
    el('td', { className: r.status }, LABELS[r.status] ?? r.status, r.note ? el('span', { className: 'note', textContent: r.note }) : null),
    el('td', { textContent: (r.changed ?? []).join(', ') || '–' }),
    el('td', { textContent: fmt(r.before) }),
    el('td', { textContent: fmt(r.after) }),
    el('td', { textContent: r.speedup ? `${r.speedup.toFixed(2)}×` : '–' }),
    el('td', { className: 'cmd' }, r.command ? el('code', { textContent: r.command }) : '–', copy));
}

$('start').addEventListener('click', start);
$('interrupt').addEventListener('click', () => job && api.jobs.cancel(job.id));
$('opts').addEventListener('change', readOptions);

async function init() {
  info = await api.info();
  st = { ...DEFAULTS, ...((await api.state.get('fastos').catch(() => null)) ?? {}) };
  fillOptions();
  const fromUrl = new URLSearchParams(location.search).get('folder');
  await show(fromUrl ?? st.folder).catch(() => show(''));
  if (st.lastJobId) {
    try {
      const j = await api.jobs.get(st.lastJobId);
      if (!j.endedAt) attach(j);
    } catch {}
  }
}

init();
