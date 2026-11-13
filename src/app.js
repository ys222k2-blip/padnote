// PadNote 앱 본체: 화면 전환, 도구 막대, 열기/자동 저장/내보내기, 녹화·재생 UI.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { Viewer } from './viewer.js';
import { Input } from './input.js';
import { Notes } from './notes.js';
import { Playback } from './playback.js';
import * as store from './store.js';
import { probe, readNotes, buildExport, invertMatrix } from './padfile.js';
import { HL_ALPHA } from './ink.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}pdfjs/pdf.worker.min.mjs`;
const PDF_OPTS = {
  cMapUrl: `${VENDOR}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${VENDOR}pdfjs/standard_fonts/`,
  wasmUrl: `${VENDOR}pdfjs/wasm/`,
  iccUrl: `${VENDOR}pdfjs/iccs/`,
  enableHWA: true,
};
const RANGE_MIN = 24 * 1024 * 1024; // 이보다 큰 파일은 통째로 읽지 않고 필요한 구간만 읽는다
const COARSE = matchMedia('(pointer: coarse)').matches;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

// ── 아이콘 ──────────────────────────────────────────────
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  pen: '<path d="M4 20l1.2-4.3L16.4 4.5a2.1 2.1 0 013 3L8.2 18.8 4 20z"/><path d="M14.5 6.5l3 3"/>',
  hl: '<path d="M9.5 14.5l-3 3V20h2.5l3-3"/><path d="M9 14l7.5-9.5 4 4L11 16z"/><path d="M3.5 21h9"/>',
  eraser: '<path d="M8 20h12"/><path d="M5.6 13.4l7.2-7.2a2 2 0 012.8 0l3.2 3.2a2 2 0 010 2.8L11.6 19.4H8.4l-2.8-2.8a2.3 2.3 0 010-3.2z"/><path d="M9.5 9.5l5.5 5.5"/>',
  undo: '<path d="M8.5 14L4 9.5 8.5 5"/><path d="M4 9.5h10a5.5 5.5 0 010 11h-3"/>',
  redo: '<path d="M15.5 14L20 9.5 15.5 5"/><path d="M20 9.5H10a5.5 5.5 0 000 11h3"/>',
  finger: '<path d="M9 12V5.2a1.6 1.6 0 013.2 0V11"/><path d="M12.2 10.4a1.5 1.5 0 013 0V12"/><path d="M15.2 11.4a1.5 1.5 0 013 0v3.4a6.2 6.2 0 01-6.2 6.2h-.6a5.5 5.5 0 01-4.5-2.3L4 14.4a1.5 1.5 0 012.3-1.9L9 15.2"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>',
  share: '<path d="M12 3.5V15"/><path d="M8 7.5l4-4 4 4"/><path d="M7 11H6a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 006 21h12a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0018 11h-1"/>',
  plus: '<path d="M12 6v12M6 12h12"/>',
  minus: '<path d="M6 12h12"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  sliders: '<path d="M4 7.5h8M17 7.5h3M4 16.5h3M12 16.5h8"/><circle cx="14.5" cy="7.5" r="2.5"/><circle cx="9.5" cy="16.5" r="2.5"/>',
  trash: '<path d="M5 7h14"/><path d="M10 7V4.5h4V7"/><path d="M7 7l.8 12.5h8.4L17 7"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
for (const node of document.querySelectorAll('[data-icon]')) node.innerHTML = icon(node.dataset.icon);

