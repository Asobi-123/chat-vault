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
- `config.yaml` is updated to enable server plugins.

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

Expected:

- Global scope list loads even without relying on the current chat page.
- Search works across known chat labels.
- Preview shows the selected backup contents.
- Restore-as-new creates a new chat successfully.

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
