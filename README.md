# Profile Autopilot

Opens each folder in the VS Code profile that fits it, inferred from the extensions installed in each profile.

When you open a folder in the `Default` profile, or for the first time from a window on another profile, Profile Autopilot looks at the extensions installed in each of your profiles and at the files in the folder. It then switches to the profile that matches, which reloads the window once. VS Code remembers the profile for that folder, so the switch happens only the first time.

- Works with any profile you create, now or later. Nothing to configure.
- Asks when it is unsure, and learns from your answers.
- Asks for confirmation before reloading while a debug session or task is running, or while there are unsaved files and `files.hotExit` is `off`.

## Requirements

- VS Code 1.90 or later, desktop, local folders (remote windows are ignored).
- At least one custom profile with extensions installed.

## Install

Get the latest version in [Visual Studio Extension Marketplace](https://marketplace.visualstudio.com/items?itemName=omeranha.profile-autopilot)

Then use **Apply Extension to all Profiles** in the Extensions view, so every profile, including future ones, has the extension. Profile Autopilot must be installed in the profiles it reads from.

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
| One profile, decided only by setting names in step 1, with no root-level marker or learned folder to confirm it | Asks | Asks |
| Setting names point to one profile, but another profile has root-level marker or learned evidence | Asks which one | Asks which one |
| One profile, decided only by languages (step 4) | Asks | Asks |
| Several profiles tie | Asks which one | Asks which one |
| No evidence | Nothing | Nothing |

In a window on another profile (`actFrom` set to `any`), the extension does nothing if that profile is among the matches. Otherwise it only asks, whatever the confidence, and only the first time it sees the folder. Every question includes `Do not ask for this folder`. When profiles tie, the one with the fewest extensions is listed first.

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
| `profileAutopilot.actFrom` | `any` | `any` also evaluates a folder the first time it is opened from a window on another profile, and always asks before switching there. `default` only evaluates folders opened in the `Default` profile |

## Commands

| Command | Description |
| --- | --- |
| `Profile Autopilot: Detect profile for this folder` | Runs the detection now, ignores the cache, the `Do not ask` list and the failed-switch list |
| `Profile Autopilot: Switch profile in this window` | Picks a profile by hand and remembers the choice |
| `Profile Autopilot: List profiles` | Prints the profiles and the active one to the output channel |

## Troubleshooting

The `Profile Autopilot` output channel shows the score of every profile and the reason a folder was or was not switched.

| Symptom | Likely cause |
| --- | --- |
| Nothing happens | The window is on another profile and the folder was already seen (or `actFrom` is `default`), `mode` is `off`, the folder is on the `Do not ask` list, or no profile has evidence for the folder |
| A profile is never chosen | It has no extensions, or its extensions declare nothing the folder has. Pick it once by hand so the extension can learn it |
| A wrong profile was learned | Delete `profile-autopilot-learned.json` (see below) and choose again |

## Stored data

Files live in VS Code's `User/globalStorage` folder and are shared by all profiles. Delete a file to reset it.

| File | Content |
| --- | --- |
| `profile-autopilot-learned.json` | Folders you confirmed and their top-level names |
| `profile-autopilot-dismissed.json` | Folders marked `Do not ask for this folder` |
| `profile-autopilot-seen.json` | Folders the extension has already evaluated. Used by `actFrom` so a folder is offered a profile only once from a non-Default window |
| `profile-autopilot-failed.json` | Folders where a switch did not take effect, and the profile that failed. The extension does not retry them |
| `profile-autopilot-cache.json` | Detection results per folder, kept for 24 hours and dropped when any profile's extensions or the learned folders change |

## Limitations

- It reads VS Code's internal `storage.json` and each profile's `extensions.json`, and it runs an internal command to switch profiles, so a VS Code update can break it.
- The extension reads the window's profile from its install path. When it is applied to all profiles, that path is shared, so it uses the profile VS Code has stored for the folder instead. A folder tied to a custom profile is left alone. Switching profiles through VS Code's own UI is not seen, so nothing is learned from it.
- Two profiles with identical extensions cannot be told apart until you have chosen between them once.
