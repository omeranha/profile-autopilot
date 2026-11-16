# Profile Autopilot

Opens each folder in the VS Code profile that fits it, with no rules to write.

When you open a folder in the `Default` profile, Profile Autopilot looks at the extensions installed in each of your profiles and at the files in the folder. It then switches to the profile that matches, which reloads the window once. VS Code remembers the profile for that folder, so the switch happens only the first time.

- Works with any profile you create, now or later. Nothing to configure.
- Asks when it is unsure, and learns from your answers.
- Asks for confirmation before reloading while a debug session or task is running, or while there are unsaved files and `files.hotExit` is `off`.

## Requirements

- VS Code 1.90 or later, desktop, local folders (remote windows are ignored).
- At least one custom profile with extensions installed.

## Install

Get the latest version in [Releases](https://github.com/omeranha/profile-autopilot/releases) or build:
```powershell
vsce package
```

Install:
```powershell
code --install-extension .\profile-autopilot-1.0.0.vsix
```

Then use **Apply Extension to all Profiles** in the Extensions view, so every profile, including future ones, has the extension. Profile Autopilot only acts from the `Default` profile, but it must be installed in the profiles it reads from.

## How a profile is chosen

The extension compares the folder with each profile's extensions, from the strongest evidence to the weakest. Each step keeps only the profiles that scored best, and the next step decides between them.

| Step | Evidence | Example |
| --- | --- | --- |
| 1. Folder settings | Recommended extensions in `.vscode/extensions.json` and setting names in `.vscode/settings.json` that belong to a profile's extensions | `idf.currentSetup` points to an ESP-IDF profile |
| 2. Marker files | `workspaceContains` activation events declared by the extensions. A root-level hit counts fully. Nested hits only count together with a root hit | `*.csproj`, `gradlew` |
| 3. Learned folders | Folders you confirmed before, matched by the similarity of their top-level names | `sdkconfig`, `manage.py` |
| 4. Languages | File globs of the languages the extensions activate on (`onLanguage:*`, `contributes.languages`). At least 3 matching files are needed | `*.py`, `*.cs` |

Evidence that every profile shares is ignored. Evidence shared by some profiles is divided between them. Generic file types such as `*.md`, `*.json` and `*.yml` are ignored.

## What happens next

| Result | `auto` mode | `suggest` mode |
| --- | --- | --- |
| One profile, decided by steps 1 to 3 | Switches | Asks |
| One profile, decided only by languages (step 4) | Asks | Asks |
| Several profiles tie | Asks which one | Asks which one |
| No evidence | Nothing | Nothing |

Every question includes `Do not ask for this folder`. When profiles tie, the one with the fewest extensions is listed first.

## Learning from your choices

The extension remembers a folder when you:

- pick a profile in the tie question,
- choose `Switch now` on a suggestion,
- or use `Profile Autopilot: Switch profile in this window`.

It stores the top-level file and folder names of that folder, such as `sdkconfig` or `manage.py`. A later folder with a similar set of names goes to the same profile. This is how it tells apart profiles that have the same extensions, such as a general Python profile and a Django profile.

- Only your explicit choices are remembered. Automatic switches are not.
- Common names such as `README.md`, `src`, `.git` and `node_modules` are not stored.

## Setting

| Setting | Default | Description |
| --- | --- | --- |
| `profileAutopilot.mode` | `auto` | `off` disables the extension. `suggest` always asks first. `auto` switches without asking when the evidence is strong |

## Commands

| Command | Description |
| --- | --- |
| `Profile Autopilot: Detect profile for this folder` | Runs the detection now, ignores the cache and the `Do not ask` list |
| `Profile Autopilot: Switch profile in this window` | Picks a profile by hand and remembers the choice |
| `Profile Autopilot: List profiles` | Prints the profiles and the active one to the output channel |

## Troubleshooting

The `Profile Autopilot` output channel shows the score of every profile and the reason a folder was or was not switched.

| Symptom | Likely cause |
| --- | --- |
| Nothing happens | The window is not on `Default`, `mode` is `off`, the folder is on the `Do not ask` list, or no profile has evidence for the folder |
| A profile is never chosen | It has no extensions, or its extensions declare nothing the folder has. Pick it once by hand so the extension can learn it |
| A wrong profile was learned | Delete `profile-autopilot-learned.json` (see below) and choose again |

## Stored data

Files live in VS Code's `User/globalStorage` folder and are shared by all profiles. Delete a file to reset it.

| File | Content |
| --- | --- |
| `profile-autopilot-learned.json` | Folders you confirmed and their top-level names |
| `profile-autopilot-dismissed.json` | Folders marked `Do not ask for this folder` |
| `profile-autopilot-cache.json` | Detection results per folder, kept for 24 hours and dropped when any profile's extensions or the learned folders change |

## Limitations

- It reads VS Code's internal `storage.json` and each profile's `extensions.json`, and it runs an internal command to switch profiles, so a VS Code update can break it.
- A folder already tied to a custom profile is left alone. Switching profiles through VS Code's own UI is not seen, so nothing is learned from it.
- Two profiles with identical extensions cannot be told apart until you have chosen between them once.
