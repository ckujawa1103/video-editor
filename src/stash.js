/**
 * A one-slot store for the most recent export, in IndexedDB.
 *
 * Renders happen entirely in the tab, so if Android discards the page before
 * the file has been saved the work is simply gone. Writing the result down the
 * moment it exists means a discarded tab costs a reload, not a re-render.
 */
const DB_NAME = 'pocket-cut';
const STORE = 'last-export';
const KEY = 'result';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    return undefined;
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveResult({ blob, name, kind }) {
  try {
    const db = await open();
    await run(db, 'readwrite', (store) => store.put({ blob, name, kind, at: Date.now() }, KEY));
    db.close();
    return true;
  } catch {
    // Storage can be full or blocked; losing the safety net is not worth
    // failing a render that already succeeded.
    return false;
  }
}

export async function loadResult({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  try {
    const db = await open();
    const row = await run(db, 'readonly', (store) => store.get(KEY));
    db.close();
    if (!row?.blob) return null;
    if (Date.now() - (row.at || 0) > maxAgeMs) return null;
    return row;
  } catch {
    return null;
  }
}

export async function clearResult() {
  try {
    const db = await open();
    await run(db, 'readwrite', (store) => store.delete(KEY));
    db.close();
  } catch {
    /* nothing to clean up */
  }
}
