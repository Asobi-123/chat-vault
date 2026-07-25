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
          vault-pool.json
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
            snapshot-chunks/
              <chunkSha1>.jsonl.gz
```

## Cloud Config File

Stored in:

- `cloud-config.json`

Shape:

```json
{
  "version": 2,
  "poolId": "pool-...",
  "catalogRepositoryId": "repo-...",
  "defaultGithubToken": "server-side only",
  "deviceId": "device-a1b2c3d4e5f6",
  "deviceName": "Mac mini",
  "syncPinned": true,
  "syncLatestStable": true,
  "syncDrafts": false,
  "repositories": [
    {
      "repositoryId": "repo-...",
      "repoUrl": "https://github.com/owner/repo.git",
      "branch": "main",
      "githubTokenOverride": "server-side only or empty",
      "addedAt": 1775373879279,
      "lastPulledAt": 1775373879279,
      "lastPushedAt": 1775373879279
    }
  ]
}
```

`version: 1` is read as a one-repository pool. Its existing `repoUrl`, `branch`, and `githubToken` become the catalog repository and `defaultGithubToken`; no remote object is moved.

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
- Reading snapshot status for a missing scope does not create a new empty scope directory
- Empty scope cleanup removes only scopes with no backup entries, no `draft.json`, and no snapshot files; matching aliases are removed and `scopes-index.json` is rebuilt
- Scope-level delete removes one selected local recovery scope, including all snapshot files, `draft.json`, matching aliases, and the rebuilt `scopes-index.json`; it does not delete the live SillyTavern chat file

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
  "poolId": "pool-...",
  "repositoryId": "repo-...",
  "createdAt": 1775373879279
}
```

`poolId` and `repositoryId` are optional on older repositories. They are added when that repository joins a pool and prevent a configured repository from being mistaken for a different pool repository.

## Cloud Pool Descriptor

Stored in every healthy repository:

- `cloud/remotes/<repoKey>/repo/vault-pool.json`

Shape:

```json
{
  "version": 1,
  "poolId": "pool-...",
  "catalogRepositoryId": "repo-catalog...",
  "members": [
    {
      "repositoryId": "repo-catalog...",
      "repoUrl": "https://github.com/owner/vault-a.git",
      "branch": "main",
      "addedAt": 1775373879279
    }
  ],
  "scopeHomes": {
    "83e93963bba31b5cebdc": {
      "repositoryId": "repo-catalog...",
      "assignedAt": 1775373879279,
      "assignedLogicalBytes": 110100480
    }
  },
  "createdAt": 1775373879279,
  "updatedAt": 1775373879279
}
```

The descriptor deliberately contains no token, local filesystem path, or device name. The catalog repository is the serialized source for new assignments; the same descriptor is copied to healthy data repositories after it commits.

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
  "logicalBytes": 110100480,
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
  "snapshotStorage": {
    "format": "chunked-gzip-v1",
    "rawSize": 110100480,
    "chunkSize": 8388608,
    "chunks": [
      {
        "hash": "sha1...",
        "rawSize": 8388608,
        "compressedSize": 123456,
        "path": "objects/snapshot-chunks/<chunkSha1>.jsonl.gz"
      }
    ]
  },
  "publishedFrom": {
    "deviceId": "device-a1b2c3d4e5f6",
    "deviceName": "Mac mini",
    "firstUploadedAt": 1775373879279,
    "lastUploadedAt": 1775373879279
  }
}
```

`snapshotStorage` is optional for compatibility with earlier cloud backups. Missing it means the reader uses `snapshotPath` as a normal JSONL file. New snapshots larger than 40 MiB use `chunked-gzip-v1`: each physical Git object contains at most 8 MiB of uncompressed JSONL, is gzip-compressed independently, and is verified by SHA-1 before restore.

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
  "logicalBytes": 220200960,
  "scopes": [
    {
      "scopeId": "83e93963bba31b5cebdc",
      "label": "Character",
      "source": {},
      "updatedAt": 1775373879279,
      "entryCount": 2,
      "deviceCount": 2,
      "logicalBytes": 220200960,
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
          "logicalBytes": 110100480,
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
- a failed local snapshot is omitted from that sync only; other selected snapshots continue, and the response reports its skip
- in a repository pool, this manifest remains local to one repository; the panel aggregates it and adds `repositoryId` only to the API response, not to this stored file
- `logicalBytes` is the selected JSONL payload size used to choose a home for new scopes. Older metas and manifests without it remain readable and contribute `0` until rewritten