// ── 설정 ────────────────────────────────────────────────
const PALETTE = {
  pen: ['#1a1a1a', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5'],
  hl: ['#ffd60a', '#51cf66', '#ff6b9d', '#4dabf7', '#ff922b', '#b197fc'],
};
const SIZES = {
  pen: { min: 0.4, max: 8, step: 0.1, presets: [0.8, 1.6, 2.8, 4.5] },
  hl: { min: 4, max: 32, step: 1, presets: [8, 12, 18, 26] },
  eraser: { min: 4, max: 40, step: 1, presets: [6, 11, 20, 32] }, // 반지름, 화면 px
};
const SPEEDS = [1, 2, 4, 8, 0.5];
const settings = {
  tool: 'pen',
  pen: { color: PALETTE.pen[0], size: 1.6 },
  hl: { color: PALETTE.hl[0], size: 12 },
  eraser: { size: 11 },
  finger: false,
  swipeErase: false, // 한 손가락 가로 쓸기를 지우개로
  pressure: false, // 필압을 굵기에 반영
  smooth: 2, // 획 보정: 0 끔 · 1 약 · 2 보통 · 3 강
  barPos: 'bottom', // 도구 막대 위치: 'bottom' | 'top'
  speed: 1,
  skip: true,
  hinted: false,
};
try {
  const saved = JSON.parse(localStorage.getItem('padnote.settings') || '{}');
  for (const k of Object.keys(settings)) {
    if (saved[k] == null) continue;
    if (typeof settings[k] === 'object') Object.assign(settings[k], saved[k]);
    else settings[k] = saved[k];
  }
} catch { /* 저장된 설정이 없거나 손상됨 */ }
const saveSettings = () => {
  try { localStorage.setItem('padnote.settings', JSON.stringify(settings)); } catch { /* 사생활 보호 모드 */ }
};

// ── 상태 ────────────────────────────────────────────────
/** 열려 있는 문서: { id, name, blob, pdf, task, notes, password, meta } */
let doc = null;
let playback = null;
let busyCount = 0;
const dirty = new Set();
let saveTimer = 0;
let saveWarned = false;
let recTimer = 0;

const viewer = new Viewer({
  scroller: $('scroller'),
  pagesEl: $('pages'),
  live: $('live'),
  strokesFor: (i) => {
    if (!doc) return [];
    if (playback) return playback.strokesFor(i);
    return input.filter(doc.notes.visible(i));
  },
  onPage: (i) => { $('page-pill').textContent = `${i + 1} / ${viewer.n}`; },
  onScale: (s, fit) => { $('zoom-val').textContent = `${Math.round((s / fit) * 100)}%`; },
});

const input = new Input(viewer, {
  getTool: () => ({ tool: settings.tool, ...(settings[settings.tool] || {}) }),
  getNotes: () => doc?.notes || null,
  fingerDraw: () => settings.finger,
  eraserRadius: () => settings.eraser.size,
  swipeErase: () => settings.swipeErase,
  pressure: () => settings.pressure,
  smoothLevel: () => settings.smooth,
  locked: () => !!playback,
  onPen: () => {
    // 펜을 쓰기 시작하면 손바닥이 획을 남기지 않도록 손가락 필기를 끈다.
    if (settings.finger) { setFinger(false); toast('Apple Pencil을 감지해 손가락 필기를 껐습니다'); }
  },
});

// ── 알림·대화상자 ───────────────────────────────────────
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(on, text = '') {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  $('busy').hidden = busyCount === 0;
  if (on) $('busy-text').textContent = text;
}
/** buttons: [{ label, value, kind? }] → 선택한 value (닫으면 null). input 이 있으면 {value, text}. */
function ask({ title, body = '', buttons, input: inputOpts }) {
  return new Promise((resolve) => {
    const dlg = $('dlg');
    $('dlg-title').textContent = title;
    $('dlg-body').textContent = body;
    $('dlg-body').hidden = !body;
    const field = $('dlg-input');
    field.hidden = !inputOpts;
    if (inputOpts) { field.type = inputOpts.type || 'text'; field.value = inputOpts.value || ''; field.inputMode = inputOpts.inputMode || ''; }
    const actions = $('dlg-actions');
    actions.textContent = '';
    let result = null;
    for (const b of buttons) {
      const btn = el('button', { type: 'submit', textContent: b.label, className: b.kind || '' });
      btn.addEventListener('click', () => { result = b.value; });
      actions.append(btn);
    }
    dlg.addEventListener('close', () => resolve(inputOpts ? { value: result, text: field.value } : result), { once: true });
    field.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); actions.querySelector('.main')?.click(); }
    };
    dlg.showModal();
    if (inputOpts) field.focus();
  });
}
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ── 도구 막대 ───────────────────────────────────────────
function renderTools() {
  const tool = settings.tool;
  document.body.classList.remove('tool-pen', 'tool-hl', 'tool-eraser');
  document.body.classList.add(`tool-${tool}`);
  for (const b of document.querySelectorAll('.tool')) b.setAttribute('aria-checked', String(b.dataset.tool === tool));

  const colors = $('colors');
  const drawing = tool !== 'eraser';
  colors.hidden = !drawing;
  const dot = $('size-dot');
  const range = SIZES[tool];
  const cur = settings[tool];
  const d = 5 + ((cur.size - range.min) / (range.max - range.min)) * 17;
  dot.style.width = dot.style.height = `${d}px`;
  dot.classList.toggle('ring', !drawing); // 지우개는 속이 빈 원으로 표시
  dot.style.background = drawing ? cur.color : '';
  dot.style.opacity = tool === 'hl' ? '0.6' : '1';
  $('size-btn').title = drawing ? '굵기' : '지우개 크기';
  $('size-btn').setAttribute('aria-label', $('size-btn').title);
  if (!drawing) return;
  colors.textContent = '';
  for (const c of PALETTE[tool]) {
    const b = el('button', { type: 'button', className: 'sw', title: c });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === cur.color));
    b.setAttribute('aria-label', `색 ${c}`);
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => { cur.color = c; saveSettings(); renderTools(); });
    colors.append(b);
  }
  const isCustom = !PALETTE[tool].includes(cur.color);
  const pick = el('input', { type: 'color', value: cur.color });
  pick.setAttribute('aria-label', '다른 색 고르기');
  const custom = el('label', { className: `sw custom${isCustom ? ' set' : ''}`, title: '다른 색' }, pick);
  custom.setAttribute('aria-checked', String(isCustom));
  if (isCustom) custom.style.setProperty('--c', cur.color);
  pick.addEventListener('change', () => { cur.color = pick.value; saveSettings(); renderTools(); });
  colors.append(custom);
}

