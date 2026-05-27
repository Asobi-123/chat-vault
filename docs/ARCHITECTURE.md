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
4. Each selected snapshot is then processed one entry at a time. For every entry, the server plugin streams its linked resources (character cards, persona data, lorebooks, group definitions): read the file, hash it, write it into the cloud workspace under its content-addressed path, and release the buffer before moving on. The snapshot JSONL itself is written and released the same way. This keeps peak memory bounded to the size of a single chat plus a single resource, even when a selection spans many large chats.
5. Resources are stored under content-addressed paths so duplicates across snapshots reuse the same file; an existing file at the target hash path is treated as a content match without re-reading and comparing buffers.
6. None of this touches the live SillyTavern `data` tree — the cloud workspace is a dedicated directory.
7. The remote `manifest.json` is rebuilt from the cloud snapshot metadata already stored in that workspace.
8. Another device can fetch that manifest, browse the remote scopes, import resources plus the snapshot into local Chat Vault, or restore it as a new chat.

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

### 7. Character card merge (0.3.0+)

When `Import Local` or `Restore as New Chat` brings a character card back from the cloud, Chat Vault refuses to overwrite an existing local PNG that differs by bytes — it imports the new card with a `__vault_<hex>` suffix instead. This is safe but can leave the user with two same-name cards once a card version drifts (legitimate v1.0 vs v2.0, or SillyTavern writing runtime metadata back into the original PNG). The Card Merge tab consolidates these duplicates.

1. The tab scans `characters/` and groups PNGs whose `chara` chunk `name` field collides.
2. Each duplicate group is rendered with both files' filenames, sizes, modification times, chat counts (number of `chats/<avatar>/*.jsonl`), and Chat Vault backup counts.
3. Picking a group runs a 5-step wizard: review the pair, see a `chara`-chunk field-level diff, preview the on-disk impact, execute, and confirm completion.
4. Execution archives both original PNGs into `merge-backup/<mergeId>/` first, then writes a `pending-merge.json` marker at the chat-vault root. Each subsequent step (rename the kept card to its canonical filename, move the other card's chats in, delete the other PNG, rewrite group / persona / scope references) appends to the marker's `completedSteps` so an interrupted merge leaves a usable breadcrumb. The kept card's PNG bytes are never overwritten — `primary` in the data model is the card the user chose to keep.
5. The merged card always ends up with the canonical filename `<character.name>.png` — any `__vault_<hex>` suffix is stripped. Chats and Chat Vault scopes are reattached to the canonical avatar name.
6. The marker is dropped on success and rewritten as `merge-info.json` (permanent record). Only the most recent 5 archives are retained globally; older ones are pruned automatically.

Two distinct rollback paths exist:

- **Pending rollback**: if `pending-merge.json` still exists at startup (the merge crashed mid-flight), the UI offers to restore both original PNGs from the archive and reverse the partial reference rewrites. Already-moved chats are not split back apart.
- **Post-completion rollback**: each finalized archive in `merge-backup/` is listed under "Recent merges" in the Card Merge tab (collapsed by default) with a "Roll back this merge" button. Clicking it restores both original PNGs, reverses avatar reference rewrites, and saves the current merged PNG aside as `post-merge-snapshot.png` inside the archive so a re-do is possible. Already-merged chats stay together — the merge execution does not track per-jsonl origin, so a clean split is not attempted.

Cloud upload-side dedupe complements the merge tab: 0.3.0+ identifies character card resources in the cloud workspace by their `chara`-chunk fingerprint (canonical card definition fields only, with runtime fields excluded) rather than the full PNG bytes. Re-syncing the same card after SillyTavern writes runtime data back into the PNG no longer produces a new cloud copy. The restore path also tries the chara fingerprint first when looking for an existing local card to reuse, falling back to the full-byte hash for legacy 0.2.x backups.

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
