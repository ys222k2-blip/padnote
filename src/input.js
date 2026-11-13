// 입력 처리.
//   펜(Apple Pencil)  → 필기 (필압, getCoalescedEvents)
//   마우스            → 항상 필기
//   한 손가락         → 브라우저 기본 스크롤 (손가락 필기 모드에서는 필기)
//   두 손가락         → 확대/이동 (직접 처리)
//
// iPad Safari 에서는 펜도 터치처럼 스크롤을 일으키므로, 펜 터치는 touchstart 에서
// preventDefault 로 스크롤을 막고 Pointer Events 로 획을 받는다.

import { quantP, round2, hitStroke, pointCount, HL_ALPHA } from './ink.js';

const ERASER_RADIUS = 11; // 화면 px
const MIN_STEP = 0.75; // 점 간 최소 거리(화면 px)
const SMOOTH_PX = [0, 1.5, 3, 6]; // 획 보정 단계(끔·약·보통·강)별로 펜 뒤를 따라오는 거리(화면 px)
const SWIPE_SLOP = 10; // 손가락 지우개: 방향을 판정하기까지의 이동 거리(화면 px)
const SWIPE_RATIO = 1.5; // 가로 이동이 세로의 이 배수 이상이면 지우개
const PALM_MS = 500; // 펜을 쓴 직후 이 시간 동안은 손가락 지우개를 무시(손바닥 오작동 방지)
const PRESSURE_PX = 8; // 필압이 굵기에 반영되는 데 걸리는 거리(화면 px)

