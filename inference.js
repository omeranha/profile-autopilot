const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DEFAULT_PROFILE_ID, profileExtensionsPath } = require('./profiles');
const { getCachedInference, setCachedInference } = require('./cache');
const { GENERIC_GLOBS, readFolderFingerprint, readLearnedEntries } = require('./learning');

const WORKSPACE_CONTAINS_PREFIX = 'workspaceContains:';
const ON_LANGUAGE_PREFIX = 'onLanguage:';
const SEARCH_TIMEOUT_MS = 4000;
const SCORE_TOLERANCE = 1e-9;
const NESTED_MARKER_WEIGHT = 0.1;
const MAX_FILES_COUNTED = 50;
const MIN_LANGUAGE_FILES = 3;
const MIN_LEARNED_SIMILARITY = 0.4;
const OWN_EXTENSION_ID = 'local.profile-autopilot';
const LANGUAGE_SEARCH_EXCLUDE = '**/{node_modules,.git,.venv,venv,__pycache__}/**';
const TIERS = ['folder', 'marker', 'learned', 'language'];
const ROOT_EVIDENCE_TIERS = ['marker', 'learned'];
const INFERENCE_VERSION = 4;

function readManifest(extensionsDir, entry) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionsDir, entry.relativeLocation, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readProfileExtensions(context, profile, extensionsDir) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(profileExtensionsPath(context, profile.id), 'utf8'));
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.identifier?.id && entry.identifier.id !== OWN_EXTENSION_ID && entry.relativeLocation)
    .map(entry => ({ id: entry.identifier.id.toLowerCase(), manifest: readManifest(extensionsDir, entry) }));
}

function languageGlobs(language) {
  const fromExtensions = (language.extensions || []).map(extension => (extension.startsWith('.') ? `*${extension}` : extension));
  return [...fromExtensions, ...(language.filenames || [])];
}

function buildLanguageTable(manifests) {
  const table = new Map();
  for (const manifest of manifests) {
    for (const language of manifest?.contributes?.languages || []) {
      if (language.id) {
        table.set(language.id, [...(table.get(language.id) || []), ...languageGlobs(language)]);
      }
    }
  }
  return table;
}

function configurationKeys(manifest) {
  return [manifest.contributes?.configuration].flat().filter(Boolean).flatMap(section => Object.keys(section.properties || {}));
}

// Keyed without the leading "**/" so root-only and recursive declarations of the same file count as one marker.
function registerMarker(markers, event) {
  const declared = event.slice(WORKSPACE_CONTAINS_PREFIX.length).replace(/^\/+/, '');
  const recursive = declared.startsWith('**/');
  const key = recursive ? declared.slice(3) : declared;
  markers.set(key, markers.get(key) || recursive);
  return key;
}

function buildCandidate(profile, extensions, languageTable, markers, learnedEntries) {
  const languageGlobSet = new Set([...languageTable.values()].flat());
  const signals = { learned: new Set((learnedEntries || []).flatMap(entry => [...entry])), folder: new Set(), marker: new Set(), language: new Set() };
  for (const { id, manifest } of extensions) {
    signals.folder.add(id);
    configurationKeys(manifest).forEach(key => signals.folder.add(key.toLowerCase()));
    for (const event of manifest.activationEvents || []) {
      if (event.startsWith(WORKSPACE_CONTAINS_PREFIX)) {
        const key = registerMarker(markers, event);
        (languageGlobSet.has(key) ? signals.language : signals.marker).add(key);
      } else if (event.startsWith(ON_LANGUAGE_PREFIX)) {
        (languageTable.get(event.slice(ON_LANGUAGE_PREFIX.length)) || []).forEach(glob => signals.language.add(glob));
      }
    }
    (manifest.contributes?.languages || []).forEach(language => languageGlobs(language).forEach(glob => signals.language.add(glob)));
  }
  GENERIC_GLOBS.forEach(glob => signals.language.delete(glob));
  return { profile, extensionIds: new Set(extensions.map(extension => extension.id)), signals, learnedEntries: learnedEntries || [] };
}

function loadCandidates(context, profiles) {
  const extensionsDir = path.dirname(context.extensionPath);
  const profileExtensions = profiles.filter(profile => profile.id !== DEFAULT_PROFILE_ID).map(profile => ({ profile, extensions: readProfileExtensions(context, profile, extensionsDir) }));
  const allManifests = [...vscode.extensions.all.map(extension => extension.packageJSON), ...profileExtensions.flatMap(item => item.extensions.map(extension => extension.manifest))];
  const languageTable = buildLanguageTable(allManifests);
  const markers = new Map();
  const learned = readLearnedEntries(context);
  const candidates = profileExtensions.map(item => buildCandidate(item.profile, item.extensions, languageTable, markers, learned.get(item.profile.id)));
  return { candidates, markers };
}

function hasSignals(candidate) {
  return candidate.extensionIds.size > 0;
}

