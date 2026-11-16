const { readSharedJson, writeSharedJson } = require('./profiles');

const CACHE_FILE_NAME = 'profile-autopilot-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCachedInference(context, key, signature) {
  const entry = readSharedJson(context, CACHE_FILE_NAME, {})[key];
  if (!entry || entry.signature !== signature || Date.now() - entry.checkedAt > CACHE_TTL_MS) {
    return undefined;
  }
  return entry;
}

function setCachedInference(context, key, signature, result) {
  const now = Date.now();
  const fresh = Object.entries(readSharedJson(context, CACHE_FILE_NAME, {})).filter(([, entry]) => now - entry.checkedAt <= CACHE_TTL_MS);
  writeSharedJson(context, CACHE_FILE_NAME, { ...Object.fromEntries(fresh), [key]: { signature, result: result || null, checkedAt: now } });
}

module.exports = { getCachedInference, setCachedInference };