function setTool(tool) {
  settings.tool = tool;
  saveSettings();
  hidePopover();
  renderTools();
}

// 손가락 필기와 손가락 지우개는 둘 다 한 손가락 동작을 쓰므로 한쪽을 켜면 다른 쪽을 끈다.
function setFinger(on) {
  settings.finger = on;
  if (on) settings.swipeErase = false;
  saveSettings();
  renderFingerModes();
}
function setSwipeErase(on) {
  settings.swipeErase = on;
  if (on) settings.finger = false;
  saveSettings();
  renderFingerModes();
}
function renderFingerModes() {
  $('finger-btn').setAttribute('aria-pressed', String(settings.finger));
  $('opt-swipe').checked = settings.swipeErase;
  document.body.classList.toggle('swipe-erase', settings.swipeErase && !settings.finger);
}

/** 캐시된 앱 파일을 최신으로 바꾸고 다시 불러온다(홈 화면 앱에는 브라우저의 새로고침 버튼이 없다). */
async function refreshApp() {
  hidePopover();
  busy(true, '최신 버전 확인 중…');
  try {
    await flushSave();
    if ('caches' in window) {
      for (const name of await caches.keys()) {
        if (!name.startsWith('padnote-')) continue;
        const cache = await caches.open(name);
        const reqs = (await cache.keys()).filter((r) => !new URL(r.url).pathname.includes('/vendor/'));
        await Promise.all(reqs.map(async (r) => {
          const res = await fetch(r.url, { cache: 'reload' });
          if (res.ok) await cache.put(r, res);
        }));
      }
    }
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    const sw = reg?.installing;
    if (sw) {
      await Promise.race([
        new Promise((r) => sw.addEventListener('statechange', () => { if (sw.state === 'activated' || sw.state === 'redundant') r(); })),
        new Promise((r) => setTimeout(r, 15000)),
      ]);
    }
  } catch (err) {
    console.warn('최신 버전을 받지 못했습니다(오프라인?). 캐시된 버전으로 다시 엽니다.', err);
  }
  location.reload();
}

function renderHistory() {
  $('undo-btn').disabled = !doc?.notes.canUndo;
  $('redo-btn').disabled = !doc?.notes.canRedo;
}

function showSizePopover() {
  const pop = $('size-pop');
  if (!pop.hidden) { hidePopover(); return; }
  hidePopover();
  const tool = settings.tool;
  const cur = settings[tool];
  const range = SIZES[tool];
  const slider = $('size-range');
  Object.assign(slider, { min: range.min, max: range.max, step: range.step, value: cur.size });
  const sample = $('size-sample');
  const erasing = tool === 'eraser';
  sample.classList.toggle('ring', erasing);
  const paint = () => {
    if (erasing) {
      // 지우개는 화면에 닿는 실제 크기의 원으로 보여 준다.
      sample.style.width = sample.style.height = `${cur.size * 2}px`;
      sample.style.background = '';
    } else {
      sample.style.width = '';
      sample.style.height = `${Math.max(1, cur.size * 1.4)}px`;
      sample.style.background = cur.color;
      sample.style.opacity = tool === 'hl' ? String(HL_ALPHA + 0.25) : '1';
    }
    for (const b of presets.children) b.setAttribute('aria-checked', String(Number(b.dataset.v) === cur.size));
  };
  const presets = $('size-presets');
  presets.textContent = '';
  for (const v of range.presets) {
    const d = 5 + ((v - range.min) / (range.max - range.min)) * 17;
    const b = el('button', { type: 'button', title: erasing ? `${v}px` : `${v}pt` }, el('i'));
    b.firstChild.classList.toggle('ring', erasing);
    b.dataset.v = String(v);
    b.firstChild.style.width = b.firstChild.style.height = `${d}px`;
    b.addEventListener('click', () => { cur.size = v; slider.value = v; saveSettings(); paint(); renderTools(); });
    presets.append(b);
  }
  slider.oninput = () => { cur.size = Number(slider.value); saveSettings(); paint(); renderTools(); };
  paint();
  placePopover(pop, $('size-btn'));
}
function placePopover(pop, anchor) {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  // 도구 막대 바깥쪽으로 띄운다: 막대가 위에 있으면 그 아래로, 아래에 있으면 그 위로.
  const bar = $('toolbar').getBoundingClientRect();
  const below = bar.bottom + 6;
  const fits = below + pop.offsetHeight <= window.innerHeight - 8;
  pop.style.top = `${fits ? below : Math.max(8, bar.top - 6 - pop.offsetHeight)}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2))}px`;
}
function hidePopover() {
  $('size-pop').hidden = true;
  $('settings-pop').hidden = true;
}
document.addEventListener('pointerdown', (e) => {
  for (const [pop, btn] of [['size-pop', 'size-btn'], ['settings-pop', 'settings-btn']]) {
    if (!$(pop).hidden && !$(pop).contains(e.target) && !$(btn).contains(e.target)) $(pop).hidden = true;
  }
}, true);

