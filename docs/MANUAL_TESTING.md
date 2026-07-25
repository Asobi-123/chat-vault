# Manual Testing Checklist

This checklist is for validating Chat Vault before pushing a new public version.

## Preconditions

- SillyTavern starts without extension initialization errors.
- `chat-vault` is installed through `install.mjs`.
- The server log shows the plugin being initialized from `plugins/chat-vault`.
- At least one character chat exists.
- Test at least one desktop viewport and one narrow/mobile viewport.

## 1. Installer Auto Detection

Steps:

1. Place the `chat-vault` project beside a SillyTavern directory.
2. Run `node install.mjs` without passing a path.

Expected:

- If only one nearby SillyTavern exists, the installer finds it automatically.
- If multiple nearby SillyTavern directories exist, the installer asks which one to use.
- the active config file is updated to enable server plugins, usually `config/config.yaml` and otherwise root `config.yaml`.

## 1A. Installer Docker Layout Compatibility

Steps:

1. Test a classic layout with `data/default-user/settings.json`.
2. Test an install-root layout that has `plugins/`, `data/`, and `config/` but does not include SillyTavern source-root marker files.
3. Test a root layout with Docker-mounted user data at `docker/data/default-user/settings.json`.
4. Test a wrapper layout where the path passed to the installer contains a full SillyTavern root under `docker/`.
5. Test a wrapper layout where `docker/` has `plugins/`, `data/`, and `config/` but no source-root marker files.
6. Test a mixed layout where both `data/default-user` and `docker/data/default-user` exist under the same root.
7. Run `node install.mjs /path/to/SillyTavern` for each layout.

Expected:

- Classic layout installs the front-end extension into `data/default-user/extensions/chat-vault`.
- Install-root layout is accepted when `plugins` / `data` / `config` signals are present.
- Docker-mounted user data layout installs the front-end extension into `docker/data/default-user/extensions/chat-vault` or the compose-mounted `/home/node/app/data` host directory.
- Wrapper layout resolves the effective SillyTavern root to `docker/`, installs the server plugin into `docker/plugins/chat-vault`, and updates `docker/config/config.yaml`.
- Mixed layout installs into both user data locations instead of replacing one with the other.
- In non-wrapper layouts, the server plugin still installs into `plugins/chat-vault` under the detected root.

## 2. Backend Ready And Panel Entry

Steps:

1. Open SillyTavern.
2. Open the `聊天保险箱` drawer in extension settings.
3. Open the floating panel.

Expected:

- The drawer renders normally.
- The floating orb is visible when enabled.
- Backend status shows ready instead of missing.
- The panel opens and tabs switch correctly.

## 3. Auto Backup Merge By Turn

Steps:

1. Open a chat with existing messages.
2. Send one new user message.
3. Wait for one assistant reply.
4. Refresh the backup list.

Expected:

- A rolling auto backup is created or refreshed.
- One send/receive round prefers one auto backup entry instead of separate endless duplicates.
- Message count and last-message preview update to the latest state.

## 4. Regenerate / Swipe Behavior

Steps:

1. Trigger regenerate or swipe on the latest assistant reply.
2. Let the new result finish.
3. Refresh the backup list.

Expected:

- Auto backup quota is not consumed by accumulating stale sibling entries from the same turn.
- The latest relevant auto backup is refreshed or replaced as intended.

## 5. Manual Backup, Rename, Delete, Long-Term Keep

Steps:

1. Click `立即备份`.
2. Rename that backup.
3. Toggle `长期保留`.
4. Delete another removable backup.

Expected:

- Manual backup creates a distinct retained entry.
- Renaming changes both the display name and underlying snapshot filename.
- Long-term keep prevents that backup from being rotated out by auto cleanup.
- Deleted backup disappears and does not come back after refresh.

## 6. Unsaved Edit Recovery

Steps:

1. Edit an existing message without saving.
2. Wait for draft sync.
3. Refresh the page or reopen the chat.
4. Use `找回未保存编辑`.

Expected:

- The unsaved edit is detected after reload.
- Restoring reopens the matching editor when possible.
- If exact editor restoration fails, the text is still available through fallback preview.
- Clearing the draft removes the reminder.

## 7. Editing Old Messages Does Not Create Backup Noise

Steps:

1. Open edit mode on an older message.
2. Type and save the edit.
3. Refresh the backup list.

Expected:

- Message editing itself does not create a new backup entry just because the old message was edited.

## 8. Disaster Recovery

Steps:

