const vscode = require('vscode');
const path = require('path');
const { readSharedJson, writeSharedJson } = require('./profiles');

const LEARNED_FILE_NAME = 'profile-autopilot-learned.json';
const GENERIC_GLOBS = ['*.md', '*.markdown', '*.json', '*.jsonc', '*.txt', '*.yml', '*.yaml', '*.xml', '*.html', '*.css', '*.ini', '*.log', '*.csv'];
const IGNORED_NAMES = new Set([
  'license', 'licence', 'changelog', 'contributing', 'readme', 'notice', 'authors', 'node_modules', 'bin', 'obj', 'build', 'dist', 'out', 'target', 'docs', 'doc',
  'src', 'source', 'include', 'lib', 'libs', 'test', 'tests', 'scripts', 'assets', 'public', 'config', 'data', 'resources', 'tools', 'app', 'packages'
]);

function isIgnoredName(lowerName) {
  const stem = lowerName.replace(/\.[^.]*$/, '');
  return lowerName.startsWith('.git') || ['.vscode', '.idea', '.vs', '.github', '.editorconfig', '.env'].includes(lowerName) || IGNORED_NAMES.has(stem);
}

function tokensFromEntries(entries) {
  const tokens = new Set();
  for (const [name, type] of entries) {
    const lowerName = name.toLowerCase();
    if (isIgnoredName(lowerName)) {
      continue;
    }
    tokens.add(lowerName);
    const extension = path.extname(lowerName);
    if (type === vscode.FileType.File && extension && !GENERIC_GLOBS.includes(`*${extension}`)) {
      tokens.add(`*${extension}`);
    }
  }
  return tokens;
}

async function readFolderFingerprint(folders) {
  const tokens = new Set();
  for (const folder of folders) {
    try {
      tokensFromEntries(await vscode.workspace.fs.readDirectory(folder.uri)).forEach(token => tokens.add(token));
    } catch {
      continue;
    }
  }
  return tokens;
}

function readLearnedEntries(context) {
  const byProfile = new Map();
  for (const entry of Object.values(readSharedJson(context, LEARNED_FILE_NAME, {}))) {
    byProfile.set(entry.profileId, [...(byProfile.get(entry.profileId) || []), new Set(entry.tokens)]);
  }
  return byProfile;
}
async function learnChoice(context, folders, profileId) {
  const tokens = await readFolderFingerprint(folders);
  if (tokens.size === 0) {
    return;
  }
  const folderKey = folders.map(folder => folder.uri.toString()).join('|');
  writeSharedJson(context, LEARNED_FILE_NAME, { ...readSharedJson(context, LEARNED_FILE_NAME, {}), [folderKey]: { profileId, tokens: [...tokens].sort() } });
}

module.exports = { GENERIC_GLOBS, readFolderFingerprint, readLearnedEntries, learnChoice };
