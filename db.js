// db.js — tiny storage helpers for LifeRPG v4
// Used by app.js: loadState, saveState, clearAll, exportJSON, importJSON

const STORAGE_KEY = "liferpg-state-v4";
const BACKUPS_KEY = "liferpg-backups";
const MAX_BACKUPS = 3;

/* --------------------
   Core helpers
-------------------- */
export async function loadState() {
  // Try main
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn("[db] Corrupt main state, trying backups…", e);
    }
  }

  // Try latest backup
  const backups = getBackups();
  for (const b of backups) {
    try {
      const obj = JSON.parse(b.data);
      console.warn("[db] Restored from backup:", new Date(b.when).toISOString());
      // don't auto-save yet; caller will save after migration/render
      return obj;
    } catch (e) {
      // continue
    }
  }

  // Nothing found
  return null;
}

export async function saveState(state) {
  if (!state || typeof state !== "object") return;
  const json = JSON.stringify(state);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch (e) {
    // If storage is full, try to free by removing oldest backup, then retry once
    console.warn("[db] save failed, pruning backups…", e);
    pruneOneBackup();
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch (e2) {
      console.error("[db] save failed again", e2);
      throw e2;
    }
  }
  // Keep a rolling backup occasionally (every ~10 saves)
  maybeSnapshotBackup(json);
}

export async function clearAll() {
  localStorage.removeItem(STORAGE_KEY);
  // Keep backups for safety; if you want to wipe those too, uncomment:
  // localStorage.removeItem(BACKUPS_KEY);
}

export async function exportJSON() {
  // Prefer current main; if missing, fall back to newest backup
  const main = localStorage.getItem(STORAGE_KEY);
  if (main) return main;

  const backups = getBackups();
  if (backups.length) return backups[0].data;

  // Nothing to export
  return JSON.stringify({});
}

export async function importJSON(text) {
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error("Invalid JSON");
  }
  // Store as-is; app.js will run migration and re-save
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  // snapshot a backup immediately
  pushBackup(JSON.stringify(obj));
  return obj;
}

/* --------------------
   Backups (ring buffer)
-------------------- */
function getBackups() {
  const raw = localStorage.getItem(BACKUPS_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [];
}

function setBackups(arr) {
  try {
    localStorage.setItem(BACKUPS_KEY, JSON.stringify(arr));
  } catch (e) {
    // If even backups can't be saved, drop the oldest and retry once
    try {
      arr.pop();
      localStorage.setItem(BACKUPS_KEY, JSON.stringify(arr));
    } catch (e2) {
      console.warn("[db] Failed to save backups", e2);
    }
  }
}

function pushBackup(data) {
  const arr = getBackups();
  // Put newest first
  arr.unshift({ when: Date.now(), data });
  // Trim to limit
  while (arr.length > MAX_BACKUPS) arr.pop();
  setBackups(arr);
}

function pruneOneBackup() {
  const arr = getBackups();
  if (arr.length > 0) {
    arr.pop();
    setBackups(arr);
  }
}

let _saveCount = 0;
function maybeSnapshotBackup(latestJSON) {
  _saveCount++;
  if (_saveCount % 10 === 0) {
    pushBackup(latestJSON);
  }
}

/* --------------------
   Legacy key migration (best-effort)
   If you previously used another key, add it here.
-------------------- */
(function tryMigrateLegacy() {
  try {
    // Example legacy keys
    const legacyKeys = ["liferpg-state", "lifeRPG", "state"];
    for (const k of legacyKeys) {
      const v = localStorage.getItem(k);
      if (v && !localStorage.getItem(STORAGE_KEY)) {
        console.info("[db] Migrating legacy key:", k);
        localStorage.setItem(STORAGE_KEY, v);
        // keep old as a backup
        pushBackup(v);
        break;
      }
    }
  } catch {}
})();