export class Input {
  /**
   * @param viewer
   * @param o.getTool   () → { tool:'pen'|'hl'|'eraser', color, size }
   * @param o.getNotes  () → Notes | null
   * @param o.fingerDraw () → boolean
   * @param o.swipeErase () → boolean (한 손가락 가로 쓸기를 지우개로 쓸지)
   * @param o.pressure   () → boolean (필압을 굵기에 반영할지)
   * @param o.smoothLevel () → 0..3 (획 보정 단계)
   * @param o.locked    () → boolean (재생 중 등 편집 금지)
   * @param o.onPen     펜 입력을 처음 감지했을 때
   * @param o.onFingerBlocked 손가락으로 그으려 했지만 필기 모드가 아닐 때(안내용)
   */
  constructor(viewer, o) {
    Object.assign(this, o);
    this.viewer = viewer;
    this.el = viewer.scroller;
    this.active = null; // 진행 중인 획/지우기
    this.pinch = null;
    this.cand = null; // 손가락 지우개 후보(아직 가로/세로를 판정하지 못한 터치)
    this.lastPen = -1e9;
    this.pending = new Set(); // 지우개가 지나가며 숨긴 획(손을 뗄 때 확정)
    this.lastDown = { type: '', t: 0 };
    this.penSeen = false;
    this.wheelTimer = 0;

    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e, false));
    el.addEventListener('pointercancel', (e) => this.onUp(e, true));
    el.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    el.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dragstart', (e) => e.preventDefault());
    // Safari 전용 제스처 이벤트: 페이지 전체가 확대되는 것을 막고, 트랙패드 핀치는 직접 처리한다.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => this.onGesture(e), { passive: false });
    }
    viewer.onLiveInvalidate = () => this.redrawLive();
  }

  /** 지우개가 숨긴 획을 뺀 표시용 목록. */
  filter(strokes) {
    return this.pending.size ? strokes.filter((s) => !this.pending.has(s)) : strokes;
  }

  // ── Pointer Events: 필기 ──────────────────────────────
  onDown(e) {
    this.lastDown = { type: e.pointerType, t: e.timeStamp };
    if (e.pointerType === 'pen') this.lastPen = e.timeStamp;
    if (e.pointerType === 'pen' && !this.penSeen) { this.penSeen = true; this.onPen?.(); }
    const notes = this.getNotes();
    if (!notes || this.locked() || this.active || this.pinch) return;
    const type = e.pointerType;
    if (type === 'mouse') {
      if (e.button !== 0) return;
    } else if (type === 'touch') {
      if (!e.isPrimary) return;
      if (!this.fingerDraw()) {
        // 손가락 지우개: 일단 후보로만 두고, 움직인 방향을 보고 정한다(세로면 브라우저가 스크롤).
        if (this.swipeErase() && e.timeStamp - this.lastPen > PALM_MS) {
          this.cand = { id: e.pointerId, x: e.clientX, y: e.clientY };
        }
        return;
      }
    } else if (type !== 'pen') {
      return;
    }
    const pv = this.viewer.pageAt(e.clientX, e.clientY);
    if (!pv) return;
    if (type !== 'touch') e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* 일부 환경에서 실패해도 무방 */ }

    const tool = this.getTool();
    const erasing = tool.tool === 'eraser' || (type === 'pen' && (e.buttons & 32) !== 0);
    const a = { id: e.pointerId, type, erasing, pv, rect: this.el.getBoundingClientRect(), stamp: e.timeStamp };
    this.active = a;
    if (erasing) {
      a.items = [];
      a.last = null;
      this.eraseAt(e);
    } else {
      a.stroke = { tool: tool.tool, color: tool.color, size: tool.size, ...notes.stamp(), pts: [] };
      a.drawn = 0;
      a.p = e.pressure || 0.25;
      this.viewer.liveAlpha(tool.tool === 'hl' ? HL_ALPHA : 1);
      this.addPoint(a, e, true);
      this.drawLive(a);
    }
  }

  onMove(e) {
    if (this.cand && e.pointerId === this.cand.id && !this.active) this.judgeSwipe(e);
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    if (a.type === 'pen') this.lastPen = e.timeStamp;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const events = list && list.length ? list : [e];
    if (a.erasing) {
      for (const ev of events) this.eraseAt(ev);
    } else {
      for (const ev of events) this.addPoint(a, ev, false);
      this.drawLive(a);
    }
  }

  /** 손가락 지우개 후보가 충분히 움직였으면 가로(지우개)인지 세로(스크롤)인지 정한다. */
  judgeSwipe(e) {
    const c = this.cand;
    const dx = e.clientX - c.x, dy = e.clientY - c.y;
    if (Math.hypot(dx, dy) < SWIPE_SLOP) return;
    this.cand = null;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return; // 세로: 스크롤
    if (this.pinch || this.locked() || !this.getNotes() || e.timeStamp - this.lastPen < PALM_MS) return;
    try { this.el.setPointerCapture(c.id); } catch { /* 무시 */ }
    this.active = {
      id: c.id, type: 'touch', erasing: true, rect: this.el.getBoundingClientRect(),
      items: [], last: { x: c.x, y: c.y },
    };
  }

  /** 지우개가 숨겨 둔 획을 확정하지 않고 되돌린다. */
  restorePending(a) {
    const pages = new Set(a.items.map((i) => i.page));
    this.pending.clear();
    for (const p of pages) this.viewer.redrawInk(p);
  }

  onUp(e, cancelled) {
    if (this.cand?.id === e.pointerId) this.cand = null;
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    this.active = null;
    if (a.type === 'pen') this.lastPen = e.timeStamp;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* 이미 해제됨 */ }
    const notes = this.getNotes();
    if (a.erasing) {
      this.viewer.liveClear();
      // 손가락 지우개 도중 브라우저가 스크롤로 가져갔다면 지우지 않은 것으로 한다.
      if (cancelled && a.type === 'touch') { this.restorePending(a); return; }
      const items = a.items;
      this.pending.clear();
      if (notes && items.length) notes.erase(items);
      return;
    }
    // 손가락 획이 취소됐다면(스크롤·핀치로 전환) 버린다. 펜/마우스는 받은 데까지 확정한다.
    if (cancelled && a.type === 'touch') { this.viewer.liveClear(); return; }
    if (!cancelled) this.addPoint(a, e, true);
    this.viewer.liveClear();
    this.viewer.liveAlpha(1);
    if (notes && pointCount(a.stroke) > 0) notes.add(a.pv.i, a.stroke);
  }

  /** 진행 중인 손가락 획을 버린다(두 번째 손가락이 닿아 핀치로 바뀔 때). */
  abort() {
    this.cand = null;
    const a = this.active;
    if (!a) return;
    this.active = null;
    try { this.el.releasePointerCapture(a.id); } catch { /* 무시 */ }
    this.viewer.liveClear();
    this.viewer.liveAlpha(1);
    if (a.erasing && this.pending.size) this.restorePending(a);
  }

  /**
   * 점 하나를 획에 더한다.
   * 화면 좌표는 (특히 iPad Safari 에서) 정수 픽셀로 들어오는데, 이를 촘촘히 그대로 이으면
   * 계단 모양으로 자글거린다. 그래서 "지나온 거리" 기준의 2단 저역 필터로 다듬는다:
   * 속도와 무관하게 펜 뒤를 SMOOTH_PX 만큼만 따라오므로 느린 획도 빠른 획도 같은 정도로 매끈해진다.
   * 펜을 뗄 때(force)는 실제 위치까지 이어 획 끝이 짧아지지 않게 한다.
   */
  addPoint(a, ev, force) {
    const { pv, stroke } = a;
    const s = this.viewer.scale;
    const cx = ev.clientX, cy = ev.clientY;
    const len = SMOOTH_PX[this.smoothLevel()] ?? SMOOTH_PX[2];
    let moved = 0;
    if (a.rx === undefined) {
      a.f1x = a.f2x = cx; a.f1y = a.f2y = cy;
    } else {
      moved = Math.hypot(cx - a.rx, cy - a.ry);
      if (force || len <= 0) {
        a.f1x = a.f2x = cx; a.f1y = a.f2y = cy;
      } else {
        const k = 1 - Math.exp(-moved / (len / 2));
        a.f1x += (cx - a.f1x) * k; a.f1y += (cy - a.f1y) * k;
        a.f2x += (a.f1x - a.f2x) * k; a.f2y += (a.f1y - a.f2y) * k;
      }
    }
    a.rx = cx; a.ry = cy;

    let p = 0.5;
    if (a.type === 'pen' && this.pressure()) {
      const raw = ev.pressure > 0 ? ev.pressure : a.p; // 펜을 떼는 순간의 0 은 무시
      a.p += (raw - a.p) * Math.max(0.08, 1 - Math.exp(-moved / PRESSURE_PX)); // 굵기가 출렁이지 않게 천천히 따라간다
      p = a.p;
    }

    let [x, y] = this.viewer.toPage(pv, a.f2x, a.f2y, a.rect);
    x = Math.min(pv.w, Math.max(0, x));
    y = Math.min(pv.h, Math.max(0, y));
    const pts = stroke.pts;
    const n = pts.length;
    if (n) {
      const dx = (x - pts[n - 4]) * s, dy = (y - pts[n - 3]) * s;
      const d2 = dx * dx + dy * dy;
      if (force ? d2 < 0.01 : d2 < MIN_STEP * MIN_STEP) return;
    }
    const dt = Math.max(n ? pts[n - 1] : 0, Math.round(ev.timeStamp - a.stamp));
    pts.push(round2(x), round2(y), quantP(p), dt);
  }

  drawLive(a) {
    const n = pointCount(a.stroke);
    if (!n) return;
    // 마지막 조각은 다음 점이 오면 모양이 바뀌므로 매번 다시 그리고, 그 앞까지만 확정으로 센다.
    this.viewer.liveStroke(a.pv.i, a.stroke, n, a.drawn);
    a.drawn = Math.max(0, n - 1);
  }

  /** 스크롤·확대로 화면이 움직였을 때 진행 중인 획을 처음부터 다시 그린다. */
  redrawLive() {
    const a = this.active;
    if (!a || a.erasing) return;
    a.rect = this.el.getBoundingClientRect();
    this.viewer.liveClear();
    a.drawn = 0;
    this.drawLive(a);
  }

  // ── 획 지우개 ─────────────────────────────────────────
  eraseAt(ev) {
    const a = this.active;
    const v = this.viewer;
    const notes = this.getNotes();
    v.liveAlpha(1);
    v.liveCursor(ev.clientX, ev.clientY, ERASER_RADIUS);
    const r = ERASER_RADIUS / v.scale;
    const from = a.last || { x: ev.clientX, y: ev.clientY };
    const dist = Math.hypot(ev.clientX - from.x, ev.clientY - from.y);
    const steps = Math.min(24, Math.max(1, Math.ceil(dist / (ERASER_RADIUS * 0.7))));
    const dirty = new Set();
    for (let k = 1; k <= steps; k++) {
      const cx = from.x + ((ev.clientX - from.x) * k) / steps;
      const cy = from.y + ((ev.clientY - from.y) * k) / steps;
      const pv = v.pageAt(cx, cy);
      if (!pv) continue;
      const [x, y] = v.toPage(pv, cx, cy, a.rect);
      for (const s of notes.all(pv.i)) {
        if (s.deletedAt != null || this.pending.has(s)) continue;
        if (hitStroke(s, x, y, r)) {
          this.pending.add(s);
          a.items.push({ page: pv.i, s });
          dirty.add(pv.i);
        }
      }
    }
    a.last = { x: ev.clientX, y: ev.clientY };
    for (const i of dirty) v.redrawInk(i);
  }

  // ── Touch Events: 스크롤 차단과 두 손가락 확대 ─────────
  isStylus(t, e) {
    if (t.touchType) return t.touchType === 'stylus';
    // touchType 이 없는 브라우저: 직전 pointerdown 이 펜이었는지로 판단
    return this.lastDown.type === 'pen' && Math.abs(e.timeStamp - this.lastDown.t) < 80;
  }

  onTouchStart(e) {
    const fingers = [];
    for (const t of e.touches) if (!this.isStylus(t, e)) fingers.push(t);
    let stylus = false;
    for (const t of e.changedTouches) if (this.isStylus(t, e)) stylus = true;

    if (fingers.length >= 2 && !stylus) {
      if (e.cancelable) e.preventDefault();
      this.cand = null;
      if (this.active?.type === 'touch') this.abort();
      if (!this.pinch && fingers.length === 2) this.startPinch(fingers[0], fingers[1]);
      return;
    }
    if (this.locked() || !this.getNotes()) return;
    if (stylus) {
      if (e.cancelable) e.preventDefault(); // 펜은 스크롤이 아니라 필기
    } else if (fingers.length === 1) {
      if (this.fingerDraw()) {
        if (e.cancelable && this.viewer.pageAt(fingers[0].clientX, fingers[0].clientY)) e.preventDefault();
      } else if (!this.penSeen) {
        this.fingerStart = { x: fingers[0].clientX, y: fingers[0].clientY };
      }
    }
  }

  onTouchMove(e) {
    if (this.pinch) {
      if (e.cancelable) e.preventDefault();
      this.movePinch(e);
      return;
    }
    if (this.active && this.active.type !== 'mouse') {
      if (e.cancelable) e.preventDefault();
    }
  }

  onTouchEnd(e) {
    if (this.pinch) {
      const ids = new Set();
      for (const t of e.touches) ids.add(t.identifier);
      if (!ids.has(this.pinch.a) || !ids.has(this.pinch.b)) {
        this.pinch = null;
        this.viewer.endGesture();
      }
      if (e.cancelable) e.preventDefault();
    }
    if (this.fingerStart && e.touches.length === 0) {
      // 펜 없이 손가락으로만 쓰는 사용자가 처음 화면을 탭했을 때 한 번 안내한다.
      const t = e.changedTouches[0];
      if (t && Math.hypot(t.clientX - this.fingerStart.x, t.clientY - this.fingerStart.y) < 8) this.onFingerBlocked?.();
      this.fingerStart = null;
    }
  }

  startPinch(t1, t2) {
    const v = this.viewer;
    const cx = (t1.clientX + t2.clientX) / 2, cy = (t1.clientY + t2.clientY) / 2;
    this.pinch = {
      a: t1.identifier, b: t2.identifier,
      d0: Math.max(1, Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)),
      s0: v.scale,
      anchor: v.anchorAt(cx, cy),
    };
    v.beginGesture();
  }

  movePinch(e) {
    const p = this.pinch;
    let t1 = null, t2 = null;
    for (const t of e.touches) {
      if (t.identifier === p.a) t1 = t;
      else if (t.identifier === p.b) t2 = t;
    }
    if (!t1 || !t2) return;
    const d = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    const cx = (t1.clientX + t2.clientX) / 2, cy = (t1.clientY + t2.clientY) / 2;
    this.viewer.zoomTo(p.s0 * (d / p.d0), p.anchor, cx, cy);
  }

  // ── 데스크톱: Ctrl+휠 / 트랙패드 핀치 ──────────────────
  onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const v = this.viewer;
    if (!v.n) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    v.beginGesture();
    v.zoomTo(v.scale * Math.exp(-dy * 0.01), v.anchorAt(e.clientX, e.clientY), e.clientX, e.clientY);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => v.endGesture(), 180);
  }

  onGesture(e) {
    e.preventDefault();
    const v = this.viewer;
    if (navigator.maxTouchPoints > 0 || !v.n) return; // 터치 기기에서는 Touch Events 쪽에서 처리
    if (e.type === 'gesturestart') {
      this.gs = { s0: v.scale, anchor: v.anchorAt(e.clientX, e.clientY) };
      v.beginGesture();
    } else if (e.type === 'gesturechange' && this.gs) {
      v.zoomTo(this.gs.s0 * e.scale, this.gs.anchor, e.clientX, e.clientY);
    } else if (e.type === 'gestureend') {
      this.gs = null;
      v.endGesture();
    }
  }
}
