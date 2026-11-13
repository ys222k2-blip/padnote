// 문서 하나의 필기 상태: 페이지별 획, 실행취소 스택, 녹화 타임라인.
//
// 녹화 타임라인은 "녹화 중이던 시간"만 이어 붙인 시계다(rec.duration ms).
//  - 녹화 중 그린 획: t0 = 타임라인 시각, 점마다 dt.
//  - 녹화 중 지우기/실행취소: 획을 없애지 않고 deletedAt 을 찍는다 → 재생 때 사라지는 것도 재현.
//  - 녹화 중 되살리기(지우기 취소/다시 실행): 그 시각에 한 번에 나타나는 사본(inst)을 만든다.
//  - 녹화가 꺼져 있으면 지우기는 실제 삭제. 이미 타임라인이 있으면 새 획은 끝 시각에 inst 로 붙는다.

const UNDO_LIMIT = 300;

export class Notes {
  constructor(id) {
    this.id = id;
    this.name = '';
    this.pages = new Map(); // pageIndex → stroke[]
    this.rec = { duration: 0, sessions: [] };
    this.updatedAt = 0;
    this.recording = false;
    this._recT = 0; // 녹화 시작 시점의 타임라인 시각
    this._recP = 0; // 녹화 시작 시점의 performance.now()
    this._recAt = 0;
    this.undoStack = [];
    this.redoStack = [];
    /** (pages:Set<number>, info:{kind:'add'|'redraw'|'rec', page?, stroke?}) */
    this.onChange = () => {};
  }

  // ── 조회 ──────────────────────────────────────────────
  all(page) { return this.pages.get(page) || []; }
  visible(page) {
    const list = this.pages.get(page);
    return list ? list.filter((s) => s.deletedAt == null) : [];
  }
  get isEmpty() {
    for (const list of this.pages.values()) if (list.length) return false;
    return true;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ── 녹화 시계 ─────────────────────────────────────────
  /** 현재 타임라인 시각(ms). */
  time() {
    return this.recording ? this._recT + (performance.now() - this._recP) : this.rec.duration;
  }
  startRec() {
    if (this.recording) return;
    this.recording = true;
    this._recT = this.rec.duration;
    this._recP = performance.now();
    this._recAt = Date.now();
    this.onChange(new Set(), { kind: 'rec' });
  }
  stopRec() {
    if (!this.recording) return;
    const end = Math.round(this.time());
    this.recording = false;
    if (end > this._recT) {
      this.rec.sessions.push({ at: this._recAt, t: this._recT, len: end - this._recT });
      this.rec.duration = end;
      this._touch();
    }
    this.onChange(new Set(), { kind: 'rec' });
  }
  /** 녹화 기록을 지운다: 시간 정보와 지워진 획(묘비)을 버리고 현재 모습만 남긴다. */
  clearRec() {
    this.stopRec();
    const pages = new Set();
    for (const [page, list] of this.pages) {
      const kept = list.filter((s) => s.deletedAt == null);
      for (const s of kept) { delete s.t0; delete s.inst; }
      this.pages.set(page, kept);
      pages.add(page);
    }
    this.rec = { duration: 0, sessions: [] };
    this.undoStack = [];
    this.redoStack = [];
    this._touch();
    this.onChange(pages, { kind: 'redraw' });
  }
  /** 새 획에 찍을 시간 필드. 획을 시작할 때 호출한다. */
  stamp() {
    if (this.recording) return { t0: Math.round(this.time()) };
    if (this.rec.duration > 0) return { t0: this.rec.duration, inst: 1 };
    return {};
  }

  // ── 편집 ──────────────────────────────────────────────
  add(page, stroke) {
    this._list(page).push(stroke);
    this._push({ k: 'add', page, s: stroke });
    this._touch();
    this.onChange(new Set([page]), { kind: 'add', page, stroke });
  }

  /** items: [{page, s}] */
  erase(items) {
    if (!items.length) return;
    const act = { k: 'del', items: items.map(({ page, s }) => ({ page, s })) };
    this._hide(act);
    this._push(act);
    this._touch();
    this.onChange(new Set(items.map((i) => i.page)), { kind: 'redraw' });
  }

  undo() {
    const act = this.undoStack.pop();
    if (!act) return;
    if (act.k === 'add') this._hide(act); else this._show(act);
    this.redoStack.push(act);
    this._after(act);
  }

  redo() {
    const act = this.redoStack.pop();
    if (!act) return;
    if (act.k === 'add') this._show(act); else this._hide(act);
    this.undoStack.push(act);
    this._after(act);
  }

  _items(act) { return act.k === 'add' ? [act] : act.items; }

  _hide(act) {
    const items = this._items(act);
    if (this.recording) {
      const t = Math.round(this.time());
      for (const it of items) it.s.deletedAt = t;
      act.tomb = true;
    } else {
      // 뒤에서부터 빼야 저장해 둔 인덱스가 되돌릴 때 유효하다.
      for (const it of items) it.at = this._list(it.page).indexOf(it.s);
      for (const it of [...items].sort((a, b) => b.at - a.at)) {
        if (it.at >= 0) this._list(it.page).splice(it.at, 1);
      }
      act.tomb = false;
    }
  }

  _show(act) {
    const items = this._items(act);
    if (act.tomb) {
      if (this.recording) {
        const t = Math.round(this.time());
        for (const it of items) {
          const copy = { ...it.s, t0: t, inst: 1 };
          delete copy.deletedAt;
          this._list(it.page).push(copy);
          it.s = copy;
        }
      } else {
        for (const it of items) delete it.s.deletedAt;
      }
    } else {
      for (const it of [...items].sort((a, b) => a.at - b.at)) {
        const list = this._list(it.page);
        list.splice(it.at >= 0 ? Math.min(it.at, list.length) : list.length, 0, it.s);
      }
    }
  }

  _after(act) {
    this._touch();
    this.onChange(new Set(this._items(act).map((i) => i.page)), { kind: 'redraw' });
  }
  _list(page) {
    let list = this.pages.get(page);
    if (!list) this.pages.set(page, (list = []));
    return list;
  }
  _push(act) {
    this.undoStack.push(act);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  _touch() { this.updatedAt = Date.now(); }

  // ── 직렬화 ────────────────────────────────────────────
  toJSON() {
    const pages = {};
    for (const [page, list] of this.pages) if (list.length) pages[page] = list;
    const rec = this.recording
      ? { duration: Math.round(this.time()), sessions: [...this.rec.sessions, { at: this._recAt, t: this._recT, len: Math.round(this.time()) - this._recT }] }
      : this.rec;
    return { app: 'padnote', v: 1, id: this.id, name: this.name, updatedAt: this.updatedAt, rec, pages };
  }

  load(data) {
    this.pages = new Map();
    for (const [k, list] of Object.entries(data.pages || {})) {
      const page = Number(k);
      if (!Number.isInteger(page) || page < 0 || !Array.isArray(list)) continue;
      const ok = list.filter(validStroke);
      if (ok.length) this.pages.set(page, ok);
    }
    const d = Number(data.rec?.duration) || 0;
    this.rec = { duration: d, sessions: Array.isArray(data.rec?.sessions) ? data.rec.sessions : [] };
    this.updatedAt = Number(data.updatedAt) || 0;
    this.undoStack = [];
    this.redoStack = [];
  }
}

function validStroke(s) {
  return (
    s && (s.tool === 'pen' || s.tool === 'hl') &&
    typeof s.color === 'string' && s.size > 0 &&
    Array.isArray(s.pts) && s.pts.length >= 4 && s.pts.length % 4 === 0 &&
    s.pts.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}
