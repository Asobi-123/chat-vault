# Architecture

## Overview

Chat Vault is a hybrid SillyTavern extension:

- the front-end extension watches chat events, editors, and UI actions
- the server plugin persists backups and drafts under the user data directory
- an optional Git cloud vault publishes selected backups into a separate repository workspace

The goal is to keep backup and recovery logic independent from the current chat file's survival.

## Main Flows

### 1. Commit-level backup

1. The front-end listens to commit-style events such as message send, receive, delete, and swipe.
2. It builds a full snapshot payload from:
   - current `chat_metadata`
   - current chat messages
   - current source descriptor
3. It posts the snapshot to `/api/plugins/chat-vault/snapshot/create`.
4. The server plugin resolves the stable scope for that chat line.
5. The snapshot is written as an independent `snapshots/*.jsonl` file.
6. The scope `index.json` is updated.
7. The front-end also schedules a short delayed `context.saveChat()` call.

### 2. Unsaved edit mirror

1. The front-end watches `.edit_textarea` and `.reasoning_edit_textarea`.
2. It captures the in-progress text, message id, and a lightweight anchor.
3. It posts that draft to `/api/plugins/chat-vault/draft/save`.
4. The server plugin stores it in `draft.json` under the same scope.
5. After refresh or crash, the front-end can fetch the draft and try to reopen the matching editor.

### 3. Disaster recovery

1. The front-end opens the global recovery tab.
2. It requests `/api/plugins/chat-vault/scope/list`.
3. The server plugin rebuilds `scopes-index.json` from all scope directories.
4. The UI lists every recoverable chat scope, even if the current chat is missing or broken.
5. The user can preview a snapshot or restore it as a new chat.

### 4. Chat rename continuity

1. The front-end wraps `window.fetch` and watches SillyTavern's `/api/chats/rename`.
2. When a rename succeeds, it calls `/api/plugins/chat-vault/scope/rebind-chat`.
3. The server plugin updates alias bindings so old and new chat ids still resolve to the same scope.

### 5. Git cloud vault

1. The front-end opens the cloud tab and saves repository config into the server-side user directory.
2. A manual sync asks the server plugin to scan local Chat Vault data.
3. The server plugin selects:
   - all long-term keep backups
   - one stable backup per scope
4. For each selected snapshot, the server plugin also collects linked resources such as character cards, persona data, lorebooks, and group definitions.
5. Those snapshots and resources are written into a dedicated Git workspace, not into the live SillyTavern `data` tree.
6. The remote `manifest.json` is rebuilt from the cloud snapshot metadata already stored in that workspace.
7. Another device can fetch that manifest, browse the remote scopes, import resources plus the snapshot into local Chat Vault, or restore it as a new chat.

### 6. Cloud restore and local import

1. The front-end asks the server plugin to prepare a remote snapshot.
2. The server plugin imports missing resources into normal SillyTavern user directories:
   - `characters/`
   - `User Avatars/`
   - `worlds/`
   - `groups/`
   - `settings.json` persona fields when needed
3. Resource import uses content-hash dedupe so same-content files are reused even when file names differ.
4. `Import Local` puts resources into normal SillyTavern resource folders and stores the chat snapshot into local Chat Vault.
5. `Restore as New Chat` writes a real SillyTavern chat file after resources are ready.

## Layer Diagram

```text
┌───────────────────────────────────────────────┐
│ Install Layer                                │
│ install.mjs / uninstall.mjs                  │
│ deploy extension + server plugin             │
├───────────────────────────────────────────────┤
│ Front-End Layer (extension/)                 │
│ index.js      — event listeners + UI logic   │
│ settings.html — drawer entry                 │
│ style.css     — drawer + floating panel UI   │
│ i18n.js       — locale loader                │
│ i18n/*.json   — translations                 │
├───────────────────────────────────────────────┤
│ Network Layer                                │
│ /api/plugins/chat-vault/*                    │
│ snapshot / draft / scope endpoints           │
├───────────────────────────────────────────────┤
│ Server Layer (server-plugin/index.mjs)       │
│ scope resolution                             │
│ snapshot write/read                          │
│ draft write/read                             │
│ global scope index rebuild                   │
│ optional git cloud vault sync                │
├───────────────────────────────────────────────┤
│ Storage Layer                                │
│ data/<user>/user/files/chat-vault/           │
│ scope-aliases.json                           │
│ scopes-index.json                            │
│ cloud-config.json                            │
│ scopes/<label>__<scopeId>/                   │
│   index.json                                 │
│   draft.json                                 │
│   snapshots/*.jsonl                          │
│ cloud/remotes/<repoKey>/repo/                │
│   vault.json                                 │
│   manifest.json                              │
│   devices/*.json                             │
│   objects/meta/<scopeId>/*.json              │
│   objects/snapshots/<scopeId>/*.jsonl        │
│   objects/resource-meta/<kind>/*.json        │
│   objects/resource-data/<kind>/*             │
└───────────────────────────────────────────────┘
```

## Key Design Decisions

### Server-backed storage instead of browser-only backup

The primary backup store is on the SillyTavern server side.
This avoids putting the entire recovery story on `IndexedDB`.

### Backup independence from `chat_metadata`

Snapshots include `chat_metadata`, but recovery does not depend on the original chat file still existing.
Global recovery is rebuilt from Chat Vault's own storage tree.

### Stable scope identity plus human-readable folders

Each scope is stored in a folder named like:

- `<label>__<scopeId>`

The readable prefix helps manual inspection.
The `scopeId` keeps identity stable when labels change.

### Rolling auto backup dedupe

Auto backups are not append-only by default.
They are deduped and merged using:

- `turnAnchorKey`
- `seriesKey`
- latest auto replacement rules

This keeps one rolling auto backup from exploding into many entries during one turn.

### Drafts stored separately from snapshots

Unsaved edit recovery has a different lifecycle from chat backups.
So drafts live in `draft.json`, not inside snapshot history.

### Disaster recovery is global, not tied to the current chat view

The recovery tab is backed by `/scope/list` and `scopes-index.json`.
This allows browsing backups even when the current chat cannot be opened normally.

### Git cloud vault does not Git-ify the live data directory

The cloud sync layer uses its own workspace under `user/files/chat-vault/cloud/`.
It never turns the live SillyTavern `data/` tree into a shared Git repository.

### Cloud retention is append-only by default

Cloud sync no longer infers remote deletion from one device's current local state.
If a device later deletes local cards, lorebooks, personas, or local backups, that does not silently erase older cloud copies.
Cloud deletion is explicit and per backup.

### Device state files are auxiliary, not the source of truth

Each device still writes a lightweight state file, but the remote catalog is rebuilt from cloud snapshot metadata itself.
That means existing cloud backups remain visible even if one device no longer publishes them locally.

### Resource imports prefer hash reuse over filename identity

For file-like resources such as:

- character cards
- persona avatar images
- lorebook JSON files

the importer first scans the destination directory for matching content hash.
If a match exists, it reuses the existing file instead of importing a duplicate under another name.
