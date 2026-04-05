# Architecture

## Overview

Chat Vault is a hybrid SillyTavern extension:

- the front-end extension watches chat events, editors, and UI actions
- the server plugin persists backups and drafts under the user data directory

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
├───────────────────────────────────────────────┤
│ Storage Layer                                │
│ data/<user>/user/files/chat-vault/           │
│ scope-aliases.json                           │
│ scopes-index.json                            │
│ scopes/<label>__<scopeId>/                   │
│   index.json                                 │
│   draft.json                                 │
│   snapshots/*.jsonl                          │
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
