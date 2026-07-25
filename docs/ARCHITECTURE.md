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

### 5. Git cloud vault and repository pool

1. The front-end saves one or more repositories into the server-side `cloud-config.json`. The first repository is the catalog repository. The default GitHub token and optional per-repository overrides remain local only; no token is written into a remote Git URL, `.git/config`, manifest, or pool descriptor.
2. A one-repository configuration is valid and keeps the former Cloud Vault flow. Adding another repository only needs its URL when the saved default token can access it.
3. The catalog repository stores `vault-pool.json`, a token-free descriptor with the repository list and durable `scopeId -> homeRepositoryId` mappings. The descriptor is copied to each healthy repository after catalog commit, allowing another device to discover repository URLs after connecting to the catalog.
4. During the first v1-to-pool upgrade, every existing catalog manifest scope is assigned to the catalog before new assignments are made. A home mapping never changes during ordinary sync.
5. A manual sync selects all long-term keep backups plus one stable backup per scope. New scopes are assigned to the healthy repository with the lowest logical snapshot bytes plus this run's planned bytes. A scope's selected snapshots, chunks, resources, device state, and manifest entry are persisted only in its home repository.
6. Each selected snapshot is processed independently. Linked resources are streamed: read, hash, persist under a content-addressed path, then release before moving on. A snapshot up to 40 MiB remains a normal `.jsonl`; a larger one is stored as independently gzip-compressed 8 MiB chunks under `objects/snapshot-chunks/`.
7. An unreadable local snapshot is skipped while the remaining scopes continue. A repository fetch, commit, or push failure similarly affects only scopes assigned to that repository; healthy repositories still commit and push. The response carries repository status, failed repository IDs, and affected scope IDs.
8. Per-repository manifests are rebuilt from snapshot metadata. The server aggregates those manifests for the panel and attaches `repositoryId` to every remote entry. Preview, import, restore, and explicit delete route back to that exact repository. Deletion only cleans unreachable objects inside that repository.
9. None of this touches the live SillyTavern `data` tree. Every Git workspace remains under `user/files/chat-vault/cloud/remotes/<repoKey>/repo/`.

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
│   vault-pool.json                            │
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

### The GitHub token is never persisted to `.git/config`

The cloud remote URL stored in `.git/config` is always token-free (for example
`https://github.com/<owner>/<repo>.git`). Authentication is supplied per Git
invocation through a process-level `-c http.<url>.extraHeader=Authorization: Basic <base64>`
override, which is passed on the command line for that one command and never
written to disk. This keeps the token in exactly one place — the server-side
`cloud-config.json` the user filled in — instead of duplicating it into the
repository config where it would ride along with backups.

Repository-pool membership is different: `vault-pool.json` is deliberately replicated to healthy repositories so another device can discover repository URLs and scope homes. It contains no token, local path, or device name.

Two supporting behaviors make this robust:

- The `extraHeader` is scoped to the exact configured remote URL, so the token is only ever sent to that host.
- `ensureCloudRepositoryReady` always rewrites the stored remote to the clean URL. If an older version baked `x-access-token:...@` credentials into the URL, the next sync strips them, migrating a polluted `.git/config` back to a clean state with no user action.

In containerized deployments (the common case) there is no OS credential
helper, so this header override is also the only path by which the token
reaches Git — the same mechanism serves both the security goal and normal
operation.

### Installer root detection accepts deployed layouts

The installer resolves an effective SillyTavern root before copying files.
It accepts either source-root markers or deployed install-directory signals:

- source-root markers: `public/script.js` plus `src/plugin-loader.js`
- install-directory signals: at least two of `plugins/`, `data/`, and `config/`

If the path passed to the installer is a wrapper directory and its `docker/` child matches those rules, the effective root becomes `docker/`.
That means plugin and config writes go to `docker/plugins/` and `docker/config/`, while user extension targets are discovered from that effective root's data directories.

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
