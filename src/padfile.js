// 통합 저장 파일 형식.
//
//   [ 원본 PDF 바이트 그대로 ][ 증분 업데이트(incremental update) ]
//
// 증분 구간에는 (1) 필기를 벡터로 그린 페이지별 content stream(/PadNote BMC…EMC 로 표시),
// (2) 획 데이터 JSON(deflate)을 담은 첨부 파일, (3) 구간 위치를 적은 꼬리 마커가 들어간다.
// 다시 열 때는 꼬리 마커를 검증한 뒤 원본 길이에서 잘라내면 원본이 바이트 단위로 복원되고,
// 획은 첨부 데이터에서 편집 가능한 상태로 되살아난다. 다른 앱이 파일을 고쳐 쓰면 마커가
// 맞지 않게 되므로 일반 PDF로 열린다(필기는 페이지에 굳은 채로 보인다).

import { strokesToPdfOps } from './ink.js';

export const DATA_NAME = 'padnote-data.json';
export const FORMAT_VERSION = 1;
const GS_NAME = 'PadNoteHL';
const TAIL_RE =
  /%PadNote:1 o=(\d{12}) d=(\d{12}) n=(\d{12}) z=([01]) t=(\d{12})\r?\nstartxref\s+\d+\s+%%EOF\s*$/;

// 첨부 데이터 맨 앞에 넣는 짧은 자기 설명. 이 파일을 처음 보는 사람이나 AI가
// 별도 안내 없이도 필기 과정을 읽을 수 있게 한다.
const ABOUT = {
  about: '이 PDF 위에 쓴 필기의 전체 과정(획의 좌표와 시간)입니다. 시점별로 획을 다시 그리면 필기 과정을 재현할 수 있습니다.',
  format: {
    pages: '{ 쪽 번호(0부터): [획, ...] }',
    stroke: "{ tool: 'pen'|'hl'(형광펜), color, size(굵기 pt), pts: [x, y, 필압, dt, x, y, 필압, dt, ...], t0?, deletedAt?, inst? }",
    coords: '단위 pt. 화면에 보이는 페이지의 왼쪽 위가 원점, y는 아래 방향',
    time: '단위 ms(녹화 타임라인). 점의 시각 = t0 + dt. t0 없음 = 녹화 전에 그린 획. deletedAt = 지운 시각. inst = t0에 한 번에 나타난 획. rec.duration = 전체 길이',
  },
};

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return s;
};
const ascii = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0) & 255);
const pad12 = (n) => String(n).padStart(12, '0');

async function pipe(blob, transform) {
  return new Uint8Array(await new Response(blob.stream().pipeThrough(transform)).arrayBuffer());
}
const canDeflate = typeof CompressionStream === 'function';

/** 파일 꼬리에서 PadNote 마커를 찾아 검증한다. 없거나 어긋나면 null. */
export async function probe(blob) {
  if (blob.size < 256) return null;
  const tailLen = Math.min(blob.size, 512);
  const tail = latin1(new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer()));
  const m = TAIL_RE.exec(tail);
  if (!m) return null;
  const origLen = Number(m[1]), dataOff = Number(m[2]), dataLen = Number(m[3]), total = Number(m[5]);
  const slack = blob.size - total; // 끝에 붙은 공백 정도만 허용
  if (slack < 0 || slack > 4) return null;
  if (!(origLen > 0 && origLen < dataOff && dataOff + dataLen < total)) return null;
  return { origLen, dataOff, dataLen, z: m[4] === '1', total };
}

/** probe 결과로 첨부된 획 데이터를 읽는다. 검증 실패 시 예외. */
export async function readNotes(blob, info) {
  const part = blob.slice(info.dataOff, info.dataOff + info.dataLen);
  const bytes = info.z
    ? await pipe(part, new DecompressionStream('deflate'))
    : new Uint8Array(await part.arrayBuffer());
  const notes = JSON.parse(new TextDecoder().decode(bytes));
  if (notes?.app !== 'padnote' || notes.origLen !== info.origLen || typeof notes.pages !== 'object') {
    throw new Error('PadNote 데이터가 올바르지 않습니다');
  }
  return notes;
}

