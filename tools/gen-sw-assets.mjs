// sw.js 의 미리 받기 목록을 현재 파일 구성으로 갱신한다. 실행: node tools/gen-sw-assets.mjs
// (파일을 추가·삭제했거나 vendor/ 를 교체했을 때만 필요. vendor 를 바꿨다면 sw.js 의 VERSION 도 올린다.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))
  .filter((f) => !/(^|\/)LICENSE|\.md$/.test(f))
  .sort();

const core = [
  './', 'manifest.webmanifest',
  ...walk('src'), ...walk('icons'),
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/pdf-lib/pdf-lib.esm.min.js',
];
const extra = [...walk('vendor/pdfjs/wasm'), ...walk('vendor/pdfjs/standard_fonts'), ...walk('vendor/pdfjs/iccs'), ...walk('vendor/pdfjs/cmaps')];
const fmt = (list) => `[\n${list.map((f) => `  ${JSON.stringify(f)},`).join('\n')}\n]`;
const file = path.join(root, 'sw.js');
const src = fs.readFileSync(file, 'utf8');
const out = src.replace(/\/\* assets:begin \*\/[\s\S]*\/\* assets:end \*\//,
  `/* assets:begin */\nconst CORE = ${fmt(core)};\nconst EXTRA = ${fmt(extra)};\n/* assets:end */`);
if (out === src && !src.includes('assets:begin')) throw new Error('sw.js 에 assets 표시가 없습니다');
fs.writeFileSync(file, out);
console.log(`CORE ${core.length}개, EXTRA ${extra.length}개`);
