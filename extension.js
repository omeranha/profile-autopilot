const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_PROFILE_ID, readProfiles, activeProfileId, describeProfile, readDismissedFolders, dismissFolder, readWorkspaceProfileId, readFailedSwitches, recordFailedSwitch, clearFailedSwitch } = require('./profiles');
const { inferProfile } = require('./inference');
const { learnChoice } = require('./learning');

const SWITCH_COMMAND_PREFIX = 'workbench.profiles.actions.profileEntry.';
const PENDING_MAX_AGE_MS = 60000;
const HOST_RESTART_WAIT_MS = 5000;
const SWITCH_NOW = 'Switch now';
const DISMISS_FOLDER = 'Do not ask for this folder';
const SWITCH_ANYWAY = 'Switch anyway';

let output;

function log(message) {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function pendingFilePath() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'no-folder';
  const hash = crypto.createHash('sha1').update(folder).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `profile-autopilot-pending-${hash}.json`);
}

function reportPendingSwitch(context) {
  const pendingFile = pendingFilePath();
  if (!fs.existsSync(pendingFile)) {
    return true;
  }
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  fs.unlinkSync(pendingFile);
  const elapsedMs = Date.now() - pending.startedAt;
  if (elapsedMs > PENDING_MAX_AGE_MS) {
    return true;
  }
  const reached = activeProfileId(context, currentWorkspaceKey()) === pending.targetId;
  log(`Switch to "${pending.targetName}" ${reached ? 'completed' : 'NOT applied'} in ${(elapsedMs / 1000).toFixed(1)}s (window reload: ${pending.reloaded ? 'yes' : 'no'}; active profile ${describeProfile(context, activeProfileId(context, currentWorkspaceKey()))}; association ${readWorkspaceProfileId(context, currentWorkspaceKey())})`);
  const folderKey = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  if (folderKey && reached) {
    clearFailedSwitch(context, folderKey, pending.targetId);
  } else if (folderKey) {
    recordFailedSwitch(context, folderKey, pending.targetId);
  }
  if (!reached) {
    vscode.window.showWarningMessage(`Could not apply the profile "${pending.targetName}". Automatic profile selection was skipped for this window.`);
  }
  return reached;
}

function findBlockers() {
  const blockers = [];
  if (vscode.debug.activeDebugSession) {
    blockers.push('an active debug session');
  }
  if (vscode.tasks.taskExecutions.length > 0) {
    blockers.push('running tasks');
  }
  const hotExitDisabled = vscode.workspace.getConfiguration('files').get('hotExit') === 'off';
  if (hotExitDisabled && vscode.workspace.textDocuments.some(document => document.isDirty)) {
    blockers.push('unsaved files');
  }
  return blockers;
}

async function confirmReload(target) {
  const blockers = findBlockers();
  if (blockers.length === 0) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(`Switching to the profile "${target.name}" reloads the window, and there is ${blockers.join(' and ')}. Continue?`, SWITCH_ANYWAY);
  if (choice !== SWITCH_ANYWAY) {
    log(`Switch to "${target.name}" cancelled: ${blockers.join(', ')}`);
    return false;
  }
  return true;
}

function currentWorkspaceKey() {
  return (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString();
}

async function switchTo(context, target) {
  if (!(await confirmReload(target))) {
    return;
  }
  const pendingFile = pendingFilePath();
  const pending = { targetId: target.id, targetName: target.name, startedAt: Date.now(), reloaded: false };
  fs.writeFileSync(pendingFile, JSON.stringify(pending));
  const commandId = SWITCH_COMMAND_PREFIX + target.id;
  const workspaceKey = currentWorkspaceKey();
  log(`Running ${commandId} (association before: ${readWorkspaceProfileId(context, workspaceKey)})`);
  try {
    await vscode.commands.executeCommand(commandId);
  } catch (error) {
    if (error?.name === 'Canceled' || error?.message === 'Canceled') {
      log('VS Code stopped the extension host while switching; the new host will confirm the result');
      return;
    }
    fs.rmSync(pendingFile, { force: true });
    log(`Failed to switch profile: ${error}`);
    vscode.window.showErrorMessage(`Failed to switch to the profile "${target.name}": ${error.message || error}`);
    return;
  }
  log(`Switch command returned in ${((Date.now() - pending.startedAt) / 1000).toFixed(2)}s (association now: ${readWorkspaceProfileId(context, workspaceKey)})`);
  await new Promise(resolve => setTimeout(resolve, HOST_RESTART_WAIT_MS));
  log(`The extension host survived ${HOST_RESTART_WAIT_MS}ms after the switch; reloading the window`);
  fs.writeFileSync(pendingFile, JSON.stringify({ ...pending, reloaded: true }));
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function findProfileName(profiles, profileId) {
  return profiles.find(profile => profile.id === profileId)?.name;
}

async function switchAndRemember(context, target, folders) {
  await learnChoice(context, folders, target.id);
  await switchTo(context, target);
}

async function askWhichProfile(context, targets, folders, folderKey) {
  const items = [...targets.map(profile => ({ label: profile.name, profile })), { label: DISMISS_FOLDER, dismiss: true }];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'This folder fits more than one profile. Pick one to switch; your choice is remembered for similar folders.' });
  if (picked?.dismiss) {
    dismissFolder(context, folderKey);
  } else if (picked) {
    await switchAndRemember(context, picked.profile, folders);
  }
}