function indexOfBytes(hay, needle, from = 0) {
  const n = needle.length;
  if (!n) return -1;
  const first = needle[0];
  outer: for (let i = hay.indexOf(first, from); i !== -1 && i + n <= hay.length; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOfAscii(hay, str) {
  const needle = ascii(str);
  outer: for (let i = hay.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const cmpBytes = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

/** 카탈로그의 EmbeddedFiles 이름 트리에 항목을 추가한다(기존 첨부는 유지, 트리는 평탄화). */
function attach(L, doc, name, specRef) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } = L;
  const ctx = doc.context;
  const N = (s) => PDFName.of(s);
  const asDict = (o) => {
    const v = o instanceof PDFRef ? ctx.lookup(o) : o;
    return v instanceof PDFDict ? v : null;
  };
  const asArray = (o) => {
    const v = o instanceof PDFRef ? ctx.lookup(o) : o;
    return v instanceof PDFArray ? v : null;
  };
  const entries = [];
  const walk = (node, depth) => {
    if (!node || depth > 32) return;
    const names = asArray(node.get(N('Names')));
    if (names) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = names.get(i);
        if (key instanceof PDFString || key instanceof PDFHexString) entries.push([key, names.get(i + 1)]);
      }
    }
    const kids = asArray(node.get(N('Kids')));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(asDict(kids.get(i)), depth + 1);
  };
  const oldNames = asDict(doc.catalog.get(N('Names')));
  if (oldNames) walk(asDict(oldNames.get(N('EmbeddedFiles'))), 0);

  const mine = PDFString.of(name);
  const mineBytes = mine.asBytes();
  const list = entries
    .map(([k, v]) => [k, v, k.asBytes()])
    .filter((e) => cmpBytes(e[2], mineBytes) !== 0);
  list.push([mine, specRef, mineBytes]);
  list.sort((a, b) => cmpBytes(a[2], b[2]));

  const flat = PDFArray.withContext(ctx);
  for (const [k, v] of list) { flat.push(k); flat.push(v); }
  const tree = PDFDict.withContext(ctx);
  tree.set(N('Names'), flat);
  const names = PDFDict.withContext(ctx);
  if (oldNames) for (const [k, v] of oldNames.entries()) names.set(k, v);
  names.set(N('EmbeddedFiles'), ctx.register(tree));
  doc.catalog.set(N('Names'), names);
}

/** 페이지에 필기 content stream 을 덧붙인다. */
function inkPage(L, doc, page, entry, shared) {
  const { PDFName, PDFDict, PDFArray, PDFRef } = L;
  const ctx = doc.context;
  const N = (s) => PDFName.of(s);
  const leaf = page.node;

  let existing = [];
  const contents = leaf.get(N('Contents'));
  const resolved = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  if (resolved instanceof PDFArray) existing = resolved.asArray();
  else if (resolved && contents instanceof PDFRef) existing = [contents];

  const hasHl = entry.strokes.some((s) => s.tool === 'hl');
  const m = entry.inv.map((v) => +v.toFixed(6)).join(' ');
  const body =
    `${existing.length ? 'Q\n' : ''}/PadNote BMC\nq\n${m} cm\n` +
    `${strokesToPdfOps(entry.strokes, GS_NAME)}\nQ\nEMC\n`;
  const inkRef = ctx.register(ctx.flateStream(body));

  const list = PDFArray.withContext(ctx);
  if (existing.length) {
    // 원본 내용이 그래픽 상태를 바꿔 놓아도 필기가 영향받지 않도록 q…Q 로 감싼다.
    shared.q ??= ctx.register(ctx.stream('q\n'));
    list.push(shared.q);
    for (const r of existing) list.push(r);
  }
  list.push(inkRef);
  leaf.set(N('Contents'), list);

  if (hasHl) {
    shared.gs ??= ctx.register(ctx.obj({ Type: 'ExtGState', CA: shared.hlAlpha, ca: shared.hlAlpha }));
    // Resources 는 상속되거나 여러 페이지가 공유할 수 있으므로 얕게 복사해 이 페이지 전용으로 둔다.
    let res = null;
    try { res = leaf.Resources(); } catch { /* 손상된 리소스: 새로 만든다 */ }
    const newRes = PDFDict.withContext(ctx);
    if (res) for (const [k, v] of res.entries()) newRes.set(k, v);
    const newGs = PDFDict.withContext(ctx);
    const oldGs = res?.get(N('ExtGState'));
    const oldGsDict = oldGs instanceof PDFRef ? ctx.lookup(oldGs) : oldGs;
    if (oldGsDict instanceof PDFDict) for (const [k, v] of oldGsDict.entries()) newGs.set(k, v);
    newGs.set(N(GS_NAME), shared.gs);
    newRes.set(N('ExtGState'), newGs);
    leaf.set(N('Resources'), newRes);
  }
}

