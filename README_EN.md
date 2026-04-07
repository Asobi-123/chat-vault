# Chat Vault

[中文](README.md)

Chat Vault is a server-backed SillyTavern extension for chat backups, unsaved edit recovery, and disaster recovery.
It can also push selected backups into a Git repository as an off-site cloud vault.

It does not depend on the current chat `jsonl` still being healthy.
It also does not use browser `IndexedDB` as the primary store.

All independent backups and unsaved edits are written to:

- `data/<user>/user/files/chat-vault/`

## When You Need It

- SillyTavern glitches and recent messages disappear, and you want to pull back the latest stage
- you were editing a message, then refresh or crash happened before saving
- the original chat file is broken or no longer opens, but you still want to restore an earlier stage

## Features

- **Commit-level automatic backups** for `MESSAGE_SENT`, `MESSAGE_RECEIVED`, `MESSAGE_DELETED`, and `MESSAGE_SWIPED`
- **Per-turn auto backup merge** so one send/receive round prefers one rolling auto backup instead of piling up endlessly
- **Regenerate/swipe dedupe** to avoid wasting auto-backup slots on the same turn
- **Unsaved edit mirroring** stored separately as `draft.json`
- **Global disaster recovery** that works even when the current chat cannot be opened normally
- **Chat rename continuity** through scope rebind when SillyTavern renames a chat
- **Faster disk flush** by calling `context.saveChat()` after commit events
- **Backup management** with preview, restore-as-new, overwrite-current, long-term keep, rename, and delete
- **Git Cloud Vault** that pushes long-term and stable backups into a separate Git repository for cross-device recovery
- **Resource-aware cloud restore** that can bring over character cards, personas, lorebooks, and groups together with the chat
- **Append-only cloud retention with manual cleanup** so local deletion does not silently wipe older cloud copies
- **Full panel UI** with floating orb, mobile layout, themes, and Chinese/English i18n
- **Better long-list handling** with collapsible modules, inner scrolling panels, and search for both local and cloud backups

## Quick Install

```bash
git clone https://github.com/Asobi-123/chat-vault.git
cd chat-vault
node install.mjs
```

- the installer will auto-detect nearby SillyTavern directories
- if multiple targets are found, it will ask you to choose one in the terminal
- the script does not auto-restart SillyTavern; restart it yourself after installation

## What The Installer Does

- auto-detect the SillyTavern root directory
- prefer installing the front-end extension into `data/<user>/extensions/chat-vault`
- install the server plugin into `plugins/chat-vault`
- set `enableServerPlugins: true` in `config.yaml`
- clean same-name leftovers before reinstall
- keep existing `user/files/chat-vault` backup data untouched

## Explicit Path Install

If you do not want auto-detection, pass the path directly:

```bash
node install.mjs /path/to/SillyTavern
```

or use an environment variable:

```bash
SILLYTAVERN_DIR=/path/to/SillyTavern node install.mjs
```

## Uninstall

```bash
node uninstall.mjs
```

or:

```bash
node uninstall.mjs /path/to/SillyTavern
```

The uninstall script removes the extension and plugin directories.
It does not automatically delete existing backup data under `user/files/chat-vault`.

## Usage

1. Open the `Chat Vault` drawer in extension settings, or tap the floating orb
2. In **Current Chat**, view unsaved edits, auto backups, and manual backups
3. In **Disaster Recovery**, browse global chat scopes and restore any backup as a new chat
4. In **Cloud Vault**, configure the Git repository, sync to the remote vault, browse and search the remote catalog, and import or restore remote backups
5. In **Settings**, adjust auto backup count, flush delay, draft sync interval, naming templates, and themes

## Data Layout

### Install locations

- Front-end extension: `data/<user>/extensions/chat-vault`
- Server plugin: `plugins/chat-vault`

### Runtime data

- Root: `data/<user>/user/files/chat-vault/`
- Global scope index: `scopes-index.json`
- Scope alias bindings: `scope-aliases.json`
- Cloud config: `cloud-config.json`
- Per-scope directory: `scopes/<label>__<scopeId>/`
- Backup index: `index.json`
- Unsaved edit mirror: `draft.json`
- Snapshot files: `snapshots/*.jsonl`
- Git cloud workspace: `cloud/remotes/<repoKey>/repo/`
- Cloud resource metadata: `cloud/remotes/<repoKey>/repo/objects/resource-meta/<kind>/*.json`
- Cloud resource blobs: `cloud/remotes/<repoKey>/repo/objects/resource-data/<kind>/*`

## FAQ

**Q: Why can't I use SillyTavern's built-in "Install Extension" button only?**

Because Chat Vault is not front-end only.
It also requires a SillyTavern server plugin.

**Q: Where are the backups stored?**

They are stored under:

- `data/<user>/user/files/chat-vault/`

**Q: Will uninstall delete my backups?**

No.
The uninstall script removes only the extension and plugin directories by default.

**Q: How do I update it?**

```bash
cd /path/to/chat-vault
git pull
node install.mjs
```

**Q: Why should chat renames go through SillyTavern's own rename flow?**

Because Chat Vault hooks that rename path and keeps old and new chat names bound to the same scope.
Direct filesystem renames do not trigger that binding logic.

**Q: What is the difference between Disaster Recovery and normal chat backups?**

The current-chat page shows backups for the currently active chat line.
The disaster recovery page shows a global scope list independent from the current chat being open, which is useful when the original chat file is broken, missing, or hard to identify.

**Q: Is Cloud Vault real-time sync?**

No.
Local Chat Vault storage is still the main recovery chain.
The Git remote is a low-frequency off-site vault.

**Q: What is the difference between `Import Local` and `Restore as New Chat`?**

`Import Local` puts character cards, personas, lorebooks, groups, and the chat snapshot into this device's normal SillyTavern resource folders plus local Chat Vault storage.
It does not create a live chat file under `data/<user>/chats/` yet.

`Restore as New Chat` imports missing resources first, then creates a brand new live chat file immediately.

**Q: If I delete local cards, personas, lorebooks, or local backups later, will Cloud Vault also lose the old copy?**

Not automatically.
Cloud Vault now behaves like an append-only vault.
Sync only adds or updates published data; it does not silently remove old cloud copies just because one device deleted them locally.
Cloud deletion is explicit and per-backup.

**Q: Why does multi-device Cloud Vault avoid the usual “Git the whole data directory” conflict mess?**

Because it never turns the live `/data` directory into a shared Git working tree.
It writes selected backup objects and linked resources into a separate workspace.
The remote catalog is rebuilt from the cloud snapshot objects already stored there, not from whatever one device still has locally.

## Related Docs

- **Changelog** — [CHANGELOG.md](CHANGELOG.md)
- **Architecture** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Data Model** — [docs/DATA_MODEL.md](docs/DATA_MODEL.md)
- **Manual Testing Checklist** — [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md)
- **Troubleshooting** — [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## License

[AGPL-3.0](LICENSE)
