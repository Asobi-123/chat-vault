# Data Model

## Extension Settings

Stored in:

- `extension_settings.chatVault`

Current shape:

```json
{
  "enabled": true,
  "showRecoveryToast": true,
  "showTrigger": true,
  "themeId": "auto",
  "autoSlotCount": 1,
  "saveDelayMs": 350,
  "draftMirrorMs": 300,
  "previewMessages": 12,
  "restoreNameTemplate": "{{chat}} - Chat Vault {{time}}",
  "snapshotFileTemplate": "{{name}} - {{mode}} - {{time}}"
}
```

## Source Descriptor

Used by both front end and server plugin to identify a chat line.

```json
{
  "kind": "character",
  "chatId": "Chat Name",
  "groupId": "",
  "avatarUrl": "avatar.png",
  "characterName": "Character",
  "groupName": "",
  "userName": "User",
  "currentName": "Character",
  "aliasKey": "83e93963bba31b5cebdc",
  "scopeKey": "83e93963bba31b5cebdc"
}
```

`aliasKey` is derived from the source descriptor.
`scopeKey` is the resolved stable scope id after alias lookup or rebind.

## Storage Root

Stored in:

- `data/<user>/user/files/chat-vault/`

Top-level contents:

```text
chat-vault/
  scope-aliases.json
  scopes-index.json
  scopes/
    <label>__<scopeId>/
      index.json
      draft.json
      snapshots/
        *.jsonl
```

## Scope Alias File

Stored in:

- `scope-aliases.json`

Shape:

```json
{
  "version": 1,
  "aliases": {
    "83e93963bba31b5cebdc": {
      "scopeId": "83e93963bba31b5cebdc",
      "updatedAt": 1775373879279,
      "source": {
        "kind": "character",
        "chatId": "Chat Name",
        "groupId": "",
        "avatarUrl": "avatar.png",
        "characterName": "Character",
        "groupName": "",
        "userName": "User",
        "currentName": "Character",
        "aliasKey": "83e93963bba31b5cebdc",
        "scopeKey": "83e93963bba31b5cebdc"
      }
    }
  }
}
```

## Global Scope Index

Stored in:

- `scopes-index.json`

Shape:

```json
{
  "version": 1,
  "generatedAt": 1775373879279,
  "scopes": [
    {
      "scopeId": "83e93963bba31b5cebdc",
      "source": {},
      "label": "Character",
      "chatIds": [
        "Chat Name"
      ],
      "chatCount": 1,
      "entryCount": 4,
      "autoCount": 3,
      "manualCount": 1,
      "latestEntry": {},
      "updatedAt": 1775373879279
    }
  ]
}
```

## Per-Scope Index

Stored in:

- `scopes/<label>__<scopeId>/index.json`

Shape:

```json
{
  "version": 1,
  "source": {},
  "entries": [
    {
      "id": "1775373879279-3286f519",
      "createdAt": 1775373879279,
      "trigger": "message_received",
      "triggerLabel": "收到消息",
      "mode": "auto",
      "seriesKey": "turn-1775373879000-abcd1234",
      "turnAnchorKey": "turn-94a50140d81a6f0b",
      "customName": "",
      "pinned": false,
      "milestoneLabel": "",
      "snapshotFile": "Character - auto - 2026-04-05_12-44-39__1775373879279-3286f519.jsonl",
      "fingerprint": "sha1...",
      "messageCount": 128,
      "lastMessagePreview": "last message preview",
      "lastMessageName": "Assistant",
      "lastMessageAt": "2026-04-05 @12h 44m 39s",
      "source": {}
    }
  ]
}
```

Notes:

- `mode` is `auto` or `manual`
- `pinned: true` means long-term keep
- `customName` is the user-facing backup name after manual rename
- `snapshotFile` points to the underlying independent `.jsonl` archive

## Draft File

Stored in:

- `scopes/<label>__<scopeId>/draft.json`

Shape:

```json
{
  "version": 1,
  "source": {},
  "kind": "message",
  "messageId": 27,
  "text": "unsaved draft text",
  "updatedAt": 1775373879279,
  "anchor": {
    "messageId": 27,
    "sendDate": "2026-04-05 @12h 44m 39s",
    "name": "Assistant",
    "textHash": "7f29c1ab"
  }
}
```

`kind` is either:

- `message`
- `reasoning`

## Snapshot File

Stored in:

- `scopes/<label>__<scopeId>/snapshots/*.jsonl`

The file contains a full chat snapshot in JSONL form:

- line 1: snapshot header
- line 2+: chat messages

Header shape:

```json
{
  "chat_metadata": {},
  "user_name": "User",
  "character_name": "Character"
}
```

Message lines are copied from the active SillyTavern chat array at snapshot time.

## Recovery Constraints

- Global recovery depends on Chat Vault's own storage tree, not on the original chat file still existing
- Restore-as-new uses the stored snapshot file contents
- Overwrite-current is only enabled from the active current-chat view, not from the global recovery view
