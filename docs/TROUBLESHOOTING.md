# Troubleshooting

This guide covers the most common setup and runtime issues for Chat Vault.

## The Drawer Shows "Backend Missing"

Check these points:

- `plugins/chat-vault/index.mjs` exists under the target SillyTavern root
- `config.yaml` has `enableServerPlugins: true`
- SillyTavern has been restarted after installation
- the server startup log shows `chat-vault` being initialized

If the front-end extension is present but the server plugin is not loaded, the panel can open but backup APIs will fail.

## The Installer Picked The Wrong SillyTavern

Pass the target path explicitly:

```bash
node install.mjs /path/to/SillyTavern
```

or:

```bash
SILLYTAVERN_DIR=/path/to/SillyTavern node install.mjs
```

If the installer sees multiple valid targets in an interactive terminal, it should ask you to choose instead of guessing.

## The Extension Was Installed But Nothing Appears

Check these points:

- the front-end extension exists under `data/<user>/extensions/chat-vault`
- if your install falls back, check `public/scripts/extensions/third-party/chat-vault`
- SillyTavern was fully reloaded after installation
- the drawer entry exists under extension settings

## No Backups Are Being Created

Check these points:

- `启用自动备份` is on
- a chat is actually open
- backend status is ready
- the event you tested is one of the supported commit events

Also note:

- old-message editing does not intentionally spam backup creation
- manual backup still works through `立即备份`

## I Refreshed Or Crashed And The Original Chat File Is Gone

Use the `灾难恢复` tab.

That view reads Chat Vault's own storage tree and global scope index, not the currently opened chat page.

If needed, inspect:

- `data/<user>/user/files/chat-vault/`

Important:

- this recovery path does not depend on the old chat file still having usable `chat_metadata`

## Restore As New Chat Fails

For character chats, check these points:

- the target character still exists in the current SillyTavern instance
- the character can still be matched by avatar or name

For group chats, check these points:

- the group still exists
- the stored `groupId` still resolves

## Chat Rename Broke Backup Continuity

Chat Vault keeps rename continuity only when the rename goes through SillyTavern's normal API flow.

If you rename chat files directly in the filesystem:

- the front-end cannot intercept that rename
- scope rebind is not triggered automatically

Use SillyTavern's built-in rename UI whenever possible.

## Too Many Auto Backups

Check `自动备份数量` in settings.

Notes:

- `1` means one rolling auto backup
- `N` keeps the latest `N` auto backups
- `长期保留` entries are excluded from normal auto rotation

## Unsaved Edit Restore Did Not Reopen The Editor

This usually means the original message location or anchor no longer matches well enough.

Typical causes:

- the message was deleted
- the message order changed
- the text anchor no longer matches the current chat content

In that case, Chat Vault should still show the unsaved text through fallback preview instead of silently losing it.

## HTTP / Localhost / LAN IP / VPS Access

Chat Vault uses same-origin requests like:

- `/api/plugins/chat-vault/*`

So it works on:

- `localhost`
- plain `http://`
- LAN IP access
- VPS IP access

as long as:

- the front-end extension and server plugin belong to the same SillyTavern instance
- the browser can reach that SillyTavern instance normally

## Before Reporting A Bug

Collect these details:

- Chat Vault version
- SillyTavern version
- install path style: local / Docker / other
- whether the server plugin loaded successfully
- exact reproduction steps
- visible UI error text or console error text
