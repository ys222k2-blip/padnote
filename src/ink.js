// 획(stroke) 기하·렌더링·판정. 캔버스와 PDF 내보내기가 같은 경로 생성기를 공유한다.
//
// 획 = { tool:'pen'|'hl', color:'#rrggbb', size, pts:[x,y,p,dt, ...], t0?, deletedAt?, inst? }
//   좌표는 pdf.js 뷰포트(scale 1) 기준: 원점 좌상단, y 아래 방향, 단위 pt.
//   p = 필압(0..1), dt = 획 시작 기준 ms.

export const STRIDE = 4;
export const HL_ALPHA = 0.38;
const P_LEVELS = 20; // 필압 양자화 단계 수(굵기 구간을 묶어 경로 수를 줄인다). 0.5 가 정확히 표현된다.

export const quantP = (p) => Math.round(Math.min(1, Math.max(0, p)) * P_LEVELS) / P_LEVELS;
export const round2 = (v) => Math.round(v * 100) / 100;

export function pointCount(s) {
  return (s.pts.length / STRIDE) | 0;
}

function widthOf(s, p) {
  return s.tool === 'hl' ? s.size : s.size * (0.55 + 0.9 * p); // p=0.5(필압 끔)이면 정확히 size
}

/**
 * 획의 조각 [from, to)를 sink로 흘려보낸다. n = 현재 점 개수.
 * 조각 i 는 점 i 주변 구간: 앞뒤 중점을 잇는 2차 곡선(양 끝은 직선).
 * 굵기가 같은 연속 조각은 한 경로로 묶인다.
 */
export function trace(sink, s, n = pointCount(s), from = 0, to = n) {
  const a = s.pts;
  if (n <= 0) return;
  if (n === 1) {
    if (from > 0) return;
    sink.begin(widthOf(s, a[2]));
    sink.moveTo(a[0], a[1]);
    sink.lineTo(a[0] + 0.01, a[1]);
    sink.end();
    return;
  }
  let open = false;
  let curW = -1;
  for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
    const o = i * STRIDE;
    const x = a[o], y = a[o + 1];
    const w = widthOf(s, a[o + 2]);
    let sx, sy, ex, ey;
    if (i === 0) { sx = x; sy = y; } else { sx = (a[o - 4] + x) / 2; sy = (a[o - 3] + y) / 2; }
    if (i === n - 1) { ex = x; ey = y; } else { ex = (x + a[o + 4]) / 2; ey = (y + a[o + 5]) / 2; }
    if (!open || w !== curW) {
      if (open) sink.end();
      sink.begin(w);
      sink.moveTo(sx, sy);
      open = true;
      curW = w;
    }
    if (i === 0 || i === n - 1) sink.lineTo(ex, ey);
    else sink.quadTo(x, y, ex, ey);
  }
  if (open) sink.end();
}

class CanvasSink {
  constructor(ctx) { this.ctx = ctx; }
  begin(w) { this.ctx.beginPath(); this.ctx.lineWidth = w; }
  moveTo(x, y) { this.ctx.moveTo(x, y); }
  lineTo(x, y) { this.ctx.lineTo(x, y); }
  quadTo(cx, cy, x, y) { this.ctx.quadraticCurveTo(cx, cy, x, y); }
  end() { this.ctx.stroke(); }
}

/** 캔버스에 획을 그린다. flat=true 면 형광펜도 불투명하게(라이브 캔버스용, CSS opacity 로 처리). */
export function drawStroke(ctx, s, { n, from, to, flat = false } = {}) {
  ctx.strokeStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const alpha = s.tool === 'hl' && !flat ? HL_ALPHA : 1;
  if (alpha !== 1) ctx.globalAlpha = alpha;
  trace(new CanvasSink(ctx), s, n, from, to);
  if (alpha !== 1) ctx.globalAlpha = 1;
}

const f2 = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

class PdfSink {
  constructor(out) { this.out = out; this.x = 0; this.y = 0; }
  begin(w) { this.out.push(`${f2(w)} w`); }
  moveTo(x, y) { this.out.push(`${f2(x)} ${f2(y)} m`); this.x = x; this.y = y; }
  lineTo(x, y) { this.out.push(`${f2(x)} ${f2(y)} l`); this.x = x; this.y = y; }
  quadTo(cx, cy, x, y) {
    const k = 2 / 3;
    this.out.push(
      `${f2(this.x + k * (cx - this.x))} ${f2(this.y + k * (cy - this.y))} ` +
      `${f2(x + k * (cx - x))} ${f2(y + k * (cy - y))} ${f2(x)} ${f2(y)} c`,
    );
    this.x = x; this.y = y;
  }
  end() { this.out.push('S'); }
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 획 목록을 PDF content stream 연산자로. gsName = 형광펜용 ExtGState 리소스 이름. */
export function strokesToPdfOps(strokes, gsName) {
  const out = ['1 J 1 j'];
  for (const s of strokes) {
    const [r, g, b] = hexToRgb(s.color).map((v) => f2(v / 255));
    const hl = s.tool === 'hl';
    if (hl) out.push(`q /${gsName} gs`);
    out.push(`${r} ${g} ${b} RG`);
    trace(new PdfSink(out), s);
    if (hl) out.push('Q');
  }
  return out.join('\n');
}

const boxes = new WeakMap();

/** [minX, minY, maxX, maxY] (굵기 포함). 획은 확정 후 불변이므로 캐시한다. */
export function bbox(s) {
  let b = boxes.get(s);
  if (b) return b;
  const a = s.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < a.length; i += STRIDE) {
    if (a[i] < x0) x0 = a[i];
    if (a[i] > x1) x1 = a[i];
    if (a[i + 1] < y0) y0 = a[i + 1];
    if (a[i + 1] > y1) y1 = a[i + 1];
  }
  const m = (s.tool === 'hl' ? s.size : s.size * 1.45) / 2;
  b = [x0 - m, y0 - m, x1 + m, y1 + m];
  boxes.set(s, b);
  return b;
}

function distSqToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** 점 (x,y) 반경 r 안에 획이 닿는지. */
export function hitStroke(s, x, y, r) {
  const b = bbox(s);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const a = s.pts;
  const n = pointCount(s);
  if (n === 1) {
    const d = r + widthOf(s, a[2]) / 2;
    return (a[0] - x) ** 2 + (a[1] - y) ** 2 <= d * d;
  }
  for (let i = 1; i < n; i++) {
    const o = i * STRIDE;
    const d = r + widthOf(s, a[o + 2]) / 2;
    if (distSqToSeg(x, y, a[o - 4], a[o - 3], a[o], a[o + 1]) <= d * d) return true;
  }
  return false;
}

/** 획이 그려지는 데 걸린 시간(ms). */
export function strokeDuration(s) {
  return s.inst ? 0 : s.pts[s.pts.length - 1] || 0;
}

/** 획 시작 후 ms 경과 시점까지 찍힌 점 개수. */
export function pointsUntil(s, ms) {
  const a = s.pts;
  const n = pointCount(s);
  let lo = 0, hi = n; // dt 는 단조 증가
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid * STRIDE + 3] <= ms) lo = mid + 1; else hi = mid;
  }
  return lo;
}
