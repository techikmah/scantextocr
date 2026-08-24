// Caches extracted words per page, keyed by a SHA-256 hash of the file's bytes.
// Only text + bounding boxes are stored (small), never the page images themselves.
//
// Also holds a small "settings" store for account/license state (see license.js and
// usage.js), so the extension doesn't need the "storage" permission just for that.

const DB_NAME = "scantext-cache";
const DB_VERSION = 2;
const DOC_STORE = "documents";
const SETTINGS_STORE = "settings";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function hashBuffer(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getCachedDoc(hash) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DOC_STORE, "readonly");
      const req = tx.objectStore(DOC_STORE).get(hash);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // cache is a nice-to-have; never block the app on it failing
  }
}

export async function saveCachedDoc(hash, data) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DOC_STORE, "readwrite");
      tx.objectStore(DOC_STORE).put(data, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore — caching failure shouldn't break scanning
  }
}

export async function getSetting(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SETTINGS_STORE, "readonly");
      const req = tx.objectStore(SETTINGS_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function setSetting(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SETTINGS_STORE, "readwrite");
      tx.objectStore(SETTINGS_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best effort — see callers for how they degrade when this fails
  }
}
