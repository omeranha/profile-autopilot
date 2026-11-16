const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILE_ID = '__default__profile__';
const DISMISSED_FILE_NAME = 'profile-autopilot-dismissed.json';

function findUserDir(startPath) {
  let current = startPath;
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'User') {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error('VS Code "User" folder not found starting from ' + startPath);
}

function sharedStoragePath(context, fileName) {
  return path.join(findUserDir(context.globalStorageUri.fsPath), 'globalStorage', fileName);
}

function readSharedJson(context, fileName, fallback) {
  try {
    return JSON.parse(fs.readFileSync(sharedStoragePath(context, fileName), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeSharedJson(context, fileName, value) {
  fs.writeFileSync(sharedStoragePath(context, fileName), JSON.stringify(value, null, 2));
}

function readProfiles(context) {
  const storage = JSON.parse(fs.readFileSync(sharedStoragePath(context, 'storage.json'), 'utf8'));
  const custom = (storage.userDataProfiles || []).filter(profile => profile.name && profile.location && !profile.location.startsWith('builtin/'));
  return [{ name: 'Default', id: DEFAULT_PROFILE_ID }, ...custom.map(profile => ({ name: profile.name, id: path.posix.basename(profile.location) }))];
}

function activeProfileId(context) {
  const parts = context.globalStorageUri.fsPath.split(path.sep);
  const userIndex = parts.lastIndexOf('User');
  return parts[userIndex + 1] === 'profiles' ? parts[userIndex + 2] : DEFAULT_PROFILE_ID;
}

function describeProfile(context, id) {
  const profile = readProfiles(context).find(item => item.id === id);
  return profile ? `${profile.name} (${id})` : id;
}

function readDismissedFolders(context) {
  return readSharedJson(context, DISMISSED_FILE_NAME, []);
}

function dismissFolder(context, folderKey) {
  const dismissed = readDismissedFolders(context);
  if (!dismissed.includes(folderKey)) {
    writeSharedJson(context, DISMISSED_FILE_NAME, [...dismissed, folderKey]);
  }
}

function profileExtensionsPath(context, profileId) {
  return path.join(findUserDir(context.globalStorageUri.fsPath), 'profiles', profileId, 'extensions.json');
}

module.exports = { DEFAULT_PROFILE_ID, readProfiles, activeProfileId, describeProfile, readDismissedFolders, dismissFolder, profileExtensionsPath, readSharedJson, writeSharedJson };
