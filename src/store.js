// IndexedDB 저장소. 모든 호출은 실패해도 앱이 계속 돌도록 호출부에서 catch 한다.
//   docs  : id → { id, name, pageCount, size, openedAt, updatedAt, rec, thumb }
//   ink   : `${id}/${page}` → stroke[]
//   files : id → Blob (원본 PDF; 최근 문서에서 다시 열 때 사용)

const DB_NAME = 'padnote';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('ink')) db.createObjectStore('ink');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
});
const inkRange = (id) => IDBKeyRange.bound(`${id}/`, `${id}/￿`);

export async function listDocs() {
  const db = await open();
  const all = await wrap(db.transaction('docs').objectStore('docs').getAll());
  return all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

export async function getMeta(id) {
  const db = await open();
  return wrap(db.transaction('docs').objectStore('docs').get(id));
}

export async function putMeta(meta) {
  const db = await open();
  const tx = db.transaction('docs', 'readwrite');
  tx.objectStore('docs').put(meta);
  return done(tx);
}

/** 저장된 필기를 { pages: {index: strokes} } 로 읽는다. */
export async function loadInk(id) {
  const db = await open();
  const store = db.transaction('ink').objectStore('ink');
  const [keys, values] = await Promise.all([wrap(store.getAllKeys(inkRange(id))), wrap(store.getAll(inkRange(id)))]);
  const pages = {};
  keys.forEach((k, i) => { pages[String(k).slice(id.length + 1)] = values[i]; });
  return pages;
}

/** 바뀐 페이지만 기록한다. entries: [[pageIndex, strokes]] (빈 배열이면 삭제). meta 도 같은 트랜잭션에. */
export async function saveInk(id, entries, meta) {
  const db = await open();
  const tx = db.transaction(['ink', 'docs'], 'readwrite');
  const store = tx.objectStore('ink');
  for (const [page, strokes] of entries) {
    if (strokes.length) store.put(strokes, `${id}/${page}`);
    else store.delete(`${id}/${page}`);
  }
  if (meta) tx.objectStore('docs').put(meta);
  return done(tx);
}

/** 문서의 필기 전체를 교체한다. */
export async function replaceInk(id, pages, meta) {
  const db = await open();
  const tx = db.transaction(['ink', 'docs'], 'readwrite');
  const store = tx.objectStore('ink');
  store.delete(inkRange(id));
  for (const [page, strokes] of Object.entries(pages)) if (strokes.length) store.put(strokes, `${id}/${page}`);
  if (meta) tx.objectStore('docs').put(meta);
  return done(tx);
}

export async function putFile(id, blob) {
  const db = await open();
  try {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, id);
    await done(tx);
  } catch (err) {
    // Blob 저장이 안 되는 환경(일부 사생활 보호 모드)에서는 ArrayBuffer 로 재시도한다.
    const buf = await blob.arrayBuffer();
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(buf, id);
    await done(tx);
  }
}

export async function getFile(id) {
  const db = await open();
  const v = await wrap(db.transaction('files').objectStore('files').get(id));
  if (!v) return null;
  return v instanceof Blob ? v : new Blob([v], { type: 'application/pdf' });
}

export async function deleteDoc(id) {
  const db = await open();
  const tx = db.transaction(['docs', 'ink', 'files'], 'readwrite');
  tx.objectStore('docs').delete(id);
  tx.objectStore('ink').delete(inkRange(id));
  tx.objectStore('files').delete(id);
  return done(tx);
}
