// 통합 저장 형식 검증 (Node). 실행: python3 tests/make-fixtures.py tests/fixtures && node tests/export.test.mjs
// qpdf(pikepdf)·poppler 가 있으면 독립 리더로도 교차 검증한다.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fx = path.join(root, 'tests/fixtures');
const outDir = process.env.OUT_DIR || path.join(root, 'tests/out');
fs.mkdirSync(outDir, { recursive: true });

const L = await import(path.join(root, 'vendor/pdf-lib/pdf-lib.esm.min.js'));
const pdfjs = await import(path.join(root, 'vendor/pdfjs/pdf.min.mjs'));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(root, 'vendor/pdfjs/pdf.worker.min.mjs');
const { buildExport, probe, readNotes, invertMatrix, DATA_NAME } = await import(path.join(root, 'src/padfile.js'));
const { HL_ALPHA } = await import(path.join(root, 'src/ink.js'));

const pdfjsOpts = {
  standardFontDataUrl: path.join(root, 'vendor/pdfjs/standard_fonts/'),
  cMapUrl: path.join(root, 'vendor/pdfjs/cmaps/'),
  wasmUrl: path.join(root, 'vendor/pdfjs/wasm/'),
  verbosity: 0,
};

function sampleStrokes() {
  const pen = { tool: 'pen', color: '#e03131', size: 3, t0: 100, pts: [] };
  for (let i = 0; i <= 40; i++) pen.pts.push(100 + i * 5, 100, 0.2 + 0.015 * i, i * 8);
  const hl = { tool: 'hl', color: '#ffd43b', size: 14, t0: 900, pts: [] };
  for (let i = 0; i <= 20; i++) hl.pts.push(100 + i * 10, 160 + Math.sin(i / 3) * 4, 0.5, i * 10);
  const dot = { tool: 'pen', color: '#1971c2', size: 6, pts: [60, 60, 0.5, 0] };
  const gone = { tool: 'pen', color: '#000000', size: 2, t0: 50, deletedAt: 2000, pts: [10, 10, 0.5, 0, 50, 50, 0.5, 30] };
  return [pen, hl, dot, gone];
}

