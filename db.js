// db.js — tiny IndexedDB wrapper for a single "state" object
// Stores everything under DB "liferpg", store "kv", key "state"

const DB_NAME = "liferpg";
const DB_VERSION = 1;
const STORE = "kv";
const KEY = "state";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getRaw(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const st = tx.objectStore(STORE);
    const r = st.get(key);
    r.onsuccess = () => resolve(r.result ? r.result.value : null);
    r.onerror = () => reject(r.error);
  });
}

async function setRaw(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    const r = st.put({ key, value });
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function loadState() {
  const v = await getRaw(KEY);
  if (!v) return null;
  return v;
}

export async function saveState(state) {
  // defensive clone to strip functions
  const safe = JSON.parse(JSON.stringify(state));
  await setRaw(KEY, safe);
}

export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    const r = st.delete(KEY);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// Helpers for export/import
export async function exportJSON() {
  const state = await loadState();
  return JSON.stringify(state ?? {}, null, 2);
}

export async function importJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error("Invalid JSON"); }
  if (!obj || typeof obj !== "object") throw new Error("Invalid data");
  // very light validation
  if (!obj.version) obj.version = 1;
  await saveState(obj);
  return obj;
}