1. Open the `灾难恢复` tab.
2. Refresh the scope list.
3. Search for a known character or chat.
4. Open one scope and preview a backup.
5. Restore one backup as a new chat.
6. Delete the last backup in a disposable scope, then refresh the recovery list.
7. In a disposable scope, click `删除全部备份`.
8. If old 0-backup shells exist, click `清理空记录`.

Expected:

- Global scope list loads even without relying on the current chat page.
- Search works across known chat labels.
- Preview shows the selected backup contents.
- Restore-as-new creates a new chat successfully.
- Deleting the last local backup removes the empty scope from the recovery list.
- `删除全部备份` removes that whole local recovery scope without deleting the live SillyTavern chat file.
- `清理空记录` removes old empty scope shells without touching scopes that still contain backups, draft mirrors, or snapshot files.

## 9. Chat Rename Continuity

Steps:

1. Rename a chat using SillyTavern's normal rename flow.
2. Reopen Chat Vault.
3. Check current backups and disaster recovery list.

Expected:

- Existing backups remain attached to the same logical chat line.
- Disaster recovery reflects the new chat name without splitting history unexpectedly.

## 10. Theme, I18n, And Mobile Layout

Steps:

1. Switch between themes.
2. Check Chinese and English UI.
3. Open the panel on desktop width and narrow/mobile width.

Expected:

- Theme switch updates the panel and floating orb together.
- No missing i18n keys appear.
- Mobile layout remains usable and the floating orb stays in a visible position.

## 11. Cloud Repository Pool

Use three disposable repositories. The first two must be writable. Configure the third with a deliberately invalid URL or credentials.

Steps:

1. Start from an existing one-repository Cloud Vault and upgrade to this version. Resize the browser to a half-height window, then open the panel and the cloud tab without changing fields. Confirm the panel title, tabs, action row, and the two cloud browsing columns all remain inside the visible viewport. Confirm the `?` help button opens the usage explanation.
2. Confirm that old remote backups still list, preview, import, and restore normally.
3. Select `Manage Repositories`. Confirm `Sync Settings` is visible above `Repository Pool`, and the repository editor shows URL, access token, and branch without an expandable advanced section. Then select `Add Repository`. Confirm the URL field receives focus. Cancel once and confirm no empty repository row remains. Add it again, leaving the optional access token blank when the catalog token can access it, then use `Add and Connect`.
4. Create or select several independent chat scopes, make one stable or long-term backup in each, then sync again.
5. Check that the repository manager shows two available repositories, and that cloud backup cards show a repository tag. Preview, import, restore-as-new, and delete one backup from each repository.
6. Add or retain an invalid third repository, then sync. Refresh the cloud list afterwards.
7. On another device, connect only the catalog repository using the normal first-repository flow. Confirm that the additional repository URL is discovered. Provide a local token if that repository is private, then refresh and restore an entry from it.
8. Add another healthy repository and sync again. Confirm existing scope entries keep their original repository tags rather than moving automatically.

Expected:

- Existing one-repository data remains readable without re-entering the old token or moving remote objects.
- The Cloud Vault landing view shows sync, repository management, and the two remote browsing columns without a long configuration form pushing the lists out of the initial view.
- Cancelling an added repository leaves no blank repository in the local configuration. `Add and Connect` saves and verifies a valid repository in one action.
- A shared default token is reused for a newly added repository; an override is needed only for a different permission boundary.
- Each scope's complete cloud copy remains in one repository. Large snapshots still restore through their existing chunk path.
- The aggregate list can operate on entries from both healthy repositories, and each action reaches its tagged source repository.
- The failing repository is marked unavailable. Healthy repositories still complete, and the completion notice identifies a partial result.
- The other device discovers repository URLs but never receives a token from `vault-pool.json`.
- No existing scope is automatically rebalanced, deleted, or moved after adding a repository.

## Release Gate

Before pushing or tagging a public release:

- `extension/manifest.json` version matches the intended release version.
- `README.md` and `README_EN.md` match the current install flow.
- `CHANGELOG.md` contains the release entry and date.
- No retired project names remain in the repo.
- `node --check` passes for:
  - `extension/index.js`
  - `server-plugin/index.mjs`
  - `install.mjs`
  - `uninstall.mjs`
  - `sillytavern-paths.mjs`
- `node tests/cloud-snapshot.test.mjs` passes. It generates a disposable 100+ MiB JSONL fixture, verifies chunked cloud storage and restore, then commits and pushes the resulting small Git blobs to a temporary bare remote.
- `node tests/cloud-pool.test.mjs` passes. It validates v1 migration, stable routing, aggregate provenance, two healthy temporary bare remotes, and one failing repository remote.