function buildSignature(candidates, markers) {
  const data = candidates.map(candidate => [candidate.profile.id, ...TIERS.map(tier => [...candidate.signals[tier]].sort())]).sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha1').update(JSON.stringify([INFERENCE_VERSION, data, [...markers.entries()].sort()])).digest('hex');
}

function countOwners(candidates, tier) {
  const owners = new Map();
  candidates.forEach(candidate => candidate.signals[tier].forEach(key => owners.set(key, (owners.get(key) || 0) + 1)));
  return owners;
}

function scoreLearned(candidate, matched) {
  const similarities = candidate.learnedEntries.map(entry => {
    const shared = [...entry].filter(token => matched.has(token));
    return { hits: shared, similarity: shared.length / (entry.size + matched.size - shared.length) };
  });
  const best = similarities.sort((a, b) => b.similarity - a.similarity)[0];
  return best && best.similarity >= MIN_LEARNED_SIMILARITY ? { candidate, hits: best.hits, score: best.similarity } : { candidate, hits: [], score: 0 };
}

function scoreCandidate(candidate, tier, owners, matched) {
  if (tier === 'learned') {
    return scoreLearned(candidate, matched);
  }
  const hits = [...candidate.signals[tier]].filter(key => matched.has(key));
  const score = hits.reduce((sum, key) => sum + matched.get(key) / owners.get(key), 0);
  const anchored = hits.some(key => matched.get(key) >= 1);
  const enoughFiles = tier !== 'language' || hits.reduce((sum, key) => sum + matched.get(key), 0) >= MIN_LANGUAGE_FILES;
  return { candidate, hits, score: anchored && enoughFiles ? score : 0 };
}
function orderByExtensionCount(pool) {
  return [...pool].sort((a, b) => a.extensionIds.size - b.extensionIds.size);
}

function isSettingsOnlyMatch(scored, candidate) {
  const winner = scored.find(item => item.candidate === candidate);
  return !winner.hits.some(key => candidate.extensionIds.has(key));
}

function discriminatingKeys(candidates, pool, tier, owners) {
  const discriminating = key => candidates.length === 1 || owners.get(key) < candidates.length;
  return [...new Set(pool.flatMap(candidate => [...candidate.signals[tier]]))].filter(discriminating);
}

async function findRootEvidence(candidates, find, log) {
  const supported = new Set();
  for (const tier of ROOT_EVIDENCE_TIERS) {
    const owners = countOwners(candidates, tier);
    const keys = discriminatingKeys(candidates, candidates, tier, owners);
    if (keys.length === 0) {
      continue;
    }
    const matched = await find(tier, keys);
    for (const item of candidates.map(candidate => scoreCandidate(candidate, tier, owners, matched)).filter(entry => entry.score > 0)) {
      log(`Inference (${tier}): profile "${item.candidate.profile.name}" scored ${item.score.toFixed(2)} (${item.hits.slice(0, 6).join(', ')})`);
      supported.add(item.candidate);
    }
  }
  return supported;
}

function isSubsetOf(candidate, other) {
  return [...candidate.extensionIds].every(id => other.extensionIds.has(id));
}

// Tools such as the ESP-IDF extension write their settings into any folder they open, so a settings key alone does not prove what the folder is.
// A profile whose extensions are all in the settings candidate's profile is not a rival, since that profile already has everything it offers.
async function resolveSettingsOnlyMatch(settingsCandidate, candidates, find, log, marker) {
  const supported = await findRootEvidence(candidates, find, log);
  const rivals = candidates.filter(candidate => candidate !== settingsCandidate && supported.has(candidate) && !isSubsetOf(candidate, settingsCandidate));
  if (rivals.length > 0) {
    const ordered = orderByExtensionCount([settingsCandidate, ...rivals]);
    log(`Settings keys point to "${settingsCandidate.profile.name}" but ${rivals.map(candidate => `"${candidate.profile.name}"`).join(', ')} also has root-level evidence; the user will be asked`);
    return { ambiguous: ordered.map(candidate => candidate.profile.name), marker };
  }
  if (!supported.has(settingsCandidate)) {
    log(`Settings keys were the only evidence for "${settingsCandidate.profile.name}"; no root-level marker or learned folder confirmed them`);
  }
  return { profileName: settingsCandidate.profile.name, marker, confident: supported.has(settingsCandidate) };
}