function renderSettings() {
  $('opt-pressure').checked = settings.pressure;
  $('opt-swipe').checked = settings.swipeErase;
  for (const b of $('opt-smooth').children) b.setAttribute('aria-checked', String(Number(b.dataset.v) === settings.smooth));
  for (const b of $('opt-bar').children) b.setAttribute('aria-checked', String(b.dataset.v === settings.barPos));
}

/** 도구 막대 위치를 반영한다. 아래에 둘 때는 문서가 상태 막대 밑까지 올라가므로 첫 페이지 위를 그만큼 비운다. */
function applyBarPos() {
  const bottom = settings.barPos !== 'top';
  document.body.classList.toggle('bar-bottom', bottom);
  viewer.setInset(bottom ? $('sat-probe').offsetHeight : 0);
}
window.addEventListener('resize', applyBarPos);
function showSettingsPopover() {
  const pop = $('settings-pop');
  if (!pop.hidden) { hidePopover(); return; }
  hidePopover();
  renderSettings();
  placePopover(pop, $('settings-btn'));
}

// ── 문서 열기 ───────────────────────────────────────────
class BlobTransport extends pdfjs.PDFDataRangeTransport {
  constructor(blob, initial) {
    super(blob.size, initial, true);
    this.blob = blob;
  }
  requestDataRange(begin, end) {
    this.blob.slice(begin, end).arrayBuffer().then(
      (buf) => this.onDataRange(begin, new Uint8Array(buf)),
      (err) => console.error('PDF 구간 읽기 실패', err),
    );
  }
}

async function loadPdf(blob, ctx) {
  let task;
  if (blob.size >= RANGE_MIN || window.__padnoteForceRange) {
    const initial = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    task = pdfjs.getDocument({ ...PDF_OPTS, range: new BlobTransport(blob, initial), disableAutoFetch: true, disableStream: true });
  } else {
    task = pdfjs.getDocument({ ...PDF_OPTS, data: await blob.arrayBuffer() });
  }
  ctx.task = task;
  task.onPassword = async (update, reason) => {
    busy(false);
    const wrong = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    const r = await ask({
      title: '암호로 보호된 PDF',
      body: wrong ? '암호가 맞지 않습니다. 다시 입력해 주세요.' : '이 문서를 열려면 암호가 필요합니다.',
      input: { type: 'password' },
      buttons: [{ label: '취소', value: false }, { label: '열기', value: true, kind: 'main' }],
    });
    busy(true, '여는 중…');
    if (r.value) { ctx.password = r.text; update(r.text); } else task.destroy();
  };
  return task.promise;
}

