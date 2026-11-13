// 브라우저 종단 검증(Chromium, Playwright). 실행:
//   python3 tests/make-fixtures.py tests/fixtures && node tests/e2e.test.mjs
// iPad Safari 고유 동작(Apple Pencil, 공유 시트)은 여기서 확인할 수 없다. 펜·터치는 CDP 합성 입력으로 흉내 낸다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fx = (name) => path.join(root, 'tests/fixtures', name);
const outDir = process.env.OUT_DIR || path.join(root, 'tests/out');
fs.mkdirSync(outDir, { recursive: true });

// ── 정적 서버 ───────────────────────────────────────────
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const problems = [];
let step = '';
const ok = (msg) => console.log(`ok ${step} — ${msg}`);

async function newPage(opts) {
  const ctx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${step}] pageerror: ${e.stack || e}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${step}] console.error: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${step}] HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base);
  return page;
}
const state = (page, fn, arg) => page.evaluate(fn, arg);
const opened = (page) => page.waitForFunction(() =>
  __padnote.doc && document.getElementById('busy').hidden && !document.getElementById('work').hidden &&
  document.querySelector('.page')?.classList.contains('ready'), null, { timeout: 20000 });
async function openFile(page, file) {
  await page.waitForSelector('#home:not([hidden])');
  await page.setInputFiles('#file-input', file);
  await opened(page);
}
async function drag(page, pts, steps = 6) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1], { steps });
  await page.mouse.up();
}
const clearLibrary = (page) => state(page, async () => {
  for (const d of await __padnote.store.listDocs()) await __padnote.store.deleteDoc(d.id);
});
const visible = (page, i = 0) => state(page, (n) => __padnote.doc.notes.visible(n).length, i);
/** 화면 좌표의 캔버스 픽셀 [r,g,b,a]. sel = 'c-ink' | 'c-pdf' … (페이지 0 기준) */
const pixel = (page, sel, x, y, pageIndex = 0) => state(page, ({ sel, x, y, pageIndex }) => {
  const c = document.querySelectorAll('.page')[pageIndex].querySelector(`canvas.${sel}`);
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const px = Math.floor(((x - r.left) / r.width) * c.width), py = Math.floor(((y - r.top) / r.height) * c.height);
  return [...c.getContext('2d').getImageData(px, py, 1, 1).data];
}, { sel, x, y, pageIndex });
async function exportTo(page, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  const file = path.join(outDir, name);
  await dl.saveAs(file);
  return file;
}
function qpdfCheck(file) {
  try {
    const out = execFileSync('python3', ['-c', 'import sys,pikepdf\np=pikepdf.open(sys.argv[1]);print(len(p.check_pdf_syntax()))', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(out.trim(), '0', 'qpdf 구문 검사');
    return ' qpdf✓';
  } catch (e) {
    if (!/ModuleNotFoundError|ENOENT/.test(String(e.stderr || e.code))) throw e;
    return '';
  }
}

try {
  // ═══ 데스크톱(마우스) ═══════════════════════════════════
  const page = await newPage({ viewport: { width: 1100, height: 800 } });

  step = '열기';
  await openFile(page, fx('plain.pdf'));
  assert.equal(await state(page, () => __padnote.viewer.n), 3);
  ok('3쪽 문서가 렌더링됨');

  step = '펜·형광펜';
  await drag(page, [[300, 300], [380, 260], [460, 330], [540, 300]]);
  await page.keyboard.press('h');
  await drag(page, [[250, 420], [600, 420]]);
  assert.equal(await visible(page), 2);
  const [pen, hl] = await state(page, () => __padnote.doc.notes.visible(0).map((s) => ({ tool: s.tool, n: s.pts.length / 4, dt: s.pts[s.pts.length - 1] })));
  assert.equal(pen.tool, 'pen'); assert.equal(hl.tool, 'hl');
  assert.ok(pen.n > 5 && pen.dt > 0, '점과 dt 기록');
  assert.ok((await pixel(page, 'c-ink', 300, 300))[3] > 200, '펜 획이 필기 캔버스에 그려짐');
  const hp = await pixel(page, 'c-ink', 400, 420);
  assert.ok(hp[3] > 40 && hp[3] < 160, `형광펜은 반투명(${hp})`);
  assert.equal((await pixel(page, 'c-ink', 700, 600))[3], 0, '빈 곳은 투명');
  ok('마우스로 펜/형광펜 획, 반투명 렌더링');

  step = '지우개·실행취소';
  await page.keyboard.press('e');
  await drag(page, [[420, 240], [420, 360]]);
  assert.equal(await visible(page), 1, '획 지우개');
  assert.equal((await pixel(page, 'c-ink', 300, 300))[3], 0, '지운 획은 화면에서 사라짐');
  await page.click('#undo-btn');
  assert.equal(await visible(page), 2);
  assert.deepEqual(await state(page, () => __padnote.doc.notes.visible(0).map((s) => s.tool)), ['pen', 'hl'], '되살린 획은 원래 순서로');
  await page.click('#redo-btn');
  assert.equal(await visible(page), 1);
  await page.click('#undo-btn');
  await page.click('#undo-btn');
  assert.equal(await visible(page), 1, '형광펜 추가까지 취소');
  await page.click('#redo-btn');
  assert.equal(await visible(page), 2);
  await page.keyboard.press('p');
  ok('지우기/실행취소/다시실행');

  step = '내보내기';
  const exported = await exportTo(page, 'e2e-plain.pdf');
  const bytes = fs.readFileSync(exported);
  const orig = fs.readFileSync(fx('plain.pdf'));
  assert.ok(bytes.subarray(0, orig.length).equals(orig), '원본 바이트가 앞에 그대로');
  assert.match(bytes.subarray(-200).toString('latin1'), /%PadNote:1 o=\d{12}/);
  ok(`통합 PDF 다운로드 (${orig.length} → ${bytes.length} bytes)${qpdfCheck(exported)}`);

  step = '자동 저장';
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForSelector('#recent-list .doc');
  await page.click('.doc-open');
  await opened(page);
  assert.equal(await visible(page), 2, 'IndexedDB 에서 복원');
  ok('새로고침 후 최근 문서에서 필기 복원');

  step = '다시 열기';
  await page.click('#back-btn');
  await page.waitForSelector('#home:not([hidden])');
  await page.click('.doc-del');
  await page.click('#dlg-actions .danger');
  await page.waitForFunction(() => document.getElementById('recent').hidden);
  await openFile(page, exported);
  assert.equal(await visible(page), 2, '첨부 데이터에서 획 복원');
  assert.equal(await state(page, () => __padnote.doc.blob.size), orig.length, '필기 stream 이 빠진 원본으로 열림');
  assert.equal(await state(page, () => __padnote.doc.name), 'plain');
  await page.keyboard.press('e');
  await drag(page, [[420, 240], [420, 360]]);
  assert.equal(await visible(page), 1, '복원한 획은 다시 편집 가능');
  await page.click('#undo-btn');
  await page.keyboard.press('p');
  ok('통합 PDF 를 열면 편집 가능한 획으로 복원');

  step = '변조된 파일';
  const tampered = path.join(outDir, 'e2e-tampered.pdf');
  fs.writeFileSync(tampered, Buffer.concat([bytes, Buffer.from('\n% edited elsewhere\n')]));
  await page.click('#back-btn');
  await openFile(page, tampered);
  assert.equal(await visible(page), 2, '같은 문서라 이 기기의 자동 저장 필기는 보임');
  assert.equal(await state(page, () => __padnote.doc.blob.size), bytes.length + 20, '잘라내지 않고 일반 PDF로 열림');
  const baked = await pixel(page, 'c-pdf', 300, 300);
  assert.ok(baked[0] < 80 && baked[1] < 80 && baked[2] < 80, `굳은 필기가 PDF 쪽에 보임(${baked})`);
  ok('검증 실패 시 일반 PDF로 열고 필기는 페이지에 굳어 있음');

  step = '녹화·재생';
  await page.click('#back-btn');
  await openFile(page, fx('objstm.pdf'));
  await drag(page, [[200, 500], [300, 500]]); // 녹화 전 획
  await page.click('#rec-btn');
  await page.waitForTimeout(150);
  await drag(page, [[300, 300], [500, 300]], 12);
  await page.waitForTimeout(400);
  await drag(page, [[300, 360], [500, 360]], 12);
  await page.keyboard.press('e');
  await page.waitForTimeout(200);
  await drag(page, [[400, 280], [400, 320]]);
  await page.keyboard.press('p');
  await page.waitForTimeout(100);
  await page.click('#rec-btn');
  const rec = await state(page, () => ({ d: __padnote.doc.notes.rec.duration, all: __padnote.doc.notes.all(0).length, vis: __padnote.doc.notes.visible(0).length, sessions: __padnote.doc.notes.rec.sessions.length }));
  assert.ok(rec.d > 800, `녹화 길이 ${rec.d}`);
  assert.deepEqual([rec.all, rec.vis, rec.sessions], [3, 2, 1], '지운 획은 deletedAt 로 남음');
  await page.click('#play-btn');
  await page.waitForSelector('#playbar:not([hidden])');
  const at = (t) => state(page, (t) => { __padnote.playback.pause(); __padnote.playback.seek(t); return __padnote.playback.strokesFor(0).length; }, t);
  const tl = await state(page, () => __padnote.doc.notes.all(0).map((s) => ({ t0: s.t0, end: s.t0 == null ? null : s.t0 + s.pts[s.pts.length - 1], del: s.deletedAt })));
  assert.equal(await at(0), 1, '처음에는 녹화 전 획만');
  assert.equal(await at(tl[1].end + 1), 2, '첫 획이 끝난 뒤');
  assert.equal(await at(tl[2].end + 1), 3, '두 번째 획까지');
  assert.equal(await at(tl[1].del + 1), 2, '지우는 시점 이후에는 사라짐');
  // 그리는 도중: 라이브 캔버스에 부분 획
  await at(tl[1].t0 + (tl[1].end - tl[1].t0) / 2);
  const liveAlpha = await state(page, () => { const c = document.getElementById('live'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  assert.ok(liveAlpha > 20, '진행 중인 획이 부분적으로 그려짐');
  await at(0);
  await state(page, () => { __padnote.playback.speed = 8; __padnote.playback.play(); });
  await page.waitForFunction(() => !__padnote.playback.playing && __padnote.playback.t >= __padnote.playback.duration, null, { timeout: 15000 });
  assert.equal(await state(page, () => __padnote.playback.strokesFor(0).length), 2, '끝까지 재생하면 최종 상태');
  await page.click('#pb-close');
  assert.equal(await visible(page), 2);
  const recFile = await exportTo(page, 'e2e-rec.pdf');
  await page.click('#back-btn');
  await clearLibrary(page);
  await openFile(page, recFile);
  assert.deepEqual(await state(page, () => [__padnote.doc.notes.all(0).length, __padnote.doc.notes.visible(0).length, __padnote.doc.notes.rec.duration > 800]), [3, 2, true], '시간 정보와 지운 획이 첨부 데이터에 보존');
  ok(`타임라인 ${rec.d}ms 녹화, 탐색·재생·지우기 재현, 통합 파일에 보존${qpdfCheck(recFile)}`);

  step = '확대(detail)';
  const s0 = await state(page, () => __padnote.viewer.scale);
  for (let i = 0; i < 6; i++) await page.click('#zoom-in');
  await page.waitForFunction(() => document.querySelector('.page canvas.c-pdfd'), null, { timeout: 15000 }).catch(() => {});
  const z = await state(page, () => {
    const v = __padnote.viewer, pv = v.views[v.current];
    return { scale: v.scale, base: pv.pdfC.width * pv.pdfC.height, detail: !!pv.detail, dk: pv.detail?.k, full: v.scale * v.dpr, clip: pv.ink.style.clipPath.slice(0, 16) };
  });
  assert.ok(z.scale > s0 * 3.5, '확대됨');
  if (z.detail) {
    assert.ok(Math.abs(z.dk - z.full) < 1e-6, '확대 영역은 화면 해상도');
    assert.match(z.clip, /^polygon\(evenodd/, '기본 필기 캔버스에 구멍');
  }
  await drag(page, [[500, 400], [650, 450]]);
  const cur = await state(page, () => __padnote.viewer.current);
  assert.ok((await pixel(page, z.detail ? 'c-inkd' : 'c-ink', 500, 400, cur))[3] > 200, '확대 상태에서 그린 획');
  await page.click('#zoom-val');
  assert.ok(Math.abs((await state(page, () => __padnote.viewer.scale)) - s0) < 1e-6, '폭 맞춤 복귀');
  ok(`배율 ${z.scale.toFixed(2)} · 기본 캔버스 ${(z.base / 1e6).toFixed(1)}MP · detail=${z.detail}`);

  step = '회전·CropBox';
  await page.click('#back-btn');
  await openFile(page, fx('rotated.pdf'));
  await page.keyboard.press('p');
  await state(page, () => { __padnote.viewer.zoomTo(1, { i: 0, fx: 0, fy: 0 }, 0, 0); __padnote.viewer.scroller.scrollTop = 0; });
  await page.waitForTimeout(500);
  const pr = await state(page, () => { const r = document.querySelector('.page').getBoundingClientRect(); return [r.left, r.top]; });
  await drag(page, [[pr[0] + 200, pr[1] + 150], [pr[0] + 400, pr[1] + 150]]);
  const rotFile = await exportTo(page, 'e2e-rotated.pdf');
  const rotBytes = fs.readFileSync(rotFile);
  const rotPlain = path.join(outDir, 'e2e-rotated-flat.pdf');
  fs.writeFileSync(rotPlain, Buffer.concat([rotBytes, Buffer.from('\n%x\n')]));
  await page.click('#back-btn');
  await clearLibrary(page);
  await openFile(page, rotPlain);
  await state(page, () => { __padnote.viewer.zoomTo(1, { i: 0, fx: 0, fy: 0 }, 0, 0); __padnote.viewer.scroller.scrollTop = 0; });
  await page.waitForFunction(() => { const v = __padnote.viewer; return v.views[0].pdfK === v.baseK(v.views[0]); });
  assert.equal(await visible(page), 0);
  const pr2 = await state(page, () => { const r = document.querySelector('.page').getBoundingClientRect(); return [r.left, r.top]; });
  const on = await pixel(page, 'c-pdf', pr2[0] + 300, pr2[1] + 150);
  const off = await pixel(page, 'c-pdf', pr2[0] + 300, pr2[1] + 170);
  assert.ok(on[0] < 90 && on[1] < 90 && on[2] < 90, `회전 페이지에서 굳은 필기 위치 일치(${on})`);
  assert.ok(off[0] > 200, `획 바깥은 종이색(${off})`);
  ok(`90° 회전 페이지에 그린 획이 내보낸 PDF 의 같은 자리에 그려짐${qpdfCheck(rotFile)}`);

  step = '암호화 PDF';
  await page.click('#back-btn');
  await page.waitForSelector('#home:not([hidden])');
  await page.setInputFiles('#file-input', fx('enc-user.pdf'));
  await page.waitForSelector('#dlg[open] #dlg-input');
  await page.fill('#dlg-input', 'wrong');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /맞지 않습니다/.test(document.getElementById('dlg-body').textContent));
  await page.fill('#dlg-input', 'secret');
  await page.keyboard.press('Enter');
  await opened(page);
  await drag(page, [[300, 300], [500, 320]]);
  const encFile = await exportTo(page, 'e2e-enc.pdf');
  await page.click('#back-btn');
  await openFile(page, encFile); // 복호화된 사본이 원본이 되므로 암호 없이 열린다
  assert.equal(await visible(page), 1);
  ok(`암호 입력 → 필기 → 복호화 사본 기반 통합 PDF${qpdfCheck(encFile)}`);

  step = '구간 읽기';
  await page.click('#back-btn');
  await state(page, () => { window.__padnoteForceRange = true; });
  await openFile(page, fx('big.pdf'));
  await state(page, () => __padnote.viewer.scrollToPage(119));
  await page.waitForFunction(() => document.querySelectorAll('.page')[119].classList.contains('ready'), null, { timeout: 20000 });
  assert.equal(await state(page, () => __padnote.viewer.current), 119);
  const live = await state(page, () => document.querySelectorAll('.page canvas').length);
  assert.ok(live <= 8, `보이는 페이지만 캔버스 보유(${live}개)`);
  await drag(page, [[400, 300], [600, 320]]);
  assert.equal(await visible(page, 119), 1);
  const bigFile = await exportTo(page, 'e2e-big.pdf');
  ok(`120쪽 문서를 Blob 구간 읽기로 열고 마지막 쪽에 필기·내보내기${qpdfCheck(bigFile)}`);
  await page.context().close();

  // ═══ 터치 기기(iPad 크기) ═══════════════════════════════
  const tp = await newPage({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const cdp = await tp.context().newCDPSession(tp);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const penEv = (type, x, y, force) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force });

  step = '터치: 스크롤';
  await openFile(tp, fx('plain.pdf'));
  await touch('touchStart', [[400, 800]]);
  for (let y = 780; y >= 400; y -= 20) await touch('touchMove', [[400, y]]);
  await touch('touchEnd', []);
  await tp.waitForTimeout(300);
  assert.ok((await state(tp, () => __padnote.viewer.scroller.scrollTop)) > 200, '한 손가락은 스크롤');
  assert.equal(await visible(tp), 0, '손가락은 획을 남기지 않음');
  ok('한 손가락 = 스크롤');

  step = '터치: 펜';
  await state(tp, () => { __padnote.viewer.scroller.scrollTop = 0; });
  await tp.waitForTimeout(100);
  const penLine = async () => {
    await penEv('mousePressed', 200, 400, 0.1);
    for (let i = 1; i <= 20; i++) await penEv('mouseMoved', 200 + i * 15, 400 + i * 2, 0.1 + i * 0.04);
    await penEv('mouseReleased', 500, 440, 0);
    return state(tp, () => { const s = __padnote.doc.notes.visible(0).at(-1); const p = []; for (let i = 2; i < s.pts.length; i += 4) p.push(s.pts[i]); return { n: p.length, min: Math.min(...p), max: Math.max(...p), top: __padnote.viewer.scroller.scrollTop }; });
  };
  const flat = await penLine();
  assert.ok(flat.n > 10 && flat.min === 0.5 && flat.max === 0.5, `기본값은 필압 미반영(${flat.min}–${flat.max})`);
  assert.equal(flat.top, 0, '펜은 스크롤하지 않음');
  await tp.tap('#settings-btn');
  await tp.tap('#opt-pressure');
  await tp.tap('#settings-btn');
  const ps = await penLine();
  assert.ok(ps.max - ps.min > 0.3, `설정에서 켜면 필압이 기록됨(${ps.min}–${ps.max})`);
  await tp.click('#undo-btn');
  ok(`펜 = 필기, 필압은 설정에서 켤 때만 반영(${ps.min.toFixed(2)}–${ps.max.toFixed(2)})`);

  step = '획 보정';
  // 정수 픽셀로 양자화된 촘촘한 표본(완만한 사선) → 계단이 남지 않아야 한다.
  const stair = async () => {
    await penEv('mousePressed', 150, 700, 0.5);
    for (let x = 151; x <= 550; x++) await penEv('mouseMoved', x, Math.round(700 + (x - 150) * 0.12), 0.5);
    await penEv('mouseReleased', 550, 748, 0);
    const r = await state(tp, () => {
      const v = __padnote.viewer, s = __padnote.doc.notes.visible(0).at(-1), a = s.pts, pv = v.views[0];
      const [x0, y0] = v.toPage(pv, 150, 700), [x1, y1] = v.toPage(pv, 550, 748);
      const L = Math.hypot(x1 - x0, y1 - y0);
      let dev = 0, turn = 0, prev = null;
      for (let i = 0; i < a.length; i += 4) {
        dev = Math.max(dev, Math.abs((a[i] - x0) * (y1 - y0) - (a[i + 1] - y0) * (x1 - x0)) / L * v.scale);
        if (i) { const ang = Math.atan2(a[i + 1] - a[i - 3], a[i] - a[i - 4]); if (prev != null) turn += Math.abs(ang - prev); prev = ang; }
      }
      return { dev, turn: turn * 180 / Math.PI, endErr: Math.hypot(a.at(-4) - x1, a.at(-3) - y1) * v.scale, startErr: Math.hypot(a[0] - x0, a[1] - y0) * v.scale };
    });
    await tp.click('#undo-btn');
    return r;
  };
  const smooth = await stair();
  await tp.tap('#settings-btn');
  await tp.tap('#opt-smooth [data-v="0"]');
  await tp.tap('#settings-btn');
  const rough = await stair();
  await tp.tap('#settings-btn');
  await tp.tap('#opt-smooth [data-v="2"]');
  await tp.tap('#settings-btn');
  assert.ok(smooth.turn < rough.turn / 3, `방향 떨림이 1/3 이하로(${smooth.turn.toFixed(0)}° vs ${rough.turn.toFixed(0)}°)`);
  assert.ok(smooth.dev < 0.75, `이상적인 직선에서 벗어난 정도 ${smooth.dev.toFixed(2)}px`);
  assert.ok(smooth.startErr < 0.05 && smooth.endErr < 0.05, '획의 시작과 끝은 펜 위치 그대로');
  ok(`계단 입력의 방향 떨림 ${rough.turn.toFixed(0)}° → ${smooth.turn.toFixed(0)}°, 직선 이탈 ${smooth.dev.toFixed(2)}px`);

  step = '터치: 손가락 지우개';
  const nBefore = await visible(tp); // 앞 단계에서 그린 (200,400)→(500,440) 사선 하나
  assert.equal(nBefore, 1);
  const swipe = async (pts) => { await touch('touchStart', [pts[0]]); for (const q of pts.slice(1)) await touch('touchMove', [q]); await touch('touchEnd', []); await tp.waitForTimeout(250); };
  const hLine = []; for (let x = 250; x <= 450; x += 10) hLine.push([x, 420]);
  const vLine = []; for (let y = 800; y >= 500; y -= 15) vLine.push([350, y]);
  await swipe(hLine);
  assert.equal(await visible(tp), nBefore, '모드가 꺼져 있으면 가로 쓸기는 지우지 않음');
  await state(tp, () => { __padnote.viewer.scroller.scrollTop = 0; });
  await tp.tap('#settings-btn');
  await tp.tap('#opt-swipe');
  await tp.tap('#settings-btn');
  await tp.waitForTimeout(700); // 펜 직후의 손바닥 보호 시간
  await swipe(vLine);
  const scrolled = await state(tp, () => __padnote.viewer.scroller.scrollTop);
  assert.ok(scrolled > 150, `세로 쓸기는 스크롤(${scrolled})`);
  assert.equal(await visible(tp), nBefore, '세로 쓸기는 지우지 않음');
  await state(tp, () => { __padnote.viewer.scroller.scrollTop = 0; });
  await tp.waitForTimeout(100);
  await swipe(hLine);
  assert.equal(await visible(tp), nBefore - 1, '가로 쓸기가 획을 지움');
  assert.equal(await state(tp, () => __padnote.viewer.scroller.scrollTop), 0, '가로 쓸기는 스크롤하지 않음');
  await tp.click('#undo-btn');
  assert.equal(await visible(tp), nBefore, '실행취소로 복구');
  // 펜을 쓴 직후에는 손바닥 오작동을 막기 위해 무시
  await penEv('mousePressed', 600, 900, 0.3); await penEv('mouseMoved', 620, 905, 0.3); await penEv('mouseReleased', 620, 905, 0);
  await swipe(hLine);
  assert.equal(await visible(tp), nBefore + 1, '펜 직후의 가로 쓸기는 무시');
  await tp.click('#undo-btn');
  await tp.tap('#settings-btn');
  await tp.tap('#opt-swipe');
  await tp.tap('#settings-btn');
  ok('가로 쓸기 = 지우개, 세로 = 스크롤, 펜 직후에는 무시');

  step = '터치: 핀치';
  const before = await state(tp, () => ({ s: __padnote.viewer.scale, a: __padnote.viewer.anchorAt(410, 600) }));
  await touch('touchStart', [[360, 600], [460, 600]]);
  for (let d = 50; d <= 200; d += 10) await touch('touchMove', [[410 - d, 600], [410 + d, 600]]);
  const mid = await state(tp, () => ({ s: __padnote.viewer.scale, a: __padnote.viewer.anchorAt(410, 600), g: __padnote.viewer.gesturing }));
  await touch('touchEnd', []);
  assert.ok(Math.abs(mid.s / before.s - 4) < 0.05, `거리 4배 → 배율 4배 (${(mid.s / before.s).toFixed(2)})`);
  assert.ok(mid.g, '제스처 중에는 재렌더링 보류');
  assert.ok(Math.abs(mid.a.fx - before.a.fx) < 0.01 && Math.abs(mid.a.fy - before.a.fy) < 0.01 && mid.a.i === before.a.i, '손가락 사이 지점이 고정');
  await tp.waitForFunction(() => { const v = __padnote.viewer; return !v.gesturing && v.views[v.current].detail; }, null, { timeout: 15000 });
  const mem = await state(tp, () => [...document.querySelectorAll('.page canvas')].reduce((n, c) => n + c.width * c.height, 0));
  assert.ok(mem < 40e6, `확대 후 캔버스 총 ${(mem / 1e6).toFixed(1)}MP`);
  assert.equal(await visible(tp), 1, '핀치는 획을 남기지 않음');
  ok(`두 손가락 = 확대(4배), 캔버스 총 ${(mem / 1e6).toFixed(1)}MP`);

  step = '터치: 손가락 필기';
  await tp.click('#zoom-val');
  await tp.tap('#finger-btn');
  await state(tp, () => { __padnote.viewer.scroller.scrollTop = 0; });
  await touch('touchStart', [[300, 700]]);
  for (let x = 320; x <= 600; x += 20) await touch('touchMove', [[x, 700]]);
  await touch('touchEnd', []);
  assert.equal(await visible(tp), 2, '손가락 필기 모드에서는 한 손가락이 획');
  assert.equal(await state(tp, () => __padnote.viewer.scroller.scrollTop), 0);
  // 두 번째 손가락이 닿으면 진행 중인 획을 버리고 확대로 전환
  await touch('touchStart', [[300, 800]]);
  await touch('touchMove', [[330, 800]]);
  await touch('touchStart', [[330, 800], [500, 800]]);
  await touch('touchMove', [[300, 800], [530, 800]]);
  await touch('touchEnd', []);
  assert.equal(await visible(tp), 2, '핀치로 바뀐 손가락 획은 버려짐');
  ok('손가락 필기 토글, 두 손가락은 여전히 확대');
  await tp.screenshot({ path: path.join(outDir, 'e2e-touch.png') });

  step = '새로고침';
  await tp.waitForTimeout(900);
  await tp.tap('#settings-btn');
  await Promise.all([tp.waitForEvent('load'), tp.tap('#refresh-btn')]);
  await tp.waitForSelector('#home:not([hidden]) #recent-list .doc');
  await tp.tap('.doc-open');
  await opened(tp);
  assert.equal(await visible(tp), 2, '새로고침 뒤에도 필기 유지');
  ok('설정의 새로고침 → 앱을 다시 불러오고 필기는 그대로');
  await tp.context().close();

  // ═══ 서비스워커(오프라인) ═══════════════════════════════
  step = '오프라인';
  const ctx = await browser.newContext();
  const sp = await ctx.newPage();
  await sp.goto(base);
  await sp.evaluate(() => navigator.serviceWorker.ready);
  await sp.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  await sp.waitForFunction(async () => (await (await caches.open((await caches.keys())[0])).keys()).length > 150, null, { timeout: 60000 });
  // 서비스워커가 있는 상태의 새로고침: 캐시된 앱 파일을 다시 받아 넣고 다시 불러온다
  await sp.setInputFiles('#file-input', fx('plain.pdf'));
  await opened(sp);
  let refetched = 0;
  sp.on('request', (r) => { if (/\/src\/app\.js$/.test(r.url())) refetched++; });
  await sp.click('#settings-btn');
  await Promise.all([sp.waitForEvent('load'), sp.click('#refresh-btn')]);
  await sp.waitForSelector('#home:not([hidden])');
  assert.ok(refetched >= 1, '새로고침이 앱 파일을 다시 받음');
  assert.ok(await sp.evaluate(async () => (await (await caches.open((await caches.keys())[0])).keys()).length > 150), '캐시 유지');
  await ctx.setOffline(true);
  await sp.reload();
  await sp.setInputFiles('#file-input', fx('plain.pdf'));
  await opened(sp);
  ok('캐시만으로 앱이 뜨고 PDF 가 열림');
  await ctx.close();
} catch (err) {
  console.error(`\n실패 [${step}]`, err);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
if (problems.length) {
  console.error('\n브라우저 오류:\n' + problems.join('\n'));
  process.exitCode = 1;
}
if (!process.exitCode) console.log('모든 브라우저 검증 통과');