async function chooseCandidate(candidates, find, log) {
  const firstHit = new Map();
  let pool = candidates;
  let foundEvidence = false;
  for (const tier of TIERS) {
    const owners = countOwners(candidates, tier);
    const keys = discriminatingKeys(candidates, pool, tier, owners);
    if (keys.length === 0) {
      continue;
    }
    const matched = await find(tier, keys);
    const scored = pool.map(candidate => scoreCandidate(candidate, tier, owners, matched));
    const best = Math.max(...scored.map(item => item.score));
    if (best <= 0) {
      continue;
    }
    foundEvidence = true;
    for (const item of scored.filter(entry => entry.score > 0)) {
      log(`Inference (${tier}): profile "${item.candidate.profile.name}" scored ${item.score.toFixed(2)} (${item.hits.slice(0, 6).join(', ')})`);
      if (!firstHit.has(item.candidate)) {
        firstHit.set(item.candidate, item.hits[0]);
      }
    }
    pool = scored.filter(item => best - item.score < SCORE_TOLERANCE).map(item => item.candidate);
    if (pool.length === 1) {
      if (tier === 'folder' && isSettingsOnlyMatch(scored, pool[0])) {
        return resolveSettingsOnlyMatch(pool[0], candidates, find, log, firstHit.get(pool[0]));
      }
      return { profileName: pool[0].profile.name, marker: firstHit.get(pool[0]), confident: tier !== 'language' };
    }
  }
  if (!foundEvidence) {
    return undefined;
  }
  const ordered = orderByExtensionCount(pool);
  log(`Tie between ${ordered.map(candidate => `"${candidate.profile.name}"`).join(', ')}; the user will be asked`);
  return { ambiguous: ordered.map(candidate => candidate.profile.name), marker: firstHit.get(ordered[0]) };
}

function parseJsonc(text) {
  const withoutComments = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, match => (match.startsWith('"') ? match : ''));
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, '$1'));
}

async function readJsoncFile(folder, fileName) {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode', fileName));
    return parseJsonc(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

async function readFolderTokens(folders) {
  const tokens = new Set();
  for (const folder of folders) {
    const settings = await readJsoncFile(folder, 'settings.json');
    const extensions = await readJsoncFile(folder, 'extensions.json');
    Object.keys(settings || {}).forEach(key => tokens.add(key.toLowerCase()));
    (extensions?.recommendations || []).forEach(id => tokens.add(String(id).toLowerCase()));
  }
  return tokens;
}

async function countFiles(folders, pattern, exclude, limit, token) {
  let total = 0;
  try {
    for (const folder of folders) {
      total += (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), exclude, limit - total, token)).length;
      if (total >= limit) {
        break;
      }
    }
  } catch {
    return 0;
  }
  return total;
}

async function weighKeys(keys, weigh) {
  const source = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => source.cancel(), SEARCH_TIMEOUT_MS);
  const weights = new Map();
  await Promise.all(keys.map(async key => {
    const weight = await weigh(key, source.token);
    if (weight > 0) {
      weights.set(key, weight);
    }
  }));
  clearTimeout(timer);
  const complete = !source.token.isCancellationRequested;
  source.dispose();
  return { weights, complete };
}

function createFinder(folders, markers) {
  let complete = true;
  let folderTokens;
  let fingerprint;
  const weighMarker = async (key, token) => {
    if ((await countFiles(folders, key, undefined, 1, token)) > 0) {
      return 1;
    }
    return markers.get(key) && (await countFiles(folders, `**/${key}`, undefined, 1, token)) > 0 ? NESTED_MARKER_WEIGHT : 0;
  };
  const weighLanguage = (key, token) => countFiles(folders, `**/${key}`, LANGUAGE_SEARCH_EXCLUDE, MAX_FILES_COUNTED, token);
  const find = async (tier, keys) => {
    if (tier === 'learned') {
      fingerprint ??= await readFolderFingerprint(folders);
      return new Map([...fingerprint].map(token => [token, 1]));
    }
    if (tier === 'folder') {
      folderTokens ??= await readFolderTokens(folders);
      return new Map(keys.filter(key => folderTokens.has(key)).map(key => [key, 1]));
    }
    const result = await weighKeys(keys, tier === 'marker' ? weighMarker : weighLanguage);
    complete = complete && result.complete;
    return result.weights;
  };
  return { find, isComplete: () => complete };
}

async function inferProfile(context, profiles, folders, log, useCache) {
  const loaded = loadCandidates(context, profiles);
  loaded.candidates.filter(candidate => !hasSignals(candidate)).forEach(candidate => log(`The profile "${candidate.profile.name}" has no extensions; it will not be chosen automatically`));
  const candidates = loaded.candidates.filter(hasSignals);
  const cacheKey = folders.map(folder => folder.uri.toString()).join('|');
  const signature = buildSignature(candidates, loaded.markers);
  if (useCache) {
    const cached = getCachedInference(context, cacheKey, signature);
    if (cached) {
      log('Inference reused from cache');
      return cached.result || undefined;
    }
  }
  const finder = createFinder(folders, loaded.markers);
  const result = await chooseCandidate(candidates, finder.find, log);
  if (finder.isComplete()) {
    setCachedInference(context, cacheKey, signature, result);
  } else {
    log('The search timed out; the result will not be cached');
  }
  return result;
}

module.exports = { inferProfile };
