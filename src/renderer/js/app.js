// Convertline - Oberfläche: Liste, Einstellungen rechts, Warteschlange.
import { h, $, dialog, confirm, toast, showMenu } from './ui.js';
import { applyTheme, ACCENTS } from './theme.js';
import { icon, logoSvg } from './icons.js';
import i18n from '../../shared/i18n.js';
import F from '../../shared/formats.js';

const api = window.api;
const KIND_ICON = { video: 'video', audio: 'audio', image: 'image', doc: 'doc' };
const KIND_KEY = { video: 'kindVideo', audio: 'kindAudio', image: 'kindImage', doc: 'kindDoc' };
const LABEL = { h264: 'H.264', h265: 'H.265 (HEVC)', av1: 'AV1', vp9: 'VP9' };
const SIZE_CHIPS = [8, 10, 25, 50, 100];

const items = [];
let settings = {};
let info = {};
let hwFound = {};
let kind = 'video';
let running = false;
let stopping = false;
let nextId = 1;
let dragDepth = 0;

const t = (key, vars) => i18n.t(settings.language, key, vars);
const fmtTarget = (x) => x.toUpperCase();

function humanSize(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toLocaleString(settings.language, { maximumFractionDigits: i > 1 ? 1 : 0 })} ${units[i]}`;
}
function humanTime(s) {
  s = Math.max(0, Math.round(s));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Einstellungen
function withDefaults(s) {
  const out = { ...s };
  out.targets = { ...F.DEFAULTS.targets, pdf: 'png', ...s.targets };
  for (const k of ['video', 'audio', 'image', 'doc']) out[k] = { ...F.DEFAULTS[k], ...s[k] };
  out.language ||= i18n.LANGS.map(([c]) => c).find((c) => navigator.language.toLowerCase().startsWith(c)) || 'en';
  out.mode ||= 'system';
  out.look ||= 'standard';
  out.accent ||= ACCENTS[0];
  out.parallel ||= 2;
  out.exists ||= 'number';
  out.useHw ??= true;
  out.notify ??= true;
  out.save ||= { mode: 'same', folder: '' };
  return out;
}
function saveSettings() {
  api.setSettings(settings);
}
function theme() {
  const dark = settings.mode === 'dark' || (settings.mode === 'system' && info.dark);
  applyTheme(settings.accent, dark, settings.look);
}

// ---------------------------------------------------------------- Dateien aufnehmen
const allowed = (it) => F.targetsFor(it.kind, it.ext, !!it.probe?.audio?.length || it.kind !== 'video', info.encoders);
function targetOf(it) {
  const list = allowed(it);
  const want = it.target || (it.ext === 'pdf' ? settings.targets.pdf : settings.targets[it.kind]);
  return list.includes(want) ? want : list[0];
}

async function addPaths(paths) {
  if (!paths.length) return;
  const { files, skipped } = await api.expand(paths);
  if (skipped) toast(t('skippedFiles', { n: skipped }));
  const known = new Set(items.map((i) => i.file));
  const fresh = files.filter((f) => !known.has(f.file)).map((f) => ({ ...f, id: `f${nextId++}`, status: 'probing', ratio: 0, target: null }));
  if (!fresh.length) return;
  items.push(...fresh);
  if (!items.some((i) => i.kind === kind && !fresh.includes(i))) kind = fresh[0].kind;
  renderList();
  renderPanel();
  renderFooter();
  // Dateien nacheinander untersuchen, zu dritt, damit große Ordner die Platte nicht lahmlegen
  const queue = [...fresh];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      if (!items.includes(it)) continue;
      const r = await api.probe(it.file, it.kind);
      if (r.error) {
        it.status = 'error';
        it.error = t('errRead');
      } else {
        it.probe = r.probe;
        it.thumb = r.thumb;
        it.kind = r.kind;
        it.status = 'ready';
      }
      updateRow(it, true);
      renderPanel();
      renderFooter();
    }
  }));
}

async function pickFiles(folders) {
  addPaths(await api.openDialog({ folders, title: t(folders ? 'addFolder' : 'addFiles') }));
}

function removeItem(it) {
  if (it.status === 'running') api.cancelJob(it.id);
  items.splice(items.indexOf(it), 1);
  renderList();
  renderPanel();
  renderFooter();
}

// ---------------------------------------------------------------- Liste
function metaText(it) {
  const p = it.probe;
  if (it.status === 'running') {
    const parts = [`${Math.round(it.ratio * 100)} %`];
    if (it.left > 0) parts.push(t('left', { t: humanTime(it.left) }));
    if (it.speed > 0) parts.push(`${it.speed.toLocaleString(settings.language, { maximumFractionDigits: 1 })}×`);
    return parts.join(' · ');
  }
  if (it.status === 'queued') return t('statusQueued');
  if (it.status === 'error') return it.error;
  if (it.status === 'cancelled') return t('statusCancelled');
  if (it.status === 'skipped') return t('statusSkipped');
  if (it.status === 'done') {
    const parts = [`${humanSize(it.size)} → ${humanSize(it.outSize)}`];
    // Bei Dokumenten und extremen Sprüngen sagt der Prozentwert nichts aus
    const change = Math.round((1 - it.outSize / it.size) * 100);
    if (it.kind !== 'doc' && change >= 1) parts.push(t('smaller', { n: change }));
    else if (it.kind !== 'doc' && change <= -1 && change > -500) parts.push(t('bigger', { n: -change }));
    if (it.copied) parts.push(t('repacked'));
    if (it.hw) parts.push(t('viaGpu'));
    return parts.join(' · ');
  }
  const parts = [it.ext.toUpperCase()];
  if (p?.video?.w) parts.push(`${p.video.w}×${p.video.h}`);
  if (p?.duration && it.kind !== 'image') parts.push(humanTime(p.duration));
  parts.push(humanSize(it.size));
  return parts.join(' · ');
}

function rowMenu(it, e) {
  e.preventDefault();
  const list = [];
  if (it.out) list.push({ label: t('openFile'), run: () => api.openPath(it.out) }, { label: t('showFolder'), run: () => api.reveal(it.out) }, '-');
  list.push({ label: t('showOriginal'), run: () => api.reveal(it.file) });
  if (['done', 'error', 'cancelled', 'skipped'].includes(it.status) && !running) list.push({ label: t('again'), run: () => {
    it.status = 'ready';
    it.out = null;
    it.ratio = 0;
    updateRow(it, true);
    renderFooter();
  } });
  list.push('-', { label: t('remove'), run: () => removeItem(it) });
  showMenu(list, e.clientX, e.clientY);
}

function targetMenu(it, btn) {
  const r = btn.getBoundingClientRect();
  const list = allowed(it);
  const groups = it.kind === 'video' ? [list.filter(F.isVideoTarget), list.filter(F.isAudioTarget)] : [list];
  const entries = [];
  groups.forEach((g, i) => {
    if (i) entries.push({ header: t('soundOnly') });
    for (const x of g) entries.push({ label: fmtTarget(x), checked: x === targetOf(it), run: () => {
      const standard = it.ext === 'pdf' ? settings.targets.pdf : settings.targets[it.kind];
      it.target = x === standard ? null : x;
      updateRow(it, true);
      renderPanel();
    } });
  });
  btn.classList.add('menu-anchor');
  showMenu(entries, r.right, r.bottom + 4, { alignRight: true });
}

function rowEl(it) {
  const busy = ['queued', 'running'].includes(it.status);
  const thumb = h('div', { class: 'thumb' }, it.thumb ? h('img', { src: it.thumb, alt: '' }) : icon(KIND_ICON[it.kind], 20));
  const target = targetOf(it);
  const chip = h('button', { class: `target${it.target ? ' changed' : ''}`, disabled: busy || it.status === 'probing' || it.status === 'done' || !target }, target ? fmtTarget(target) : '–', !busy && it.status !== 'done' ? icon('down', 13) : null);
  chip.addEventListener('click', () => targetMenu(it, chip));
  const actions = h('div', { class: 'actions' });
  if (it.status === 'done') {
    actions.append(h('button', { class: 'icon-btn small', title: t('openFile'), onclick: () => api.openPath(it.out) }, icon('open', 16)));
    actions.append(h('button', { class: 'icon-btn small', title: t('showFolder'), onclick: () => api.reveal(it.out) }, icon('folder', 16)));
  }
  if (it.status === 'error' && it.detail) actions.append(h('button', { class: 'icon-btn small', title: t('details'), onclick: () => showError(it) }, icon('alert', 16)));
  actions.append(h('button', { class: 'icon-btn small', title: it.status === 'running' ? t('stop') : t('remove'), onclick: () => (it.status === 'running' ? api.cancelJob(it.id) : removeItem(it)) }, icon(it.status === 'running' ? 'stop' : 'close', 16)));
  const bar = h('div', { class: 'bar', style: { transform: `scaleX(${it.status === 'running' ? it.ratio : 0})` } });
  const el = h('div', { class: `item ${it.status}`, oncontextmenu: (e) => rowMenu(it, e) },
    thumb,
    h('div', { class: 'info' }, h('div', { class: 'name', text: it.name, title: it.file }), h('div', { class: 'meta', text: metaText(it) })),
    chip, actions, bar);
  if (it.status === 'done' && it.out) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.preventDefault();
      api.startDrag(it.out);
    });
  }
  it.el = el;
  return el;
}

function updateRow(it, full) {
  if (!it.el) return;
  if (full) {
    const old = it.el;
    old.replaceWith(rowEl(it));
    return;
  }
  $('.meta', it.el).textContent = metaText(it);
  $('.bar', it.el).style.transform = `scaleX(${it.ratio})`;
}

function renderList() {
  const list = $('#list');
  if (!items.length) {
    const sample = ['MP4', 'MKV', 'WEBM', 'GIF', 'MP3', 'FLAC', 'PNG', 'JPG', 'WEBP', 'PDF', 'DOCX'];
    list.replaceChildren(h('div', { class: 'empty' },
      h('div', { html: logoSvg(56) }),
      h('b', { text: t('dropTitle') }),
      h('span', { text: t('dropSub') }),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn primary', onclick: () => pickFiles(false) }, icon('plus', 16), t('addFiles')),
        h('button', { class: 'btn', onclick: () => pickFiles(true) }, icon('folder', 16), t('addFolder'))),
      h('div', { class: 'fmts' }, sample.map((s) => h('span', { text: s })))));
    return;
  }
  list.replaceChildren(...items.map(rowEl));
}

function showError(it) {
  dialog({ title: t('errorTitle'), body: h('div', {}, h('p', { class: 'dialog-text', text: it.name }), h('div', { class: 'error-text', text: it.detail })), buttons: [{ label: t('close'), value: 1, primary: true }] });
}

// ---------------------------------------------------------------- Rechts: Ziel und Einstellungen
const setOpt = (group, key, value) => {
  settings[group][key] = value;
  saveSettings();
  renderPanel();
};

function select(label, value, options, onChange) {
  const el = h('select', { onchange: (e) => onChange(e.target.value) });
  for (const [v, text] of options) el.append(h('option', { value: v, text, selected: String(v) === String(value) }));
  return h('div', { class: 'opt' }, h('label', { text: label }), el);
}
function seg(label, value, options, onChange) {
  return h('div', { class: 'opt' }, h('div', { class: 'lbl', text: label }), h('div', { class: 'seg' }, options.map(([v, text]) => h('button', { class: v === value ? 'on' : '', text, onclick: () => onChange(v) }))));
}
function tiles(list, current, onPick) {
  return h('div', { class: 'tiles' }, list.map((x) => h('button', { class: `tile${x === current ? ' on' : ''}`, text: fmtTarget(x), onclick: () => onPick(x) })));
}
function pickTarget(group, x) {
  settings.targets[group] = x;
  saveSettings();
  renderPanel();
  items.forEach((i) => updateRow(i, true));
}

function videoOptions() {
  const v = settings.video;
  const target = settings.targets.video;
  const list = [];
  const codecs = F.CODECS[target];
  if (codecs) {
    const usable = codecs.filter((c) => c !== 'av1' || info.encoders.some((e) => e === 'libaom-av1' || e === 'libsvtav1'));
    list.push(select(t('optCodec'), usable.includes(v.codec) ? v.codec : 'auto', usable.map((c) => [c, c === 'auto' ? t('auto') : LABEL[c]]), (x) => setOpt('video', 'codec', x)));
  }
  if (target !== 'gif') {
    list.push(seg(t('optQuality'), v.quality, [['original', t('qOriginal')], ['high', t('qHigh')], ['balanced', t('qBalanced')], ['small', t('qSmall')]], (x) => setOpt('video', 'quality', x)));
    if (v.quality === 'original' && !v.sizeMB) list.push(h('p', { class: 'hint', text: t('hintOriginal') }));
    const input = h('input', { type: 'number', min: '1', step: '1', value: v.sizeMB || '', placeholder: t('sizeOff'), onchange: (e) => setOpt('video', 'sizeMB', Math.max(0, Number(e.target.value) || 0)) });
    list.push(h('div', { class: 'opt' }, h('label', { text: t('optSize') }), input,
      h('div', { class: 'chips' }, SIZE_CHIPS.map((n) => h('button', { class: `chip${v.sizeMB === n ? ' on' : ''}`, text: `${n} MB`, onclick: () => setOpt('video', 'sizeMB', v.sizeMB === n ? 0 : n) })))));
    if (v.sizeMB) list.push(h('p', { class: 'hint', text: t('sizeHint') }));
  }
  list.push(select(t('optResolution'), v.height, [[0, t('sameAsSource')], ...[2160, 1440, 1080, 720, 480, 360].map((n) => [n, `${n}p`])], (x) => setOpt('video', 'height', Number(x))));
  list.push(select(t('optFps'), v.fps, [[0, t('sameAsSource')], ...[60, 30, 24, 15].map((n) => [n, String(n)])], (x) => setOpt('video', 'fps', Number(x))));
  if (target !== 'gif') list.push(seg(t('optSound'), v.audio, [['keep', t('soundKeep')], ['none', t('soundNone')]], (x) => setOpt('video', 'audio', x)));
  return list;
}

function audioOptions(target) {
  const a = settings.audio;
  const list = [];
  if (F.LOSSLESS_AUDIO.includes(target)) list.push(h('p', { class: 'hint', text: t('lossless') }));
  else list.push(select(t('optQuality'), a.kbps, [320, 256, 192, 128, 96].map((n) => [n, `${n} kbit/s`]), (x) => setOpt('audio', 'kbps', Number(x))));
  list.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.normalize, onchange: (e) => setOpt('audio', 'normalize', e.target.checked) }), t('optNormalize')));
  return list;
}

function imageOptions() {
  const o = settings.image;
  const target = settings.targets.image;
  const list = [];
  if (F.LOSSY_IMAGE.includes(target)) {
    const value = h('span', { text: `${o.quality} %` });
    list.push(h('div', { class: 'opt' }, h('div', { class: 'lbl', style: { display: 'flex', justifyContent: 'space-between' } }, t('optQuality'), value),
      h('input', { type: 'range', min: '10', max: '100', value: o.quality, oninput: (e) => {
        value.textContent = `${e.target.value} %`;
      }, onchange: (e) => setOpt('image', 'quality', Number(e.target.value)) })));
  }
  if (target !== 'ico') list.push(select(t('optMaxSize'), o.maxSize, [[0, t('sameAsSource')], ...[3840, 2560, 1920, 1280, 1024, 512, 256].map((n) => [n, `${n} px`])], (x) => setOpt('image', 'maxSize', Number(x))));
  if (F.FLAT_IMAGE.includes(target)) list.push(h('div', { class: 'opt inline' }, h('label', { text: t('optBackground') }), h('input', { type: 'color', value: o.background, onchange: (e) => setOpt('image', 'background', e.target.value) })));
  list.push(h('p', { class: 'hint', text: t('metaHint') }));
  return list;
}

function docOptions() {
  const o = settings.doc;
  const list = [];
  const pdfs = items.some((i) => i.ext === 'pdf');
  const texts = items.some((i) => i.kind === 'doc' && i.ext !== 'pdf');
  if (settings.targets.doc === 'pdf' && (texts || !pdfs)) list.push(seg(t('optPage'), o.page, [['a4', 'A4'], ['letter', 'Letter']], (x) => setOpt('doc', 'page', x)));
  return list;
}

function pdfOptions() {
  const o = settings.doc;
  if (settings.targets.pdf === 'txt') return [];
  return [select(t('optDpi'), o.dpi, [72, 100, 150, 200, 300].map((n) => [n, `${n} dpi`]), (x) => setOpt('doc', 'dpi', Number(x))), h('p', { class: 'hint', text: t('pdfHint') })];
}

function renderPanel() {
  const panel = $('#panel');
  const tabs = h('div', { class: 'tabs' }, F.KINDS.map((k) => {
    const n = items.filter((i) => i.kind === k).length;
    return h('button', { class: `tab${k === kind ? ' on' : ''}`, onclick: () => {
      kind = k;
      renderPanel();
    } }, icon(KIND_ICON[k], 19), t(KIND_KEY[k]), n ? h('span', { class: 'count', text: n }) : null);
  }));
  const body = [];
  const section = (title, ...nodes) => body.push(h('div', { class: 'sect' }, h('div', { class: 'sect-title', text: title }), ...nodes));
  const enc = info.encoders;
  if (kind === 'video') {
    const all = F.targetsFor('video', 'mp4', true, enc);
    const target = settings.targets.video;
    section(t('convertTo'), tiles(all.filter(F.isVideoTarget), target, (x) => pickTarget('video', x)));
    section(t('soundOnly'), tiles(all.filter(F.isAudioTarget), target, (x) => pickTarget('video', x)));
    body.push(h('div', { class: 'sect' }, F.isAudioTarget(target) ? audioOptions(target) : videoOptions()));
  } else if (kind === 'audio') {
    const target = settings.targets.audio;
    section(t('convertTo'), tiles(F.targetsFor('audio', 'mp3', true, enc), target, (x) => pickTarget('audio', x)));
    body.push(h('div', { class: 'sect' }, audioOptions(target), h('p', { class: 'hint', text: t('tagsHint') })));
  } else if (kind === 'image') {
    section(t('convertTo'), tiles(F.targetsFor('image', 'png', true, enc), settings.targets.image, (x) => pickTarget('image', x)));
    body.push(h('div', { class: 'sect' }, imageOptions()));
  } else {
    section(t('textDocs'), tiles(['pdf', 'html', 'txt', 'md'], settings.targets.doc, (x) => pickTarget('doc', x)));
    body.push(h('div', { class: 'sect' }, docOptions()));
    section(t('pdfFiles'), tiles(['png', 'jpg', 'txt'], settings.targets.pdf, (x) => pickTarget('pdf', x)));
    body.push(h('div', { class: 'sect' }, pdfOptions()));
  }
  panel.replaceChildren(tabs, ...body);
}

// ---------------------------------------------------------------- Fußleiste
function renderFooter() {
  const footer = $('#footer');
  const s = settings.save;
  const open = items.filter((i) => i.status === 'ready' || i.status === 'probing');
  const total = items.reduce((n, i) => n + i.size, 0);
  const anyDone = items.some((i) => ['done', 'skipped'].includes(i.status));
  const saveBtn = h('button', { class: 'save-to menu-anchor', title: s.mode === 'folder' ? s.folder : '', onclick: () => {
    const r = saveBtn.getBoundingClientRect();
    showMenu([
      { label: t('saveSame'), checked: s.mode === 'same', run: () => {
        settings.save = { ...s, mode: 'same' };
        saveSettings();
        renderFooter();
      } },
      ...(s.folder ? [{ label: s.folder, checked: s.mode === 'folder', run: () => {
        settings.save = { ...s, mode: 'folder' };
        saveSettings();
        renderFooter();
      } }] : []),
      '-',
      { label: t('saveFolder'), run: async () => {
        const folder = await api.pickFolder({ title: t('saveTo') });
        if (!folder) return;
        settings.save = { mode: 'folder', folder };
        saveSettings();
        renderFooter();
      } },
    ], r.left, r.top - 4);
    const menu = $('.menu');
    if (menu) menu.style.top = `${Math.max(4, r.top - menu.getBoundingClientRect().height - 4)}px`;
  } }, h('small', { text: t('saveTo') }), h('span', { class: 'txt', text: s.mode === 'folder' ? s.folder : t('saveSame') }), icon('down', 14));
  const parts = [saveBtn, h('div', { class: 'spacer' })];
  if (items.length) parts.push(h('span', { class: 'summary', text: `${items.length === 1 ? t('filesOne') : t('filesN', { n: items.length })} · ${humanSize(total)}` }));
  if (anyDone && !running) parts.push(h('button', { class: 'btn', text: t('clearDone'), onclick: () => {
    for (let i = items.length - 1; i >= 0; i--) if (['done', 'skipped'].includes(items[i].status)) items.splice(i, 1);
    renderList();
    renderPanel();
    renderFooter();
  } }));
  else if (items.length && !running) parts.push(h('button', { class: 'btn', text: t('clearAll'), onclick: () => {
    items.length = 0;
    renderList();
    renderPanel();
    renderFooter();
  } }));
  parts.push(running
    ? h('button', { class: 'btn go danger', onclick: stop }, icon('stop', 15), t('stop'))
    : h('button', { class: 'btn go primary', disabled: !open.some((i) => i.status === 'ready'), text: t('start'), onclick: start }));
  footer.replaceChildren(...parts);
}

// ---------------------------------------------------------------- Warteschlange
function optionsFor(it, target) {
  if (it.kind === 'image') return settings.image;
  if (it.kind === 'doc') return settings.doc;
  return F.isAudioTarget(target) ? settings.audio : settings.video;
}

function errorText(code) {
  return { NO_AUDIO: t('errAudio'), TARGET_TOO_SMALL: t('errSmall') }[code] || t('errFailed');
}

async function runItem(it) {
  it.status = 'running';
  it.ratio = 0;
  updateRow(it, true);
  const target = targetOf(it);
  const r = await api.runJob({
    id: it.id, file: it.file, kind: it.kind, ext: it.ext, probe: it.probe, target,
    options: optionsFor(it, target),
    outDir: settings.save.mode === 'folder' ? settings.save.folder : '',
    rule: settings.exists,
    useHw: settings.useHw,
  });
  if (!items.includes(it)) return;
  if (r.cancelled) it.status = 'cancelled';
  else if (r.skipped) it.status = 'skipped';
  else if (r.error) {
    it.status = 'error';
    it.error = errorText(r.code);
    it.detail = r.code ? '' : r.error;
  } else {
    it.status = 'done';
    it.out = r.out;
    it.outSize = r.size;
    it.hw = r.hw;
    it.copied = r.copied;
  }
  it.ratio = 0;
  updateRow(it, true);
  overall();
}

function overall() {
  const active = items.filter((i) => ['queued', 'running', 'done', 'error', 'skipped'].includes(i.status) && i.batch);
  if (!running || !active.length) return api.setProgress(null, 'Convertline');
  const sum = active.reduce((n, i) => n + (i.status === 'queued' ? 0 : i.status === 'running' ? i.ratio : 1), 0);
  const ratio = sum / active.length;
  api.setProgress(ratio, `${Math.round(ratio * 100)} % – Convertline`);
}

async function start() {
  if (running) return;
  running = true;
  stopping = false;
  items.forEach((i) => {
    i.batch = i.status === 'ready';
    if (i.batch) i.status = 'queued';
    updateRow(i, true);
  });
  renderFooter();
  await Promise.all(Array.from({ length: settings.parallel }, async () => {
    while (!stopping) {
      const it = items.find((i) => i.status === 'queued');
      if (!it) return;
      await runItem(it);
    }
  }));
  items.forEach((i) => {
    if (i.status === 'queued') {
      i.status = 'ready';
      updateRow(i, true);
    }
  });
  running = false;
  api.setProgress(null, 'Convertline');
  renderFooter();
  const batch = items.filter((i) => i.batch);
  const done = batch.filter((i) => i.status === 'done').length;
  const failed = batch.filter((i) => i.status === 'error').length;
  if (stopping || !batch.length) return;
  const text = [t('doneMsg', { n: done }), ...(failed ? [t('doneErrors', { n: failed })] : [])].join(' · ');
  toast(text, { kind: failed ? 'error' : '' });
  if (settings.notify && !document.hasFocus()) new Notification(t('doneTitle'), { body: text });
}

function stop() {
  stopping = true;
  api.cancelAll();
}

// ---------------------------------------------------------------- Einstellungen
async function openSettings() {
  const set = (key, value) => {
    settings[key] = value;
    saveSettings();
    theme();
  };
  const hwHint = h('p', { class: 'hint', text: Object.keys(hwFound).length ? t('hwHint') : t('hwNone') });
  const body = h('div', { class: 'settings' },
    select(t('setLanguage'), settings.language, i18n.LANGS, (x) => {
      set('language', x);
      renderList();
      renderPanel();
      renderFooter();
      $('#add-files').title = t('addFiles');
      dialogClose?.(1);
      openSettings();
    }),
    select(t('setMode'), settings.mode, [['system', t('modeSystem')], ['light', t('modeLight')], ['dark', t('modeDark')]], (x) => set('mode', x)),
    select(t('setLook'), settings.look, [['standard', t('lookStandard')], ['acryl', t('lookAcryl')]], (x) => set('look', x)),
    h('div', { class: 'opt' }, h('div', { class: 'lbl', text: t('setAccent') }), h('div', { class: 'swatches' }, ACCENTS.map((c) => h('button', { class: `swatch${c === settings.accent ? ' on' : ''}`, style: { background: c }, onclick: (e) => {
      set('accent', c);
      body.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
      e.currentTarget.classList.add('on');
    } })))),
    select(t('setParallel'), settings.parallel, [1, 2, 3, 4, 6, 8].map((n) => [n, String(n)]), (x) => set('parallel', Number(x))),
    select(t('setExists'), settings.exists, [['number', t('existsNumber')], ['overwrite', t('existsOverwrite')], ['skip', t('existsSkip')]], (x) => set('exists', x)),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settings.useHw, disabled: !Object.keys(hwFound).length, onchange: (e) => set('useHw', e.target.checked) }), t('setHw')),
    hwHint,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settings.notify, onchange: (e) => set('notify', e.target.checked) }), t('setNotify')),
    h('div', { class: 'about' },
      h('div', { text: `Convertline · ${t('version', { v: info.version })}` }),
      h('div', { text: t('licenseNote') }),
      h('a', { text: t('website'), onclick: () => api.openExternal('https://mert.win/convert/') }), ' · ',
      h('a', { text: 'GitHub', onclick: () => api.openExternal('https://github.com/erqf1/convertline') })));
  let dialogClose = null;
  await dialog({ title: t('settings'), body, buttons: [{ label: t('close'), value: 1, primary: true }], onOpen: (_card, close) => {
    dialogClose = close;
  } });
}

// ---------------------------------------------------------------- Aufbau
function build() {
  const add = h('button', { id: 'add-files', class: 'btn', onclick: () => pickFiles(false), title: t('addFiles') }, icon('plus', 16));
  const folder = h('button', { class: 'btn', onclick: () => pickFiles(true), title: t('addFolder') }, icon('folder', 16));
  $('#app').replaceChildren(
    h('div', { id: 'topbar' }, h('div', { class: 'brand' }, h('span', { html: logoSvg(26), style: { display: 'block', height: '26px' } }), 'Convertline'), h('div', { class: 'spacer' }), add, folder,
      h('button', { class: 'icon-btn', title: t('settings'), onclick: openSettings }, icon('settings', 18))),
    h('div', { id: 'workspace' }, h('div', { id: 'list' }), h('div', { id: 'panel' })),
    h('div', { id: 'footer' }));
  renderList();
  renderPanel();
  renderFooter();
}

// Dateien aus dem Explorer hineinziehen
function setupDrop() {
  const hint = h('div', { class: 'drop-hint hidden', text: '' });
  document.body.append(hint);
  const fromOutside = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!fromOutside(e)) return;
    e.preventDefault();
    dragDepth++;
    hint.textContent = t('dropHere');
    hint.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) hint.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    hint.classList.add('hidden');
    addPaths([...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean));
  });
}

async function main() {
  info = await api.info();
  settings = withDefaults(await api.getSettings());
  saveSettings();
  theme();
  document.documentElement.lang = settings.language;
  build();
  setupDrop();
  api.onProgress(({ id, ratio, speed, left }) => {
    const it = items.find((i) => i.id === id);
    if (!it || it.status !== 'running') return;
    Object.assign(it, { ratio, speed, left });
    updateRow(it);
    overall();
  });
  api.onOpenFiles(addPaths);
  api.onSystemTheme((dark) => {
    info.dark = dark;
    theme();
  });
  api.onClosing(async (o) => {
    if (running) {
      const r = await confirm(t('closeTitle'), t('closeMsg'), [{ label: t('cancel'), value: 'cancel' }, { label: t('closeAnyway'), value: 'close', danger: true }]);
      if (r !== 'close') return;
      await api.cancelAll();
    }
    if (o?.update) api.updateReady();
    else api.closeNow();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      pickFiles(false);
    }
  });
  addPaths(await api.initialFiles());
  hwFound = await api.hardware();
  if (info.selfTest) window.__cl = { items, addPaths, start, stop, settings: () => settings, setKind: (k) => {
    kind = k;
    renderPanel();
  }, isRunning: () => running, refresh: () => {
    theme();
    renderList();
    renderPanel();
    renderFooter();
  }, set: (next) => {
    Object.assign(settings, next);
  } };
}

main();
