// Browser storage. Maps and settings live in localStorage; the API key lives in
// sessionStorage only (OR-01) and is never part of a map or an export.
import { DEFAULT_MODELS, DEFAULT_DAILY_CAP } from './config.js?v=32d83d848e';

const K = {
  index: 'cs.maps.index',
  map: (id) => `cs.map.${id}`,
  settings: 'cs.settings',
  calls: 'cs.calls',
  key: 'cs.key',
  pkce: 'cs.pkce',
};

function read(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(storage, key) {
  try { storage.removeItem(key); } catch { /* storage unavailable */ }
}

// --- API key (session only) ---
export const getKey = () => read(sessionStorage, K.key, '');
export const setKey = (key) => (key ? write(sessionStorage, K.key, key) : remove(sessionStorage, K.key));
export const getPkce = () => read(sessionStorage, K.pkce, null);
export const setPkce = (v) => (v ? write(sessionStorage, K.pkce, v) : remove(sessionStorage, K.pkce));

// --- Settings ---
export function getSettings() {
  const s = read(localStorage, K.settings, {});
  return {
    models: Array.isArray(s.models) && s.models.length ? s.models : DEFAULT_MODELS,
    dailyCap: Number.isFinite(s.dailyCap) ? s.dailyCap : DEFAULT_DAILY_CAP,
    guessFirst: s.guessFirst !== false,
    theme: s.theme || 'auto',
  };
}
export function saveSettings(patch) {
  write(localStorage, K.settings, { ...getSettings(), ...patch });
}

// --- Calls used today (OR-07) ---
const today = () => new Date().toISOString().slice(0, 10);
export function callsToday() {
  const c = read(localStorage, K.calls, null);
  return c && c.day === today() ? c.count : 0;
}
export function addCall() {
  write(localStorage, K.calls, { day: today(), count: callsToday() + 1 });
}

// --- Maps ---
export function listMaps() {
  return read(localStorage, K.index, []).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function loadMap(id) {
  return read(localStorage, K.map(id), null);
}
export function saveMap(map) {
  map.updatedAt = Date.now();
  const ok = write(localStorage, K.map(map.id), map);
  const index = read(localStorage, K.index, []).filter((m) => m.id !== map.id);
  index.push({ id: map.id, topic: map.topic, updatedAt: map.updatedAt, count: map.concepts.length, sample: map.sample || '' });
  write(localStorage, K.index, index);
  return ok;
}
export function deleteMap(id) {
  remove(localStorage, K.map(id));
  write(localStorage, K.index, read(localStorage, K.index, []).filter((m) => m.id !== id));
}
