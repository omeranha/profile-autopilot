const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILE_ID = '__default__profile__';
const DISMISSED_FILE_NAME = 'profile-autopilot-dismissed.json';
const FAILED_FILE_NAME = 'profile-autopilot-failed.json';

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

// Extensions applied to all profiles share one globalStorage path, which always reads as Default, so the folder association VS Code keeps is the fallback.
function activeProfileId(context, workspaceKey) {
  const parts = context.globalStorageUri.fsPath.split(path.sep);
  const userIndex = parts.lastIndexOf('User');
  if (parts[userIndex + 1] === 'profiles') {
    return parts[userIndex + 2];
  }
  const associatedId = workspaceKey ? readWorkspaceProfileId(context, workspaceKey) : undefined;
  return associatedId && readProfiles(context).some(profile => profile.id === associatedId) ? associatedId : DEFAULT_PROFILE_ID;
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

function readWorkspaceProfileId(context, workspaceKey) {
  return readSharedJson(context, 'storage.json', {}).profileAssociations?.workspaces?.[workspaceKey];
}

function readFailedSwitches(context) {
  return readSharedJson(context, FAILED_FILE_NAME, {});
}

function recordFailedSwitch(context, folderKey, targetId) {
  const failed = readFailedSwitches(context);
  const ids = failed[folderKey] || [];
  if (!ids.includes(targetId)) {
    writeSharedJson(context, FAILED_FILE_NAME, { ...failed, [folderKey]: [...ids, targetId] });
  }
}

function clearFailedSwitch(context, folderKey, targetId) {
  const failed = readFailedSwitches(context);
  if (!failed[folderKey]?.includes(targetId)) {
    return;
  }
  const { [folderKey]: ids, ...others } = failed;
  const remaining = ids.filter(id => id !== targetId);
  writeSharedJson(context, FAILED_FILE_NAME, remaining.length > 0 ? { ...others, [folderKey]: remaining } : others);
}

module.exports = {
  DEFAULT_PROFILE_ID, readProfiles, activeProfileId, describeProfile, readDismissedFolders, dismissFolder, profileExtensionsPath, readSharedJson, writeSharedJson,
  readWorkspaceProfileId, readFailedSwitches, recordFailedSwitch, clearFailedSwitch
};