async function openBlob(file, name) {
  if (busyCount) return;
  busy(true, '여는 중…');
  const ctx = {};
  try {
    await closeDoc();
    // 1) 통합 저장 파일인지 확인: 맞으면 원본 구간만 잘라 쓰고 획은 첨부 데이터에서 복원한다.
    let blob = file;
    let embedded = null;
    try {
      const info = await probe(file);
      if (info) {
        embedded = await readNotes(file, info);
        blob = file.slice(0, info.origLen, 'application/pdf');
      }
    } catch (err) {
      console.warn('PadNote 데이터 검증 실패 → 일반 PDF로 엽니다', err);
      embedded = null;
      blob = file;
    }

    const pdf = await loadPdf(blob, ctx);
    const id = pdf.fingerprints[0] || `size-${blob.size}-${pdf.numPages}`;
    const title = embedded?.name || name.replace(/\.pdf$/i, '').replace(/[-_ ]필기$/, '') || '문서';

    // 2) 이 기기에 자동 저장된 필기와 파일 속 필기 중 무엇을 쓸지 정한다.
    const notes = new Notes(id);
    notes.name = title;
    let meta = null, local = null;
    try {
      meta = await store.getMeta(id);
      if (meta) local = { pages: await store.loadInk(id), rec: meta.rec, updatedAt: meta.updatedAt };
    } catch (err) { console.warn('저장된 필기를 읽지 못했습니다', err); }
    let data = local;
    let replace = false;
    if (embedded) {
      const localHasInk = local && Object.keys(local.pages).length > 0;
      if (localHasInk && local.updatedAt > embedded.updatedAt) {
        busy(false);
        const pick = await ask({
          title: '어느 필기를 사용할까요?',
          body: '이 기기에 파일보다 나중에 저장된 필기가 있습니다.',
          buttons: [{ label: '파일의 필기', value: 'file' }, { label: '이 기기의 필기', value: 'local', kind: 'main' }],
        });
        busy(true, '여는 중…');
        if (pick === 'file') { data = embedded; replace = true; }
      } else if (!local || local.updatedAt !== embedded.updatedAt) {
        data = embedded;
        replace = true;
      }
    }
    if (data) notes.load(data);

    doc = { id, name: title, blob, pdf, task: ctx.task, notes, password: ctx.password, meta: null };
    doc.meta = {
      id, name: title, pageCount: pdf.numPages, size: blob.size, openedAt: Date.now(),
      updatedAt: notes.updatedAt, rec: notes.rec, thumb: meta?.thumb || '', hasFile: !!meta?.hasFile,
    };
    notes.onChange = onNotesChange;

    $('home').hidden = true;
    $('work').hidden = false;
    $('doc-title').textContent = title;
    document.title = `${title} — PadNote`;
    renderTools();
    renderHistory();
    renderRec();
    await viewer.open(pdf);

    // 3) 최근 문서에 등록(실패해도 필기는 계속된다)
    persistOpen(doc, replace ? notes.toJSON().pages : null);
    if (embedded) toast('필기를 편집 가능한 상태로 복원했습니다');
    else if (COARSE && !settings.hinted) {
      settings.hinted = true; saveSettings();
      toast('Apple Pencil로 바로 필기하세요. 손가락으로 쓰려면 ☝ 버튼을 켜세요.', 5000);
    }
  } catch (err) {
    console.error(err);
    try { await ctx.task?.destroy(); } catch { /* 이미 정리됨 */ }
    doc = null;
    showHome();
    if (err?.name === 'PasswordException' || /destroyed/i.test(String(err?.message))) toast('열기를 취소했습니다');
    else if (err?.name === 'InvalidPDFException') toast('PDF 파일이 아니거나 손상된 파일입니다', 4000);
    else toast(`문서를 열지 못했습니다: ${err?.message || err}`, 5000);
  } finally {
    busy(false);
  }
}

async function persistOpen(d, replacePages) {
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    if (replacePages) await store.replaceInk(d.id, replacePages, d.meta);
    else await store.putMeta(d.meta);
    if (!d.meta.hasFile) {
      await store.putFile(d.id, d.blob);
      d.meta.hasFile = true;
      await store.putMeta(d.meta);
    }
    if (!d.meta.thumb) {
      d.meta.thumb = await makeThumb(d.pdf);
      if (doc === d) await store.putMeta(d.meta);
    }
  } catch (err) {
    warnStorage(err);
  }
}

async function makeThumb(pdf) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 300 / base.width });
  const canvas = el('canvas', { width: Math.round(viewport.width), height: Math.round(viewport.height) });
  await page.render({ canvas, viewport }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.72);
  canvas.width = canvas.height = 0;
  return url;
}

function warnStorage(err) {
  console.warn('브라우저 저장소 오류', err);
  if (saveWarned) return;
  saveWarned = true;
  toast('이 브라우저에는 자동 저장이 되지 않습니다. 작업을 마치면 꼭 PDF로 저장하세요.', 6000);
}

async function openFromLibrary(id) {
  let blob = null, meta = null;
  try {
    [blob, meta] = await Promise.all([store.getFile(id), store.getMeta(id)]);
  } catch (err) { console.warn(err); }
  if (!blob) { toast('보관된 원본이 없습니다. PDF 파일을 다시 열어 주세요.', 4000); return; }
  await openBlob(blob, meta?.name || '문서');
}