async function runCase(name, { password, expectSameBase = true } = {}) {
  const orig = new Uint8Array(fs.readFileSync(path.join(fx, name)));
  const pdf = await pdfjs.getDocument({ data: orig.slice(), password, ...pdfjsOpts }).promise;
  const notes = {
    app: 'padnote', v: 1, id: pdf.fingerprints[0], updatedAt: 1700000000000,
    rec: { duration: 3000, sessions: [] }, pages: {},
  };
  const pages = [];
  for (let i = 0; i < pdf.numPages; i += Math.max(1, Math.floor(pdf.numPages / 3))) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const strokes = sampleStrokes();
    notes.pages[i] = strokes;
    pages.push({ index: i, ref: page.ref, inv: invertMatrix(vp.transform), strokes: strokes.filter((s) => s.deletedAt == null) });
  }
  const numPages = pdf.numPages;
  await pdf.loadingTask.destroy();

  const t0 = performance.now();
  const { parts, size, base } = await buildExport(L, orig, { pages, notes, password, hlAlpha: HL_ALPHA });
  const ms = performance.now() - t0;
  const out = Buffer.concat(parts);
  assert.equal(out.length, size, 'size 일치');
  const outPath = path.join(outDir, name.replace('.pdf', '.padnote.pdf'));
  fs.writeFileSync(outPath, out);

  // 1) 꼬리 마커 → 원본 복원 + 획 복원
  const blob = new Blob([out]);
  const info = await probe(blob);
  assert.ok(info, '마커 감지');
  assert.equal(info.total, out.length);
  const restored = out.subarray(0, info.origLen);
  assert.ok(Buffer.from(restored).equals(Buffer.from(base)), '잘라내면 원본과 동일');
  if (expectSameBase) assert.ok(Buffer.from(base).equals(Buffer.from(orig)), '원본 바이트 보존');
  const back = await readNotes(blob, info);
  assert.deepEqual(back.pages, JSON.parse(JSON.stringify(notes.pages)), '획 데이터 왕복');
  assert.equal(back.rec.duration, 3000);
  assert.ok(back.about && back.format?.stroke && back.format?.time, '첨부 데이터에 형식 설명 포함');

  // 2) 변조 감지: 뒤에 바이트가 붙거나 잘리면 일반 PDF 취급
  assert.equal(await probe(new Blob([out, Buffer.from('\n1 0 obj\n<<>>\nendobj\n')])), null);
  assert.equal(await probe(new Blob([out.subarray(0, out.length - 20)])), null);
  assert.equal(await probe(new Blob([orig])), null);

  // 3) pdf.js 로 다시 열기: 페이지 수, 첨부, 필기 연산자 존재
  const re = await pdfjs.getDocument({ data: new Uint8Array(out), ...pdfjsOpts }).promise;
  assert.equal(re.numPages, numPages);
  const att = await re.getAttachments();
  const mine = att && [...att.values()].find((a) => a.filename === DATA_NAME);
  assert.ok(mine, '첨부 존재');
  const ops = await (await re.getPage(1)).getOperatorList();
  assert.ok(ops.fnArray.includes(pdfjs.OPS.beginMarkedContent), 'BMC 마커');
  await re.loadingTask.destroy();

  // 4) 독립 리더 교차 검증
  let extra = '';
  try {
    const py = `
import sys, json, pikepdf
with pikepdf.open(sys.argv[1]) as p:
    problems = p.check_pdf_syntax()
    names = sorted(p.attachments.keys())
    c = p.pages[0].Contents
    n = len(c) if isinstance(c, pikepdf.Array) else 1
    print(json.dumps({"problems": problems, "names": names, "pages": len(p.pages), "contents": n}))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', py, outPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.deepEqual(r.problems, [], 'qpdf check');
    assert.equal(r.pages, numPages);
    assert.ok(r.names.includes(DATA_NAME));
    extra = ` qpdf✓ attachments=[${r.names}]`;
  } catch (e) {
    if (!/ModuleNotFoundError|ENOENT/.test(String(e.stderr || e.code))) throw e;
    extra = ' (pikepdf 없음: 건너뜀)';
  }
  console.log(`ok ${name.padEnd(14)} ${String(orig.length).padStart(7)} → ${String(out.length).padStart(7)} bytes  ${ms.toFixed(0)}ms${extra}`);
  return outPath;
}

await runCase('plain.pdf');
await runCase('objstm.pdf');
await runCase('linear.pdf');
const rot = await runCase('rotated.pdf');
const att = await runCase('attach.pdf');
await runCase('big.pdf');
await runCase('enc-owner.pdf', { expectSameBase: false });
await runCase('enc-user.pdf', { password: 'secret', expectSameBase: false });

// 다시 내보내기: 복원한 원본에 또 덧붙여도 원본 길이는 그대로
{
  const first = new Uint8Array(fs.readFileSync(att));
  const info = await probe(new Blob([first]));
  const base = first.subarray(0, info.origLen);
  const notes = await readNotes(new Blob([first]), info);
  const pdf = await pdfjs.getDocument({ data: base.slice(), ...pdfjsOpts }).promise;
  const pages = [];
  for (const k of Object.keys(notes.pages)) {
    const page = await pdf.getPage(+k + 1);
    pages.push({ index: +k, ref: page.ref, inv: invertMatrix(page.getViewport({ scale: 1 }).transform), strokes: notes.pages[k].filter((s) => s.deletedAt == null) });
  }
  await pdf.loadingTask.destroy();
  const { parts } = await buildExport(L, base, { pages, notes, hlAlpha: HL_ALPHA });
  const again = Buffer.concat(parts);
  const info2 = await probe(new Blob([again]));
  assert.equal(info2.origLen, info.origLen, '재내보내기 후에도 원본 길이 동일');
  assert.equal(again.length, first.length, '같은 내용이면 같은 크기');
  console.log('ok re-export     원본 길이 유지');
}

// 렌더 검증(poppler): 회전·CropBox 페이지에서 뷰포트 좌표 (200,100) 부근이 빨간 펜 색인지
try {
  const png = path.join(outDir, 'rot');
  execFileSync('pdftoppm', ['-r', '72', '-cropbox', '-png', '-f', '1', '-l', '2', rot, png]);
  const py = `
import sys
from PIL import Image
for f in sys.argv[1:]:
    im = Image.open(f).convert("RGB")
    r, g, b = im.getpixel((200, 100))
    assert r > 180 and g < 110 and b < 110, (f, im.size, (r, g, b))
    r, g, b = im.getpixel((150, 160))
    assert r > 200 and g > 180 and b < 200, ("highlight", f, (r, g, b))
print("ok render       회전/CropBox 페이지에서 필기 위치 일치")
`;
  process.stdout.write(execFileSync('python3', ['-c', py, `${png}-1.png`, `${png}-2.png`], { encoding: 'utf8' }));
} catch (e) {
  if (e.status) { console.error(String(e.stderr || e)); process.exit(1); }
  console.log('(poppler 없음: 렌더 검증 건너뜀)');
}
console.log('모든 내보내기 검증 통과');
