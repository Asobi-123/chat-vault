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
  cloud-config.json
  scope-aliases.json
  scopes-index.json
  scopes/
    <label>__<scopeId>/
      index.json
      draft.json
      snapshots/
        *.jsonl
  cloud/
    remotes/
      <repoKey>/
        repo/
          vault.json
          manifest.json
          devices/
            <deviceId>.json
          objects/
            meta/
              <scopeId>/
                <snapshotId>.json
            snapshots/
              <scopeId>/
                <snapshotId>.jsonl
```

## Cloud Config File

Stored in:

- `cloud-config.json`

Shape:

```json
{
  "version": 1,
  "repoUrl": "https://github.com/owner/repo.git",
  "branch": "main",
  "githubToken": "server-side only",
  "deviceId": "device-a1b2c3d4e5f6",
  "deviceName": "Mac mini",
  "syncPinned": true,
  "syncLatestStable": true,
  "syncDrafts": false,
  "lastPulledAt": 1775373879279,
  "lastPushedAt": 1775373879279
}
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

## Cloud Vault Marker

Stored in:

- `cloud/remotes/<repoKey>/repo/vault.json`

Shape:

```json
{
  "version": 1,
  "plugin": "chat-vault",
  "storage": "git-cloud-vault",
  "repoKey": "sha1...",
  "branch": "main",
  "createdAt": 1775373879279
}
```

## Cloud Device State

Stored in:

- `cloud/remotes/<repoKey>/repo/devices/<deviceId>.json`

Shape:

```json
{
  "version": 1,
  "deviceId": "device-a1b2c3d4e5f6",
  "deviceName": "Mac mini",
  "syncPinned": true,
  "syncLatestStable": true,
  "syncDrafts": false,
  "updatedAt": 1775373879279,
  "scopes": [
    {
      "scopeId": "83e93963bba31b5cebdc",
      "label": "Character",
      "source": {},
      "snapshotIds": [
        "sha1..."
      ]
    }
  ]
}
```

Notes:

- device state is retained as an auxiliary publish record
- it is no longer the source of truth for the remote catalog
- deleting local backups on one device does not automatically remove older cloud snapshots

## Cloud Snapshot Meta

Stored in:

- `cloud/remotes/<repoKey>/repo/objects/meta/<scopeId>/<snapshotId>.json`

Shape:

```json
{
  "version": 1,
  "scopeId": "83e93963bba31b5cebdc",
  "snapshotId": "sha1...",
  "label": "Character",
  "source": {},
  "createdAt": 1775373879279,
  "trigger": "manual",
  "triggerLabel": "手动备份",
  "mode": "manual",
  "customName": "",
  "pinned": true,
  "milestoneLabel": "长期保留",
  "fingerprint": "sha1...",
  "messageCount": 128,
  "lastMessagePreview": "last message preview",
  "lastMessageName": "Assistant",
  "lastMessageAt": "2026-04-05 @12h 44m 39s",
  "resources": [
    {
      "kind": "character_card",
      "role": "scope_character",
      "hash": "sha1...",
      "fileName": "Character.png",
      "extension": ".png",
      "displayName": "Character",
      "avatarUrl": "Character.png",
      "ownerAvatarUrl": "",
      "groupId": "",
      "groupName": "",
      "worldName": ""
    }
  ],
  "publishedByDevices": [
    {
      "deviceId": "device-a1b2c3d4e5f6",
      "deviceName": "Mac mini",
      "firstUploadedAt": 1775373879279,
      "lastUploadedAt": 1775373879279
    }
  ],
  "snapshotPath": "objects/snapshots/<scopeId>/<snapshotId>.jsonl",
  "publishedFrom": {
    "deviceId": "device-a1b2c3d4e5f6",
    "deviceName": "Mac mini",
    "firstUploadedAt": 1775373879279,
    "lastUploadedAt": 1775373879279
  }
}
```

## Cloud Resource Objects

Stored in:

- `cloud/remotes/<repoKey>/repo/objects/resource-meta/<kind>/<hash>.json`
- `cloud/remotes/<repoKey>/repo/objects/resource-data/<kind>/<hash>.*`

Examples of `kind`:

- `character_card`
- `persona_avatar`
- `persona_profile`
- `world_info`
- `group_definition`

Resource meta shape:

```json
{
  "version": 1,
  "kind": "world_info",
  "hash": "sha1...",
  "fileName": "Lorebook.json",
  "extension": ".json",
  "displayName": "Lorebook",
  "avatarUrl": "",
  "ownerAvatarUrl": "Character.png",
  "groupId": "",
  "groupName": "",
  "worldName": "Lorebook",
  "dataPath": "objects/resource-data/world_info/sha1....json"
}
```

## Cloud Manifest

Stored in:

- `cloud/remotes/<repoKey>/repo/manifest.json`

Shape:

```json
{
  "version": 1,
  "updatedAt": 1775373879279,
  "scopeCount": 1,
  "snapshotCount": 2,
  "deviceCount": 2,
  "scopes": [
    {
      "scopeId": "83e93963bba31b5cebdc",
      "label": "Character",
      "source": {},
      "updatedAt": 1775373879279,
      "entryCount": 2,
      "deviceCount": 2,
      "devices": [
        {
          "deviceId": "device-a1b2c3d4e5f6",
          "deviceName": "Mac mini"
        }
      ],
      "latestEntry": {},
      "entries": [
        {
          "snapshotId": "sha1...",
          "createdAt": 1775373879279,
          "trigger": "manual",
          "triggerLabel": "手动备份",
          "mode": "manual",
          "customName": "",
          "pinned": true,
          "milestoneLabel": "长期保留",
          "fingerprint": "sha1...",
          "messageCount": 128,
          "lastMessagePreview": "last message preview",
          "lastMessageName": "Assistant",
          "lastMessageAt": "2026-04-05 @12h 44m 39s",
          "label": "Character",
          "source": {},
          "resources": [],
          "resourceSummary": {
            "totalCount": 4,
            "characterCardCount": 1,
            "worldInfoCount": 2,
            "groupDefinitionCount": 0,
            "personaAvatarCount": 1,
            "personaProfileCount": 1
          },
          "publishedByDevices": [
            "device-a1b2c3d4e5f6"
          ]
        }
      ]
    }
  ]
}
```

Notes:

- remote snapshot objects are append-only by default
- the latest remote catalog is rebuilt from cloud snapshot metadata, not from `devices/*.json`
- local deletion on one device does not silently remove older cloud snapshots
- cloud cleanup happens only through explicit per-backup deletion
