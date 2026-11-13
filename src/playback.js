// 녹화 재생. 타임라인 시각 t 에서의 화면을 만든다:
//   - 다 그려진 획(t0+걸린시간 ≤ t, 아직 지워지지 않음)은 페이지 필기 캔버스에,
//   - 그려지는 중인 획은 라이브 캔버스에 dt ≤ t−t0 인 점까지만.
// 앞으로 진행할 때는 새로 끝난 획만 덧그리고, 지우기가 끼거나 뒤로 감으면 해당 페이지를 다시 그린다.

import { strokeDuration, pointsUntil, STRIDE, HL_ALPHA } from './ink.js';

const GAP_MIN = 700; // 이보다 긴 빈 구간은 건너뛴다(ms)
const GAP_LEAD = 200; // 다음 동작 직전에 남겨 둘 여유(ms)

export class Playback {
  constructor(viewer, notes, { onTick }) {
    this.viewer = viewer;
    this.notes = notes;
    this.onTick = onTick;
    this.duration = notes.rec.duration;
    this.t = 0;
    this.speed = 1;
    this.skip = true;
    this.playing = false;
    this.raf = 0;
    this.last = 0;

    this.items = [];
    const spans = [];
    for (const [page, list] of notes.pages) {
      for (const s of list) {
        const start = s.t0 == null ? -1 : s.t0;
        const end = start < 0 ? -1 : start + strokeDuration(s);
        const del = s.deletedAt == null ? Infinity : s.deletedAt;
        this.items.push({ s, page, start, end, del });
        if (start >= 0) spans.push([start, end]);
        if (del !== Infinity) spans.push([del, del]);
      }
    }
    // 활동 구간(겹치는 것은 합친다) — 빈 구간 건너뛰기에 쓴다.
    spans.sort((a, b) => a[0] - b[0]);
    this.spans = [];
    for (const sp of spans) {
      const lastSpan = this.spans[this.spans.length - 1];
      if (lastSpan && sp[0] <= lastSpan[1] + GAP_MIN) lastSpan[1] = Math.max(lastSpan[1], sp[1]);
      else this.spans.push([sp[0], sp[1]]);
    }
  }

  /** 시각 t 에 완성돼 보이는 획(뷰어의 strokesFor 로 연결된다). */
  strokesFor(page) {
    const t = this.t;
    return this.notes.all(page).filter((s) =>
      (s.t0 == null || s.t0 + strokeDuration(s) <= t) && !(s.deletedAt != null && s.deletedAt <= t));
  }

  play() {
    if (this.playing) return;
    if (this.t >= this.duration) this.seek(0);
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((now) => this.frame(now));
    this.onTick(this);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.onTick(this);
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  seek(t) {
    this.t = Math.min(this.duration, Math.max(0, t));
    this.viewer.redrawAllInk();
    this.drawLive(false);
    this.onTick(this);
  }

  destroy() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.viewer.liveClear();
    this.viewer.liveAlpha(1);
  }

  frame(now) {
    if (!this.playing) return;
    const prev = this.t;
    let t = prev + Math.min(100, now - this.last) * this.speed;
    this.last = now;
    if (this.skip) t = this.skipGap(t);
    if (t >= this.duration) t = this.duration;
    this.t = t;
    this.advance(prev, t);
    this.drawLive(true);
    if (t >= this.duration) this.playing = false;
    else this.raf = requestAnimationFrame((n) => this.frame(n));
    this.onTick(this);
  }

  skipGap(t) {
    for (const [a, b] of this.spans) {
      if (t <= b) return a - t > GAP_MIN ? a - GAP_LEAD : t;
    }
    return this.duration; // 남은 동작 없음
  }

  advance(prev, t) {
    const v = this.viewer;
    const dirty = new Set();
    for (const it of this.items) if (it.del > prev && it.del <= t) dirty.add(it.page);
    for (const it of this.items) {
      if (it.end > prev && it.end <= t && it.del > t && !dirty.has(it.page)) v.appendStroke(it.page, it.s);
    }
    for (const page of dirty) v.redrawInk(page);
  }

  drawLive(follow) {
    const v = this.viewer;
    const t = this.t;
    v.liveClear();
    let cur = null;
    for (const it of this.items) {
      if (it.start >= 0 && it.start <= t && t < it.end && it.del > t && (!cur || it.start > cur.start)) cur = it;
    }
    if (!cur) return;
    const n = pointsUntil(cur.s, t - cur.start);
    if (n <= 0) return;
    if (follow) {
      const o = (n - 1) * STRIDE;
      v.reveal(cur.page, cur.s.pts[o], cur.s.pts[o + 1]);
    }
    v.liveAlpha(cur.s.tool === 'hl' ? HL_ALPHA : 1);
    v.liveStroke(cur.page, cur.s, n, 0);
  }
}
