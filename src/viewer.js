// 페이지 배치·렌더링·확대. 페이지마다 PDF 캔버스와 투명 필기 캔버스를 겹치고,
// 화면 근처 페이지만 그린다. 크게 확대해 전체 페이지 해상도가 메모리 한도를 넘으면
// 기본 캔버스는 낮은 해상도로 두고, 화면에 보이는 영역만 따로 선명하게(detail) 그린다.

import { drawStroke } from './ink.js';

const GAP = 14;
const PAD = 14;
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const MAX_BASE_PX = COARSE ? 5e6 : 16e6; // 페이지 전체 캔버스 픽셀 상한
const MAX_DETAIL_PX = COARSE ? 6e6 : 14e6; // 확대 영역 캔버스 픽셀 상한
const MAX_SCALE = 8;
const SCROLL_SETTLE_MS = 140;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const freeCanvas = (c) => { if (c) { c.remove(); c.width = 0; c.height = 0; } };

export class Viewer {
  /**
   * @param o.scroller   스크롤 컨테이너
   * @param o.pagesEl    페이지들을 담는 요소(scroller 의 자식)
   * @param o.live       그리는 중인 획을 표시하는 화면 고정 캔버스
   * @param o.strokesFor (pageIndex) → 그릴 획 배열
   * @param o.onPage     (pageIndex) 현재 페이지가 바뀔 때
   * @param o.onScale    (scale, fitScale) 배율이 바뀔 때
   */
  constructor(o) {
    Object.assign(this, o);
    this.liveCtx = this.live.getContext('2d');
    this.pdf = null;
    this.gen = 0;
    this.n = 0;
    this.views = [];
    this.Y = [0];
    this.maxW = 1;
    this.scale = 1;
    this.fit = true; // 폭 맞춤 상태(창 크기가 바뀌면 다시 맞춘다)
    this.dpr = 1;
    this.loaded = new Set();
    this.lo = 0; this.hi = -1; this.va = 0; this.vb = -1;
    this.current = -1;
    this.gesturing = false;
    this.job = null;
    this.pumping = false;
    this.lastScroll = 0;
    this.raf = 0;
    this.settleTimer = 0;
    this.onLiveInvalidate = null; // 스크롤/확대로 라이브 캔버스를 다시 그려야 할 때

    this.scroller.addEventListener('scroll', () => {
      this.lastScroll = performance.now();
      this.onLiveInvalidate?.();
      this.schedule();
    }, { passive: true });
    new ResizeObserver(() => this.onResize()).observe(this.scroller);
  }