async function suggestProfile(context, target, match, folders, folderKey) {
  const choice = await vscode.window.showInformationMessage(`This folder looks like it uses the profile "${target.name}" (found: ${match.marker}). Switch profile?`, SWITCH_NOW, DISMISS_FOLDER);
  if (choice === SWITCH_NOW) {
    await switchAndRemember(context, target, folders);
  } else if (choice === DISMISS_FOLDER) {
    dismissFolder(context, folderKey);
  }
}

async function applyInference(context, manual) {
  const folders = vscode.workspace.workspaceFolders;
  if (vscode.env.remoteName || !folders || folders.length === 0) {
    if (manual) {
      vscode.window.showInformationMessage('Open a local folder to detect its profile.');
    }
    return;
  }
  const mode = vscode.workspace.getConfiguration('profileAutopilot').get('mode');
  const currentId = activeProfileId(context, currentWorkspaceKey());
  if (!manual && (mode === 'off' || currentId !== DEFAULT_PROFILE_ID)) {
    if (mode !== 'off') {
      log(`This window already uses the profile ${describeProfile(context, currentId)}; nothing to do`);
    }
    return;
  }
  const profiles = readProfiles(context);
  const folderKey = folders[0].uri.toString();
  const failedIds = manual ? [] : readFailedSwitches(context)[folderKey] || [];
  const match = await inferProfile(context, profiles, folders, log, !manual);
  if (!match) {
    log('No profile matched this folder');
    if (manual) {
      vscode.window.showInformationMessage('No installed profile matches this folder.');
    }
    return;
  }
  const names = match.ambiguous || [match.profileName];
  const targets = names.map(name => profiles.find(profile => profile.name === name)).filter(profile => profile && profile.id !== currentId && !failedIds.includes(profile.id));
  if (targets.length === 0) {
    log(`The inferred profile "${names.join(', ')}" is the current one, failed to apply before, or no longer exists`);
    if (manual && names.includes(findProfileName(profiles, currentId))) {
      vscode.window.showInformationMessage(`This window already uses the profile "${names[0]}".`);
    }
    return;
  }
  if (!manual && readDismissedFolders(context).includes(folderKey)) {
    log('Folder marked as do-not-ask; skipping');
    return;
  }
  if (match.ambiguous) {
    await askWhichProfile(context, targets, folders, folderKey);
    return;
  }
  log(`Inferred profile "${targets[0].name}" (marker "${match.marker}", ${match.confident ? 'confident' : 'tentative'})`);
  if (manual || (mode === 'auto' && match.confident)) {
    await switchTo(context, targets[0]);
    return;
  }
  await suggestProfile(context, targets[0], match, folders, folderKey);
}
async function listProfiles(context) {
  output.show(true);
  log(`Active profile: ${describeProfile(context, activeProfileId(context, currentWorkspaceKey()))}`);
  readProfiles(context).forEach(profile => output.appendLine(`  ${profile.name}\t${profile.id}`));
}

async function pickAndSwitch(context) {
  const profiles = readProfiles(context);
  const picked = await vscode.window.showQuickPick(profiles.map(profile => ({ label: profile.name, description: profile.id, profile })), { placeHolder: 'Select the profile' });
  if (picked?.profile.id === DEFAULT_PROFILE_ID) {
    await switchTo(context, picked.profile);
  } else if (picked) {
    await switchAndRemember(context, picked.profile, vscode.workspace.workspaceFolders || []);
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel('Profile Autopilot');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('profileAutopilot.listProfiles', () => listProfiles(context)));
  context.subscriptions.push(vscode.commands.registerCommand('profileAutopilot.switchProfile', () => pickAndSwitch(context)));
  context.subscriptions.push(vscode.commands.registerCommand('profileAutopilot.detectProfile', () => applyInference(context, true)));
  log(`Extension activated (active profile ${describeProfile(context, activeProfileId(context, currentWorkspaceKey()))})`);
  const lastSwitchSucceeded = reportPendingSwitch(context);
  if (lastSwitchSucceeded) {
    await applyInference(context, false);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