async function closeDoc() {
  const d = doc;
  if (!d) return;
  exitPlayback();
  input.abort();
  d.notes.stopRec();
  clearInterval(recTimer);
  doc = null; // 닫는 도중 다시 호출돼도 한 번만 정리되도록 먼저 비운다
  viewer.close();
  await flushSave(d);
  try { await d.task.destroy(); } catch { /* 이미 정리됨 */ }
}

function showHome() {
  $('work').hidden = true;
  $('home').hidden = false;
  document.title = 'PadNote — PDF 필기';
  renderRecent();
}

// ── 자동 저장 ───────────────────────────────────────────
function onNotesChange(pages, info) {
  if (!doc) return;
  if (info.kind === 'add') viewer.appendStroke(info.page, info.stroke);
  else for (const p of pages) viewer.redrawInk(p);
  if (info.kind === 'rec') renderRec();
  for (const p of pages) dirty.add(p);
  renderHistory();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(), 700);
}

async function flushSave(d = doc) {
  clearTimeout(saveTimer);
  if (!d) return;
  const entries = [...dirty].map((p) => [p, d.notes.all(p)]);
  dirty.clear();
  const json = d.notes.toJSON();
  d.meta.updatedAt = json.updatedAt;
  d.meta.rec = json.rec;
  try {
    await store.saveInk(d.id, entries, d.meta);
  } catch (err) {
    warnStorage(err);
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', () => { flushSave(); });

// ── 내보내기(통합 저장) ─────────────────────────────────
let lastExport = null;

async function exportPdf() {
  if (!doc || busyCount) return;
  busy(true, 'PDF 만드는 중…');
  try {
    const { notes, pdf } = doc;
    const pages = [];
    for (const i of [...notes.pages.keys()].sort((a, b) => a - b)) {
      const strokes = notes.visible(i);
      if (!strokes.length || i >= pdf.numPages) continue;
      const page = await pdf.getPage(i + 1);
      pages.push({ index: i, ref: page.ref, inv: invertMatrix(page.getViewport({ scale: 1 }).transform), strokes });
    }
    const L = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
    const orig = new Uint8Array(await doc.blob.arrayBuffer());
    const out = await buildExport(L, orig, { pages, notes: notes.toJSON(), password: doc.password, hlAlpha: HL_ALPHA });
    lastExport = new File(out.parts, `${doc.name}-필기.pdf`, { type: 'application/pdf' });
  } catch (err) {
    console.error(err);
    toast(`PDF를 만들지 못했습니다: ${err?.message || err}`, 6000);
    return;
  } finally {
    busy(false);
  }
  await deliver(lastExport, true);
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 터치 기기: 공유 시트("파일에 저장"). 그 밖이거나 실패하면 다운로드. */
async function deliver(file, auto) {
  const canShare = COARSE && !!navigator.canShare?.({ files: [file] });
  if (!canShare) { download(file); toast('PDF를 저장했습니다'); return; }
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err?.name === 'AbortError') return; // 사용자가 공유 시트를 닫음
    if (auto && err?.name === 'NotAllowedError') {
      // 파일을 만드는 동안 탭 동작의 유효 시간이 지났다 → 한 번 더 눌러 공유 시트를 띄운다.
      const pick = await ask({
        title: 'PDF가 준비되었습니다',
        body: `${file.name}\n“파일에 저장”을 고르면 파일 앱에 저장됩니다.`,
        buttons: [{ label: '닫기', value: null }, { label: '다운로드', value: 'dl' }, { label: '공유 · 파일에 저장', value: 'share', kind: 'main' }],
      });
      if (pick === 'share') return deliver(file, false);
      if (pick === 'dl') download(file);
      return;
    }
    console.warn('공유 실패 → 다운로드', err);
    download(file);
  }
}

// ── 녹화·재생 ───────────────────────────────────────────
function renderRec() {
  const on = !!doc?.notes.recording;
  $('rec-btn').setAttribute('aria-pressed', String(on));
  clearInterval(recTimer);
  const tick = () => { $('rec-time').textContent = on ? fmtTime(doc.notes.time()) : ''; };
  tick();
  if (on) recTimer = setInterval(tick, 500);
}

function toggleRec() {
  if (!doc || playback) return;
  const n = doc.notes;
  if (n.recording) { n.stopRec(); toast(`녹화를 멈췄습니다 (전체 ${fmtTime(n.rec.duration)})`); }
  else { n.startRec(); toast('녹화 중 — 필기와 지우기가 시간과 함께 기록됩니다'); }
}

function enterPlayback() {
  if (!doc || playback) return;
  const n = doc.notes;
  n.stopRec();
  if (n.rec.duration <= 0) { toast('녹화된 필기가 없습니다. ● 버튼으로 녹화를 켜고 필기해 보세요.', 4000); return; }
  input.abort();
  hidePopover();
  playback = new Playback(viewer, n, { onTick: renderPlayback });
  playback.speed = settings.speed;
  playback.skip = settings.skip;
  document.body.classList.add('playing');
  $('playbar').hidden = false;
  $('pb-seek').max = String(playback.duration);
  $('pb-total').textContent = fmtTime(playback.duration);
  $('pb-speed').textContent = `${playback.speed}×`;
  $('pb-skip').setAttribute('aria-pressed', String(playback.skip));
  playback.seek(0);
  playback.play();
}

function exitPlayback() {
  if (!playback) return;
  playback.destroy();
  playback = null;
  document.body.classList.remove('playing');
  $('playbar').hidden = true;
  viewer.redrawAllInk();
}

let seeking = false;
function renderPlayback(pb) {
  if (!seeking) $('pb-seek').value = String(Math.round(pb.t));
  $('pb-time').textContent = fmtTime(pb.t);
  const want = pb.playing ? 'pause' : 'play';
  const btn = $('pb-toggle');
  if (btn.dataset.icon !== want) { btn.dataset.icon = want; btn.innerHTML = icon(want); }
}

// ── 최근 문서 ───────────────────────────────────────────
async function renderRecent() {
  let docs = [];
  try { docs = await store.listDocs(); } catch (err) { console.warn(err); }
  const list = $('recent-list');
  list.textContent = '';
  $('recent').hidden = docs.length === 0;
  const fmt = new Intl.DateTimeFormat('ko', { month: 'short', day: 'numeric' });
  for (const m of docs) {
    const thumb = el('div', { className: 'doc-thumb' });
    if (m.thumb) thumb.style.backgroundImage = `url(${m.thumb})`;
    const open = el('button', { type: 'button', className: 'doc-open' },
      thumb,
      el('div', { className: 'doc-name', textContent: m.name }),
      el('div', { className: 'doc-sub', textContent: `${m.pageCount}쪽 · ${fmt.format(new Date(m.openedAt))}` }));
    open.addEventListener('click', () => openFromLibrary(m.id));
    const del = el('button', { type: 'button', className: 'doc-del', title: '목록에서 삭제', innerHTML: icon('close') });
    del.setAttribute('aria-label', `${m.name} 삭제`);
    del.addEventListener('click', async () => {
      const ok = await ask({
        title: '이 문서를 삭제할까요?',
        body: `“${m.name}”의 보관된 원본과 필기가 이 기기에서 지워집니다. 따로 저장한 PDF 파일은 그대로 남습니다.`,
        buttons: [{ label: '취소', value: false }, { label: '삭제', value: true, kind: 'danger' }],
      });
      if (!ok) return;
      try { await store.deleteDoc(m.id); } catch (err) { console.warn(err); }
      renderRecent();
    });
    list.append(el('div', { className: 'doc' }, open, del));
  }
}

// ── 이벤트 연결 ─────────────────────────────────────────
$('open-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) openBlob(file, file.name);
});
for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => { e.preventDefault(); $('home').classList.add('drag'); });
}
window.addEventListener('dragleave', () => $('home').classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('home').classList.remove('drag');
  const file = [...(e.dataTransfer?.files || [])].find((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (file) openBlob(file, file.name);
});

$('back-btn').addEventListener('click', async () => { await closeDoc(); showHome(); });
for (const b of document.querySelectorAll('.tool')) {
  b.addEventListener('click', () => {
    if (settings.tool === b.dataset.tool) showSizePopover();
    else setTool(b.dataset.tool);
  });
}
$('size-btn').addEventListener('click', showSizePopover);
$('undo-btn').addEventListener('click', () => doc?.notes.undo());
$('redo-btn').addEventListener('click', () => doc?.notes.redo());
$('finger-btn').addEventListener('click', () => {
  setFinger(!settings.finger);
  toast(settings.finger ? '손가락 필기 켬 — 두 손가락으로 이동·확대' : '손가락 필기 끔 — 한 손가락은 스크롤');
});
$('settings-btn').addEventListener('click', showSettingsPopover);
$('opt-pressure').addEventListener('change', (e) => { settings.pressure = e.target.checked; saveSettings(); });
$('opt-swipe').addEventListener('change', (e) => {
  setSwipeErase(e.target.checked);
  if (e.target.checked) toast('손가락 지우개 모드 켬 — 가로로 쓸면 지우고, 세로는 스크롤');
});
for (const b of $('opt-bar').children) {
  b.addEventListener('click', () => {
    settings.barPos = b.dataset.v;
    saveSettings();
    applyBarPos();
    renderSettings();
    placePopover($('settings-pop'), $('settings-btn'));
  });
}
$('refresh-btn').addEventListener('click', refreshApp);
for (const b of $('opt-smooth').children) {
  b.addEventListener('click', () => { settings.smooth = Number(b.dataset.v); saveSettings(); renderSettings(); });
}
$('rec-btn').addEventListener('click', toggleRec);
$('play-btn').addEventListener('click', enterPlayback);
$('export-btn').addEventListener('click', exportPdf);
$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
$('zoom-val').addEventListener('click', () => viewer.zoomFit());
$('page-pill').addEventListener('click', async () => {
  if (!doc) return;
  const r = await ask({
    title: '페이지 이동',
    body: `1–${viewer.n} 사이의 쪽 번호`,
    input: { type: 'number', inputMode: 'numeric', value: String(viewer.current + 1) },
    buttons: [{ label: '취소', value: false }, { label: '이동', value: true, kind: 'main' }],
  });
  const n = parseInt(r.text, 10);
  if (r.value && n >= 1) viewer.scrollToPage(n - 1);
});

$('pb-toggle').addEventListener('click', () => playback?.toggle());
$('pb-close').addEventListener('click', exitPlayback);
$('pb-speed').addEventListener('click', () => {
  if (!playback) return;
  settings.speed = SPEEDS[(SPEEDS.indexOf(playback.speed) + 1) % SPEEDS.length];
  playback.speed = settings.speed;
  saveSettings();
  $('pb-speed').textContent = `${settings.speed}×`;
});
$('pb-skip').addEventListener('click', () => {
  if (!playback) return;
  settings.skip = playback.skip = !playback.skip;
  saveSettings();
  $('pb-skip').setAttribute('aria-pressed', String(playback.skip));
});
$('pb-seek').addEventListener('input', (e) => { seeking = true; playback?.pause(); playback?.seek(Number(e.target.value)); });
$('pb-seek').addEventListener('change', () => { seeking = false; });
$('pb-clear').addEventListener('click', async () => {
  if (!doc) return;
  const ok = await ask({
    title: '녹화 기록을 지울까요?',
    body: '필기는 지금 모습 그대로 남고, 그려진 순서·시간과 지웠던 획의 기록만 사라집니다.',
    buttons: [{ label: '취소', value: false }, { label: '기록 지우기', value: true, kind: 'danger' }],
  });
  if (!ok || !doc) return;
  exitPlayback();
  doc.notes.clearRec();
  renderHistory();
  toast('녹화 기록을 지웠습니다');
});

window.addEventListener('keydown', (e) => {
  if (!doc || e.target.closest?.('input, dialog')) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); if (!playback) { if (e.shiftKey) doc.notes.redo(); else doc.notes.undo(); } }
  else if (mod && key === 'y') { e.preventDefault(); if (!playback) doc.notes.redo(); }
  else if (mod && key === 's') { e.preventDefault(); exportPdf(); }
  else if (mod && (key === '=' || key === '+')) { e.preventDefault(); viewer.zoomBy(1.25); }
  else if (mod && key === '-') { e.preventDefault(); viewer.zoomBy(0.8); }
  else if (mod && key === '0') { e.preventDefault(); viewer.zoomFit(); }
  else if (mod || e.altKey) return;
  else if (playback) { if (key === ' ') { e.preventDefault(); playback.toggle(); } else if (key === 'escape') exitPlayback(); }
  else if (key === 'p') setTool('pen');
  else if (key === 'h') setTool('hl');
  else if (key === 'e') setTool('eraser');
});

// ── 시작 ────────────────────────────────────────────────
setFinger(settings.finger);
applyBarPos();
renderTools();
renderRecent();
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
$('install-tip').hidden = standalone || !/iPad|iPhone|Macintosh/.test(navigator.userAgent) || navigator.maxTouchPoints < 2;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) toast('새 버전을 받았습니다. 앱을 다시 열면 적용됩니다.', 5000);
      });
    });
  }).catch((err) => console.warn('서비스워커 등록 실패', err));
}

// 테스트·디버깅용
window.__padnote = { viewer, input, store, get doc() { return doc; }, get playback() { return playback; }, openBlob, get lastExport() { return lastExport; } };