  // ── 문서 ──────────────────────────────────────────────
  async open(pdf) {
    this.close();
    this.pdf = pdf;
    const gen = ++this.gen;
    this.n = pdf.numPages;
    const first = await pdf.getPage(1);
    if (gen !== this.gen) return;
    const vp = first.getViewport({ scale: 1 });
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this.n; i++) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.n = String(i + 1);
      frag.appendChild(el);
      this.views.push({ i, w: vp.width, h: vp.height, el, pdfC: null, pdfK: 0, failK: 0, ink: null, detail: null, page: null });
    }
    this.pagesEl.appendChild(frag);
    this.recompute();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.resizeLive();
    this.fit = true;
    this.scale = this.fitScale(0);
    this.applyLayout(true);
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.onScale?.(this.scale, this.scale);
    this.update();
    this.measureRest(gen);
  }

  close() {
    this.gen++;
    this.job?.task?.cancel();
    for (const i of this.loaded) this.release(this.views[i]);
    this.loaded.clear();
    this.pagesEl.textContent = '';
    this.views = [];
    this.pdf = null;
    this.n = 0;
    this.current = -1;
    this.liveClear();
  }

  /** 나머지 페이지 크기를 백그라운드로 읽어 배치를 보정한다(대부분의 문서는 크기가 같아 변화 없음). */
  async measureRest(gen) {
    let dirty = false;
    for (let i = 1; i < this.n; i++) {
      let page;
      try { page = await this.pdf.getPage(i + 1); } catch { continue; }
      if (gen !== this.gen) return;
      const vp = page.getViewport({ scale: 1 });
      const pv = this.views[i];
      if (Math.abs(vp.width - pv.w) > 0.01 || Math.abs(vp.height - pv.h) > 0.01) {
        pv.w = vp.width; pv.h = vp.height;
        dirty = true;
      }
      if (dirty && (i % 64 === 0 || i === this.n - 1)) {
        dirty = false;
        this.relayoutKeepingPosition();
      }
    }
  }

  relayoutKeepingPosition() {
    const r = this.scroller.getBoundingClientRect();
    const anchor = this.anchorAt(r.left + r.width / 2, r.top);
    this.recompute();
    this.applyLayout(true);
    this.scroller.scrollTop = this.top(anchor.i) + anchor.fy * this.views[anchor.i].h * this.scale;
    this.update();
  }

  // ── 배치(산술과 CSS 가 같은 식을 쓴다) ─────────────────
  recompute() {
    this.Y = new Array(this.n + 1);
    this.Y[0] = 0;
    let maxW = 1;
    for (let i = 0; i < this.n; i++) {
      this.Y[i + 1] = this.Y[i] + this.views[i].h;
      if (this.views[i].w > maxW) maxW = this.views[i].w;
    }
    this.maxW = maxW;
  }
  top(i) { return PAD + i * GAP + this.scale * this.Y[i]; }
  contentWidth() { return Math.max(this.scroller.clientWidth, this.scale * this.maxW + 2 * PAD); }
  left(i) { return (this.contentWidth() - this.scale * this.views[i].w) / 2; }
  totalHeight() { return 2 * PAD + Math.max(0, this.n - 1) * GAP + this.scale * this.Y[this.n]; }

  applyLayout(full = false) {
    const st = this.pagesEl.style;
    st.setProperty('--s', String(this.scale));
    st.height = `calc(var(--s) * ${this.Y[this.n]}px + ${2 * PAD + Math.max(0, this.n - 1) * GAP}px)`;
    st.width = `max(100%, calc(var(--s) * ${this.maxW}px + ${2 * PAD}px))`;
    if (!full) return;
    for (const pv of this.views) {
      const s = pv.el.style;
      s.top = `calc(var(--s) * ${this.Y[pv.i]}px + ${PAD + pv.i * GAP}px)`;
      s.width = `calc(var(--s) * ${pv.w}px)`;
      s.height = `calc(var(--s) * ${pv.h}px)`;
    }
  }

  fitScale(i = Math.max(0, this.current)) {
    const w = this.views[i]?.w || this.maxW;
    return clamp((this.scroller.clientWidth - 2 * PAD) / w, 0.1, MAX_SCALE);
  }
  minScale() {
    const pv = this.views[Math.max(0, this.current)];
    if (!pv) return 0.1;
    const whole = Math.min(this.fitScale(), (this.scroller.clientHeight - 2 * PAD) / pv.h);
    return Math.max(0.1, whole * 0.5);
  }

  onResize() {
    if (!this.pdf || !this.views.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    this.resizeLive();
    if (this.fit) {
      const r = this.scroller.getBoundingClientRect();
      const anchor = this.anchorAt(r.left + r.width / 2, r.top);
      this.scale = this.fitScale();
      this.applyLayout();
      this.scroller.scrollTop = this.top(anchor.i) + anchor.fy * this.views[anchor.i].h * this.scale;
      this.onScale?.(this.scale, this.scale);
    }
    this.onLiveInvalidate?.();
    this.update();
  }

  // ── 좌표 변환 ─────────────────────────────────────────
  indexAtY(y) {
    let lo = 0, hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.top(mid) <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  /** 화면 좌표 아래의 페이지(없으면 null). */
  pageAt(cx, cy) {
    if (!this.n) return null;
    const r = this.scroller.getBoundingClientRect();
    const x = cx - r.left + this.scroller.scrollLeft;
    const y = cy - r.top + this.scroller.scrollTop;
    const pv = this.views[this.indexAtY(y)];
    const px = (x - this.left(pv.i)) / this.scale;
    const py = (y - this.top(pv.i)) / this.scale;
    return px >= 0 && px <= pv.w && py >= 0 && py <= pv.h ? pv : null;
  }
  /** 화면 좌표 → 페이지 좌표(scale 1). */
  toPage(pv, cx, cy, r = this.scroller.getBoundingClientRect()) {
    return [
      (cx - r.left + this.scroller.scrollLeft - this.left(pv.i)) / this.scale,
      (cy - r.top + this.scroller.scrollTop - this.top(pv.i)) / this.scale,
    ];
  }
  /** 확대 기준점: 화면 좌표가 가리키는 페이지와 그 안에서의 비율 위치. */
  anchorAt(cx, cy) {
    const r = this.scroller.getBoundingClientRect();
    const y = cy - r.top + this.scroller.scrollTop;
    const pv = this.views[this.indexAtY(y)];
    const [px, py] = this.toPage(pv, cx, cy, r);
    return { i: pv.i, fx: px / pv.w, fy: py / pv.h };
  }

  // ── 확대 ──────────────────────────────────────────────
  beginGesture() {
    this.gesturing = true;
    this.job?.task?.cancel();
  }
  endGesture() {
    if (!this.gesturing) return;
    this.gesturing = false;
    this.update();
  }
  /** anchor 가 화면 좌표 (cx,cy)에 오도록 배율을 바꾼다. */
  zoomTo(scale, anchor, cx, cy) {
    if (!this.n) return;
    const s = clamp(scale, this.minScale(), MAX_SCALE);
    this.fit = false;
    this.scale = s;
    this.applyLayout();
    const r = this.scroller.getBoundingClientRect();
    const pv = this.views[anchor.i];
    this.scroller.scrollLeft = this.left(pv.i) + anchor.fx * pv.w * s - (cx - r.left);
    this.scroller.scrollTop = this.top(pv.i) + anchor.fy * pv.h * s - (cy - r.top);
    this.onScale?.(s, this.fitScale());
    this.onLiveInvalidate?.();
    this.schedule();
  }
  /** 화면 중앙 기준으로 배율 변경. */
  zoomBy(factor) {
    const r = this.scroller.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    this.zoomTo(this.scale * factor, this.anchorAt(cx, cy), cx, cy);
  }
  zoomFit() {
    if (!this.n) return;
    const r = this.scroller.getBoundingClientRect();
    const anchor = this.anchorAt(r.left + r.width / 2, r.top);
    this.scale = this.fitScale();
    this.fit = true;
    this.applyLayout();
    this.scroller.scrollLeft = 0;
    this.scroller.scrollTop = this.top(anchor.i) + clamp(anchor.fy, 0, 1) * this.views[anchor.i].h * this.scale;
    this.onScale?.(this.scale, this.scale);
    this.update();
  }
  scrollToPage(i) {
    if (!this.n) return;
    this.scroller.scrollTop = this.top(clamp(i, 0, this.n - 1)) - PAD / 2;
    this.update();
  }
  /** 페이지 좌표 (x,y)가 화면 안쪽에 오도록 필요할 때만 스크롤한다(재생 따라가기). */
  reveal(i, x, y) {
    const sc = this.scroller;
    const px = this.left(i) + x * this.scale - sc.scrollLeft;
    const py = this.top(i) + y * this.scale - sc.scrollTop;
    const mx = Math.min(80, sc.clientWidth / 4), my = Math.min(80, sc.clientHeight / 4);
    if (px < mx || px > sc.clientWidth - mx) sc.scrollLeft += px - sc.clientWidth / 2;
    if (py < my || py > sc.clientHeight - my) sc.scrollTop += py - sc.clientHeight / 2;
  }

  // ── 렌더링 스케줄 ─────────────────────────────────────
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); });
  }

  update() {
    if (!this.pdf || !this.views.length) return;
    const sc = this.scroller;
    const y0 = sc.scrollTop, y1 = y0 + sc.clientHeight;
    let a = this.indexAtY(y0);
    if (a < this.n - 1 && this.top(a) + this.views[a].h * this.scale <= y0) a++;
    let b = this.indexAtY(Math.max(y0, y1 - 1));
    if (b < a) b = a;
    this.va = a; this.vb = b;
    // 화면 위아래로 0.75 화면 높이 안에 걸치는 페이지까지만 미리 그린다.
    // (크게 확대했을 때는 이웃 페이지가 멀리 있으므로 캔버스를 만들지 않아 메모리를 아낀다.)
    const margin = sc.clientHeight * 0.75;
    let lo = a, hi = b;
    while (lo > 0 && this.top(lo - 1) + this.views[lo - 1].h * this.scale > y0 - margin) lo--;
    while (hi < this.n - 1 && this.top(hi + 1) < y1 + margin) hi++;
    this.lo = lo; this.hi = hi;

    const mid = this.indexAtY((y0 + y1) / 2);
    const cur = clamp(mid, a, b);
    if (cur !== this.current) { this.current = cur; this.onPage?.(cur); }

    for (const i of [...this.loaded]) if (i < lo || i > hi) { this.release(this.views[i]); this.loaded.delete(i); }
    if (!this.gesturing) {
      for (let i = lo; i <= hi; i++) {
        const pv = this.views[i];
        this.loaded.add(i);
        this.ensureInk(pv);
        if (pv.detail && !this.detailWant(pv)) this.dropDetail(pv);
      }
    }
    const j = this.job;
    if (j?.task) {
      const stale = this.gesturing || !this.loaded.has(j.pv.i) ||
        (j.kind === 'base' ? this.baseK(j.pv) !== j.k : !this.detailWant(j.pv));
      if (stale) j.task.cancel();
    }
    this.pump();
  }

  /** 기본 캔버스 해상도(px / pt). 캔버스 폭이 정수가 되도록 맞춘다. */
  baseK(pv) {
    const full = this.scale * this.dpr;
    const k = Math.min(full, Math.sqrt(MAX_BASE_PX / (pv.w * pv.h)));
    return Math.max(1, Math.round(pv.w * k)) / pv.w;
  }

  /** 확대 영역이 필요한지: 기본 캔버스가 화면 해상도에 못 미치고, 페이지가 화면에 보일 때. */
  detailWant(pv) {
    const full = this.scale * this.dpr;
    if (pv.i < this.va || pv.i > this.vb || this.baseK(pv) >= full * 0.99) return null;
    const sc = this.scroller, s = this.scale;
    const x0 = clamp((sc.scrollLeft - this.left(pv.i)) / s, 0, pv.w);
    const y0 = clamp((sc.scrollTop - this.top(pv.i)) / s, 0, pv.h);
    const x1 = clamp((sc.scrollLeft + sc.clientWidth - this.left(pv.i)) / s, 0, pv.w);
    const y1 = clamp((sc.scrollTop + sc.clientHeight - this.top(pv.i)) / s, 0, pv.h);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return { k: full, x0, y0, x1, y1 };
  }

  detailRect(pv, want) {
    const sc = this.scroller, s = this.scale;
    let k = want.k, x0, y0, x1, y1;
    for (const m of [0.3, 0.12, 0]) {
      const mx = (sc.clientWidth * m) / s, my = (sc.clientHeight * m) / s;
      x0 = Math.max(0, want.x0 - mx); y0 = Math.max(0, want.y0 - my);
      x1 = Math.min(pv.w, want.x1 + mx); y1 = Math.min(pv.h, want.y1 + my);
      if ((x1 - x0) * (y1 - y0) * k * k <= MAX_DETAIL_PX) break;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area * k * k > MAX_DETAIL_PX) k = Math.sqrt(MAX_DETAIL_PX / area);
    x0 = Math.floor(x0 * k) / k; y0 = Math.floor(y0 * k) / k;
    const cw = Math.max(1, Math.ceil((x1 - x0) * k)), ch = Math.max(1, Math.ceil((y1 - y0) * k));
    return { kWant: want.k, k, x: x0, y: y0, cw, ch, w: cw / k, h: ch / k };
  }

  pickJob() {
    if (this.gesturing || !this.pdf) return null;
    const order = [];
    for (let i = this.lo; i <= this.hi; i++) order.push(this.views[i]);
    const c = this.current;
    order.sort((p, q) => Math.abs(p.i - c) - Math.abs(q.i - c));
    for (const pv of order) {
      const k = this.baseK(pv);
      if (pv.pdfK !== k && pv.failK !== k) return { kind: 'base', pv, k };
    }
    let waiting = false;
    for (const pv of order) {
      const want = this.detailWant(pv);
      if (!want) continue;
      const d = pv.detail;
      const e = 0.5 / want.k;
      if (d && Math.abs(d.kWant - want.k) < 1e-6 && d.x <= want.x0 + e && d.y <= want.y0 + e &&
        d.x + d.w >= want.x1 - e && d.y + d.h >= want.y1 - e) continue;
      if (pv.failK === -want.k) continue;
      if (performance.now() - this.lastScroll < SCROLL_SETTLE_MS) { waiting = true; continue; }
      return { kind: 'detail', pv, ...this.detailRect(pv, want) };
    }
    if (waiting) {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.update(), SCROLL_SETTLE_MS);
    }
    return null;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.pickJob();
        if (!job) break;
        await this.runJob(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  async runJob(job) {
    const { pv } = job;
    const gen = this.gen;
    job.gen = gen;
    this.job = job;
    const canvas = document.createElement('canvas');
    try {
      const page = pv.page || (pv.page = await this.pdf.getPage(pv.i + 1));
      if (gen !== this.gen || !this.loaded.has(pv.i) || this.gesturing) return;
      let transform;
      if (job.kind === 'base') {
        canvas.width = Math.round(pv.w * job.k);
        canvas.height = Math.max(1, Math.round(pv.h * job.k));
      } else {
        canvas.width = job.cw;
        canvas.height = job.ch;
        transform = [1, 0, 0, 1, -job.x * job.k, -job.y * job.k];
      }
      job.task = page.render({ canvas, viewport: page.getViewport({ scale: job.k }), transform });
      await job.task.promise;
      if (gen !== this.gen || !this.loaded.has(pv.i)) return;
      if (job.kind === 'base') this.attachBase(pv, canvas, job.k);
      else this.attachDetail(pv, canvas, job);
      job.done = true;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && gen === this.gen) {
        console.error('페이지 렌더링 실패', pv.i + 1, err);
        pv.failK = job.kind === 'base' ? job.k : -job.kWant;
        pv.el.classList.add('failed');
      }
    } finally {
      if (!job.done) { canvas.width = 0; canvas.height = 0; }
      this.job = null;
    }
  }

  attachBase(pv, canvas, k) {
    canvas.className = 'c-pdf';
    const old = pv.pdfC;
    pv.el.appendChild(canvas);
    freeCanvas(old);
    pv.pdfC = canvas;
    pv.pdfK = k;
    pv.el.classList.add('ready');
  }

  attachDetail(pv, canvas, job) {
    this.dropDetail(pv);
    const pct = (v, of) => `${(v / of) * 100}%`;
    const place = (c) => {
      c.style.left = pct(job.x, pv.w); c.style.top = pct(job.y, pv.h);
      c.style.width = pct(job.w, pv.w); c.style.height = pct(job.h, pv.h);
    };
    canvas.className = 'c-pdfd';
    place(canvas);
    const ink = document.createElement('canvas');
    ink.className = 'c-inkd';
    ink.width = job.cw; ink.height = job.ch;
    ink._t = [job.k, job.k, job.x, job.y];
    place(ink);
    pv.detail = { ...job, pdfC: canvas, ink };
    this.paintInk(pv, ink);
    pv.el.append(canvas, ink);
    // 기본 필기 캔버스에서 확대 영역만큼 구멍을 내 이중으로 겹쳐 보이지 않게 한다.
    if (pv.ink) {
      const i = 0.5 / this.scale; // 경계에 틈이 생기지 않도록 반 픽셀 겹침
      const xa = pct(job.x + i, pv.w), xb = pct(job.x + job.w - i, pv.w);
      const ya = pct(job.y + i, pv.h), yb = pct(job.y + job.h - i, pv.h);
      pv.ink.style.clipPath =
        `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${xa} ${ya}, ${xa} ${yb}, ${xb} ${yb}, ${xb} ${ya}, ${xa} ${ya})`;
    }
  }

  dropDetail(pv) {
    if (!pv.detail) return;
    freeCanvas(pv.detail.pdfC);
    freeCanvas(pv.detail.ink);
    pv.detail = null;
    if (pv.ink) pv.ink.style.clipPath = '';
  }

  release(pv) {
    this.dropDetail(pv);
    freeCanvas(pv.pdfC);
    freeCanvas(pv.ink);
    pv.pdfC = null; pv.pdfK = 0; pv.ink = null; pv.failK = 0;
    pv.el.classList.remove('ready', 'failed');
    try { pv.page?.cleanup(); } catch { /* 렌더링 중이면 무시 */ }
    pv.page = null;
  }

  // ── 필기 캔버스 ───────────────────────────────────────
  ensureInk(pv) {
    const k = this.baseK(pv);
    if (pv.ink && pv.ink._k === k) return;
    const c = document.createElement('canvas');
    c.className = 'c-ink';
    c.width = Math.round(pv.w * k);
    c.height = Math.max(1, Math.round(pv.h * k));
    c._k = k;
    c._t = [c.width / pv.w, c.height / pv.h, 0, 0];
    if (pv.ink) c.style.clipPath = pv.ink.style.clipPath;
    this.paintInk(pv, c);
    const old = pv.ink;
    pv.el.appendChild(c);
    freeCanvas(old);
    pv.ink = c;
  }

  setInkTransform(ctx, c) {
    const [kx, ky, ox, oy] = c._t;
    ctx.setTransform(kx, 0, 0, ky, -ox * kx, -oy * ky);
  }

  paintInk(pv, c) {
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    this.setInkTransform(ctx, c);
    for (const s of this.strokesFor(pv.i)) drawStroke(ctx, s);
  }

  /** 페이지의 필기를 처음부터 다시 그린다. */
  redrawInk(i) {
    const pv = this.views[i];
    if (!pv || !this.loaded.has(i)) return;
    if (pv.ink) this.paintInk(pv, pv.ink);
    if (pv.detail) this.paintInk(pv, pv.detail.ink);
  }
  redrawAllInk() { for (const i of this.loaded) this.redrawInk(i); }

  /** 획 하나를 기존 그림 위에 덧그린다. */
  appendStroke(i, s) {
    const pv = this.views[i];
    if (!pv || !this.loaded.has(i)) return;
    for (const c of [pv.ink, pv.detail?.ink]) {
      if (!c) continue;
      const ctx = c.getContext('2d');
      this.setInkTransform(ctx, c);
      drawStroke(ctx, s);
    }
  }

  // ── 라이브 캔버스(그리는 중인 획, 지우개 커서) ─────────
  resizeLive() {
    const w = this.scroller.clientWidth, h = this.scroller.clientHeight;
    const cw = Math.max(1, Math.round(w * this.dpr)), ch = Math.max(1, Math.round(h * this.dpr));
    if (this.live.width !== cw || this.live.height !== ch) {
      this.live.width = cw; this.live.height = ch;
    }
    this.live.style.width = `${w}px`;
    this.live.style.height = `${h}px`;
  }
  liveClear() {
    this.liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.liveCtx.clearRect(0, 0, this.live.width, this.live.height);
  }
  liveAlpha(a) { this.live.style.opacity = String(a); }
  /** 획의 조각 [from, n) 을 라이브 캔버스에 그린다(불투명; 형광펜 투명도는 liveAlpha 로). */
  liveStroke(i, s, n, from = 0) {
    const pv = this.views[i];
    if (!pv) return;
    const ctx = this.liveCtx, k = this.dpr * this.scale, sc = this.scroller;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, this.dpr * (this.left(i) - sc.scrollLeft), this.dpr * (this.top(i) - sc.scrollTop));
    ctx.beginPath();
    ctx.rect(0, 0, pv.w, pv.h);
    ctx.clip();
    drawStroke(ctx, s, { n, from, flat: true });
    ctx.restore();
  }
  liveCursor(cx, cy, radius) {
    const r = this.scroller.getBoundingClientRect();
    const ctx = this.liveCtx;
    this.liveClear();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(cx - r.left, cy - r.top, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,120,120,0.18)';
    ctx.strokeStyle = 'rgba(60,60,60,0.7)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  }
}