/**
 * 원본 PDF + 필기 → 통합 파일.
 * @param L        pdf-lib 모듈
 * @param orig     원본 PDF 바이트(Uint8Array). 수정하지 않는다.
 * @param pages    [{ index, ref?:{num,gen}, inv:[a,b,c,d,e,f], strokes:[…] }] — 그릴 획이 있는 페이지만
 * @param notes    첨부할 획 데이터 객체(시간 정보 포함 전체)
 * @param password 암호화된 원본의 암호(있다면)
 * @returns { parts:[Uint8Array…], size, base } — parts 를 이어 붙이면 완성 파일
 */
export async function buildExport(L, orig, { pages, notes, password, hlAlpha }) {
  const { PDFDocument } = L;
  const loadOpts = { forIncrementalUpdate: true, updateMetadata: false, ignoreEncryption: true };
  let base = orig;
  let doc = await PDFDocument.load(base, loadOpts);
  let refsValid = true;
  if (doc.isEncrypted) {
    // 암호화된 원본에는 증분 덧붙이기를 할 수 없으므로, 먼저 복호화한 사본을 새 원본으로 삼는다.
    const plain = await PDFDocument.load(orig, { password: password ?? '', updateMetadata: false });
    delete plain.context.trailerInfo.Encrypt;
    plain.context.security = undefined;
    base = await plain.save();
    doc = await PDFDocument.load(base, loadOpts);
    refsValid = false;
    if (doc.isEncrypted) throw new Error('암호화를 해제하지 못했습니다');
  }
  const ctx = doc.context;
  const snap = ctx.snapshot;
  // 변경 자동 추적은 set() 마다 전체 객체를 훑어 느리므로 끄고, 바뀐 객체를 직접 표시한다.
  ctx.snapshot = undefined;

  const pdfPages = doc.getPages();
  const byRef = new Map(pdfPages.map((p) => [`${p.ref.objectNumber} ${p.ref.generationNumber}`, p]));
  const shared = { hlAlpha };
  for (const entry of pages) {
    if (!entry.strokes.length) continue;
    const page =
      (refsValid && entry.ref && byRef.get(`${entry.ref.num} ${entry.ref.gen}`)) || pdfPages[entry.index];
    if (!page) throw new Error(`페이지 ${entry.index + 1}을(를) 찾을 수 없습니다`);
    inkPage(L, doc, page, entry, shared);
    snap.markRefForSave(page.ref);
  }

  const json = new TextEncoder().encode(JSON.stringify({ ...ABOUT, ...notes, origLen: base.length }));
  const z = canDeflate;
  const data = z ? await pipe(new Blob([json]), new CompressionStream('deflate')) : json;
  const now = L.PDFString.fromDate(new Date());
  const efDict = { Type: 'EmbeddedFile', Subtype: 'application/json', Params: { Size: json.length, ModDate: now } };
  if (z) efDict.Filter = 'FlateDecode';
  const efRef = ctx.register(ctx.stream(data, efDict));
  const specRef = ctx.register(ctx.obj({
    Type: 'Filespec',
    F: L.PDFString.of(DATA_NAME),
    UF: L.PDFHexString.fromText(DATA_NAME),
    Desc: L.PDFHexString.fromText('필기 과정 데이터(획 좌표와 시간). 형식은 JSON 안의 about·format 참고'),
    EF: { F: efRef, UF: efRef },
  }));
  attach(L, doc, DATA_NAME, specRef);
  snap.markRefForSave(ctx.trailerInfo.Root);

  const inc = await doc.saveIncremental(snap, {
    useObjectStreams: !!ctx.pdfFileDetails.useObjectStreams,
    objectsPerTick: 200,
  });

  const at = indexOfBytes(inc, data);
  const sx = lastIndexOfAscii(inc, 'startxref');
  if (at < 0 || sx < 0 || at > sx) throw new Error('내보내기 내부 오류: 데이터 위치를 찾지 못했습니다');
  const tailNl = inc[inc.length - 1] === 10 ? 0 : 1;
  const line = (total) =>
    `%PadNote:1 o=${pad12(base.length)} d=${pad12(base.length + at)} n=${pad12(data.length)} z=${z ? 1 : 0} t=${pad12(total)}\n`;
  const total = base.length + inc.length + line(0).length + tailNl; // 숫자는 고정 폭이라 길이가 변하지 않는다
  const marker = ascii(line(total));
  const parts = [base, inc.subarray(0, sx), marker, inc.subarray(sx)];
  if (tailNl) parts.push(ascii('\n'));
  return { parts, size: total, base };
}

/** pdf.js 뷰포트 변환(PDF→뷰포트)의 역행렬(뷰포트→PDF). */
export function invertMatrix([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
