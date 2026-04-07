import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const info = {
    id: 'chat-vault',
    name: 'Chat Vault',
    description: 'Server-backed chat backups, unsaved edit mirror, and recovery APIs for SillyTavern chats.',
};

const DATA_FOLDER_NAME = 'chat-vault';
const INDEX_FILE_NAME = 'index.json';
const DRAFT_FILE_NAME = 'draft.json';
const ALIASES_FILE_NAME = 'scope-aliases.json';
const SCOPES_INDEX_FILE_NAME = 'scopes-index.json';
const CLOUD_CONFIG_FILE_NAME = 'cloud-config.json';
const CLOUD_ROOT_DIRECTORY_NAME = 'cloud';
const CLOUD_REMOTES_DIRECTORY_NAME = 'remotes';
const CLOUD_REPO_DIRECTORY_NAME = 'repo';
const CLOUD_DEVICES_DIRECTORY_NAME = 'devices';
const CLOUD_OBJECTS_DIRECTORY_NAME = 'objects';
const CLOUD_META_DIRECTORY_NAME = 'meta';
const CLOUD_SNAPSHOTS_DIRECTORY_NAME = 'snapshots';
const CLOUD_RESOURCE_META_DIRECTORY_NAME = 'resource-meta';
const CLOUD_RESOURCE_DATA_DIRECTORY_NAME = 'resource-data';
const CLOUD_MARKER_FILE_NAME = 'vault.json';
const CLOUD_MANIFEST_FILE_NAME = 'manifest.json';
const CLOUD_FORMAT_VERSION = 1;
const DEFAULT_CLOUD_BRANCH = 'main';
const DEFAULT_MAX_AUTO_SNAPSHOTS = 1;
const DEFAULT_PREVIEW_MESSAGES = 12;
const MAX_REQUEST_SIZE = '64mb';
const cloudRepoOperationQueue = new Map();

function assertUser(request, response) {
    if (!request.user?.directories?.files) {
        response.sendStatus(403);
        return false;
    }
    return true;
}

function asString(value) {
    return value === undefined || value === null ? '' : String(value);
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function sha1(value) {
    return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function hashText(value) {
    const text = asString(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function truncate(text, maxLength = 160) {
    const normalized = asString(text).replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function createId() {
    const random = crypto.randomBytes(4).toString('hex');
    return `${Date.now()}-${random}`;
}

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
    return directoryPath;
}

function writeTextAtomic(filePath, text) {
    ensureDirectory(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, text, 'utf8');
    fs.renameSync(tempPath, filePath);
}

function writeBufferAtomic(filePath, buffer) {
    ensureDirectory(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, filePath);
}

function writeJsonAtomic(filePath, value) {
    writeTextAtomic(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) {
        return fallback;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn('[chat-vault] Failed to parse JSON file:', filePath, error);
        return fallback;
    }
}

function deleteFileSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.warn('[chat-vault] Failed to delete file:', filePath, error);
    }
}

function buildSourceAliasKey(source) {
    const scopeSeed = JSON.stringify({
        kind: asString(source.kind).trim() === 'group' ? 'group' : 'character',
        chatId: asString(source.chatId).trim(),
        groupId: asString(source.groupId).trim(),
        avatarUrl: asString(source.avatarUrl).trim(),
    });
    return sha1(scopeSeed).slice(0, 20);
}

function normalizeSource(rawSource) {
    const source = asObject(rawSource);
    const kind = asString(source.kind).trim() === 'group' ? 'group' : 'character';
    const chatId = asString(source.chatId).trim();
    const groupId = asString(source.groupId).trim();
    const avatarUrl = asString(source.avatarUrl).trim();
    const characterName = asString(source.characterName).trim();
    const groupName = asString(source.groupName).trim();
    const userName = asString(source.userName).trim() || 'unused';
    const currentName = asString(source.currentName).trim();
    const aliasKey = buildSourceAliasKey({ kind, chatId, groupId, avatarUrl });

    return {
        kind,
        chatId,
        groupId,
        avatarUrl,
        characterName,
        groupName,
        userName,
        currentName,
        aliasKey,
        scopeKey: aliasKey,
    };
}

function getBaseDirectory(request) {
    return ensureDirectory(path.join(request.user.directories.files, DATA_FOLDER_NAME));
}

function getAliasesPath(baseDirectory) {
    return path.join(baseDirectory, ALIASES_FILE_NAME);
}

function getScopesIndexPath(baseDirectory) {
    return path.join(baseDirectory, SCOPES_INDEX_FILE_NAME);
}

function buildEmptyAliases() {
    return {
        version: 1,
        aliases: {},
    };
}

function readAliases(baseDirectory) {
    const raw = readJson(getAliasesPath(baseDirectory), buildEmptyAliases());
    const aliases = {};

    for (const [aliasKey, value] of Object.entries(asObject(raw.aliases))) {
        const entry = asObject(value);
        const scopeId = asString(entry.scopeId).trim();
        if (!scopeId) {
            continue;
        }

        aliases[aliasKey] = {
            scopeId,
            updatedAt: Math.trunc(asFiniteNumber(entry.updatedAt, Date.now())),
            source: normalizeSource(entry.source),
        };
    }

    return {
        version: 1,
        aliases,
    };
}

function saveAliases(baseDirectory, aliases) {
    writeJsonAtomic(getAliasesPath(baseDirectory), aliases);
}

function buildEmptyScopesIndex() {
    return {
        version: 1,
        generatedAt: 0,
        scopes: [],
    };
}

function saveScopesIndex(baseDirectory, scopesIndex) {
    writeJsonAtomic(getScopesIndexPath(baseDirectory), scopesIndex);
}

function upsertAlias(aliases, source, scopeId) {
    const aliasKey = asString(source.aliasKey).trim() || buildSourceAliasKey(source);
    if (!aliasKey || !scopeId) {
        return false;
    }

    const nextEntry = {
        scopeId,
        updatedAt: Date.now(),
        source: {
            kind: source.kind,
            chatId: source.chatId,
            groupId: source.groupId,
            avatarUrl: source.avatarUrl,
            characterName: source.characterName,
            groupName: source.groupName,
            userName: source.userName,
            currentName: source.currentName,
            aliasKey,
            scopeKey: scopeId,
        },
    };

    const previousEntry = aliases.aliases[aliasKey];
    if (previousEntry?.scopeId === nextEntry.scopeId
        && JSON.stringify(previousEntry.source) === JSON.stringify(nextEntry.source)) {
        return false;
    }

    aliases.aliases[aliasKey] = nextEntry;
    return true;
}

function sanitizePathPart(value, fallback = 'chat', maxLength = 48) {
    const normalized = asString(value)
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) {
        return fallback;
    }
    return normalized.slice(0, Math.max(1, maxLength));
}

function tryDecodePathPart(value) {
    const text = asString(value).trim();
    if (!text) {
        return '';
    }

    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

function buildScopeFolderName(source) {
    const label = source.kind === 'group'
        ? (source.groupName || source.currentName || source.chatId || 'group')
        : (source.characterName || source.currentName || source.chatId || 'character');
    return `${sanitizePathPart(label)}__${source.scopeKey}`;
}

function findScopeDirectoryById(scopesRoot, scopeId) {
    if (!fs.existsSync(scopesRoot)) {
        return null;
    }

    const normalizedScopeId = asString(scopeId).trim();
    if (!normalizedScopeId) {
        return null;
    }

    const expectedSuffix = `__${normalizedScopeId}`;
    const children = fs.readdirSync(scopesRoot, { withFileTypes: true });
    const matchedChild = children.find((child) => {
        return child.isDirectory() && (child.name === normalizedScopeId || child.name.endsWith(expectedSuffix));
    });
    if (!matchedChild) {
        return null;
    }

    return path.join(scopesRoot, matchedChild.name);
}

function findExistingScopeDirectory(scopesRoot, source) {
    return findScopeDirectoryById(scopesRoot, source.scopeKey);
}

function sourceMatchesDescriptor(storedSource, candidateSource) {
    if (!storedSource || !candidateSource) {
        return false;
    }

    if (candidateSource.kind && asString(storedSource.kind) !== asString(candidateSource.kind)) {
        return false;
    }

    if (candidateSource.chatId && asString(storedSource.chatId) !== asString(candidateSource.chatId)) {
        return false;
    }

    if (candidateSource.groupId && asString(storedSource.groupId) !== asString(candidateSource.groupId)) {
        return false;
    }

    if (candidateSource.avatarUrl && asString(storedSource.avatarUrl) !== asString(candidateSource.avatarUrl)) {
        return false;
    }

    return true;
}

function findScopeIdByDescriptor(scopesRoot, aliases, source) {
    const exactScopeId = asString(aliases.aliases[source.aliasKey]?.scopeId).trim();
    if (exactScopeId) {
        return exactScopeId;
    }

    for (const entry of Object.values(aliases.aliases)) {
        if (sourceMatchesDescriptor(entry?.source, source)) {
            return asString(entry.scopeId).trim();
        }
    }

    if (findScopeDirectoryById(scopesRoot, source.aliasKey)) {
        return source.aliasKey;
    }

    if (!fs.existsSync(scopesRoot)) {
        return '';
    }

    const children = fs.readdirSync(scopesRoot, { withFileTypes: true });
    for (const child of children) {
        if (!child.isDirectory()) {
            continue;
        }

        const scopeDirectory = path.join(scopesRoot, child.name);
        const index = readJson(path.join(scopeDirectory, INDEX_FILE_NAME), null);
        const indexSource = asObject(index?.source);
        if (!sourceMatchesDescriptor(indexSource, source)) {
            continue;
        }

        const storedScopeId = asString(indexSource.scopeKey).trim();
        return storedScopeId || child.name.split('__').pop() || '';
    }

    return '';
}

function resolveScopedSource(baseDirectory, scopesRoot, rawSource) {
    const source = normalizeSource(rawSource);
    const aliases = readAliases(baseDirectory);
    const scopeId = findScopeIdByDescriptor(scopesRoot, aliases, source) || source.aliasKey;
    const resolvedSource = {
        ...source,
        scopeKey: scopeId,
    };

    if (upsertAlias(aliases, resolvedSource, scopeId)) {
        saveAliases(baseDirectory, aliases);
    }

    return resolvedSource;
}

function rebindChatScope(request, oldRawSource, newRawSource) {
    const baseDirectory = getBaseDirectory(request);
    const scopesRoot = ensureDirectory(path.join(baseDirectory, 'scopes'));
    const oldSource = normalizeSource(oldRawSource);
    const newSource = normalizeSource(newRawSource);
    const aliases = readAliases(baseDirectory);
    const scopeId = findScopeIdByDescriptor(scopesRoot, aliases, oldSource)
        || findScopeIdByDescriptor(scopesRoot, aliases, newSource)
        || oldSource.aliasKey
        || newSource.aliasKey;

    const resolvedOldSource = {
        ...oldSource,
        scopeKey: scopeId,
    };
    const resolvedNewSource = {
        ...newSource,
        scopeKey: scopeId,
    };

    const oldAliasChanged = upsertAlias(aliases, resolvedOldSource, scopeId);
    const newAliasChanged = upsertAlias(aliases, resolvedNewSource, scopeId);
    const aliasesChanged = oldAliasChanged || newAliasChanged;
    if (aliasesChanged) {
        saveAliases(baseDirectory, aliases);
    }

    const scopePaths = getScopePaths(request, resolvedNewSource);
    const index = readIndex(scopePaths, scopePaths.source);
    index.source = scopePaths.source;
    saveIndex(scopePaths, index);

    return {
        scopeId,
        source: scopePaths.source,
    };
}

function getScopePathsFromBaseDirectory(baseDirectory, source) {
    const scopesRoot = ensureDirectory(path.join(baseDirectory, 'scopes'));
    const resolvedSource = resolveScopedSource(baseDirectory, scopesRoot, source);
    const preferredScopeDirectory = path.join(scopesRoot, buildScopeFolderName(resolvedSource));
    const legacyScopeDirectory = path.join(scopesRoot, resolvedSource.scopeKey);
    const existingScopeDirectory = findExistingScopeDirectory(scopesRoot, resolvedSource);

    let scopeDirectory = preferredScopeDirectory;

    if (fs.existsSync(preferredScopeDirectory)) {
        scopeDirectory = preferredScopeDirectory;
    } else if (existingScopeDirectory) {
        scopeDirectory = existingScopeDirectory;
    } else if (fs.existsSync(legacyScopeDirectory)) {
        try {
            fs.renameSync(legacyScopeDirectory, preferredScopeDirectory);
            scopeDirectory = preferredScopeDirectory;
        } catch (error) {
            console.warn('[chat-vault] Failed to migrate legacy scope directory:', legacyScopeDirectory, error);
            scopeDirectory = legacyScopeDirectory;
        }
    }

    ensureDirectory(scopeDirectory);
    return {
        baseDirectory,
        scopesRoot,
        source: resolvedSource,
        scopeDirectory,
        snapshotsDirectory: ensureDirectory(path.join(scopeDirectory, 'snapshots')),
        indexPath: path.join(scopeDirectory, INDEX_FILE_NAME),
        draftPath: path.join(scopeDirectory, DRAFT_FILE_NAME),
    };
}

function getScopePaths(request, source) {
    return getScopePathsFromBaseDirectory(getBaseDirectory(request), source);
}

function listScopeDirectories(scopesRoot) {
    if (!fs.existsSync(scopesRoot)) {
        return [];
    }

    return fs.readdirSync(scopesRoot, { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => path.join(scopesRoot, child.name));
}

function collectScopeAliases(aliases, scopeId) {
    return Object.values(aliases.aliases)
        .filter((entry) => asString(entry.scopeId).trim() === scopeId)
        .map((entry) => ({
            updatedAt: Math.trunc(asFiniteNumber(entry.updatedAt, 0)),
            source: asObject(entry.source),
        }))
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

function buildGlobalScopeSummary(scopeDirectory, aliases) {
    const indexPath = path.join(scopeDirectory, INDEX_FILE_NAME);
    if (!fs.existsSync(indexPath)) {
        return null;
    }

    const index = readJson(indexPath, null);
    const source = asObject(index?.source);
    const entries = asArray(index?.entries)
        .map((entry) => asObject(entry))
        .filter((entry) => asString(entry.id))
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    const scopeId = asString(source.scopeKey).trim() || path.basename(scopeDirectory).split('__').pop() || '';
    if (!scopeId) {
        return null;
    }

    const latestEntry = entries[0] ? withoutJsonl(entries[0]) : null;
    const aliasSources = collectScopeAliases(aliases, scopeId);
    const chatIds = Array.from(new Set([
        asString(source.chatId).trim(),
        ...aliasSources.map((item) => asString(item.source?.chatId).trim()),
    ].filter(Boolean)));
    const summarySource = {
        ...source,
        scopeKey: scopeId,
        aliasKey: asString(source.aliasKey).trim() || buildSourceAliasKey(source),
    };
    const updatedAt = Math.max(
        Number(latestEntry?.createdAt || 0),
        ...aliasSources.map((item) => Number(item.updatedAt || 0)),
    );

    return {
        scopeId,
        source: summarySource,
        label: summarySource.kind === 'group'
            ? (summarySource.groupName || summarySource.currentName || summarySource.chatId || scopeId)
            : (summarySource.characterName || summarySource.currentName || summarySource.chatId || scopeId),
        chatIds,
        chatCount: chatIds.length,
        entryCount: entries.length,
        autoCount: entries.filter((entry) => entry.mode === 'auto').length,
        manualCount: entries.filter((entry) => entry.mode !== 'auto').length,
        latestEntry,
        updatedAt,
    };
}

function rebuildScopesIndex(baseDirectory, scopesRoot) {
    const aliases = readAliases(baseDirectory);
    const scopes = listScopeDirectories(scopesRoot)
        .map((scopeDirectory) => buildGlobalScopeSummary(scopeDirectory, aliases))
        .filter(Boolean)
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

    const scopesIndex = {
        version: 1,
        generatedAt: Date.now(),
        scopes,
    };

    saveScopesIndex(baseDirectory, scopesIndex);
    return scopesIndex;
}

function normalizeMaxAutoSnapshots(value) {
    const number = Math.trunc(asFiniteNumber(value, DEFAULT_MAX_AUTO_SNAPSHOTS));
    if (number === -1) return -1;
    if (number < 1) return DEFAULT_MAX_AUTO_SNAPSHOTS;
    return Math.min(number, 500);
}

function normalizePreviewLimit(value) {
    const number = Math.trunc(asFiniteNumber(value, DEFAULT_PREVIEW_MESSAGES));
    return Math.min(Math.max(number, 1), 100);
}

function buildEmptyIndex(source) {
    return {
        version: 1,
        source,
        entries: [],
    };
}

function readIndex(paths, source) {
    const index = readJson(paths.indexPath, buildEmptyIndex(source));
    const entries = asArray(index.entries)
        .map((entry) => asObject(entry))
        .filter((entry) => asString(entry.id));

    return {
        version: 1,
        source: asObject(index.source)?.scopeKey ? index.source : source,
        entries: entries.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0)),
    };
}

function saveIndex(paths, index) {
    writeJsonAtomic(paths.indexPath, index);
}

function snapshotToJsonl(snapshot) {
    return snapshot.map((entry) => JSON.stringify(entry)).join('\n');
}

function readSnapshotFile(snapshotPath) {
    if (!fs.existsSync(snapshotPath)) {
        throw new Error(`Snapshot file not found: ${snapshotPath}`);
    }

    const rawText = fs.readFileSync(snapshotPath, 'utf8');
    const lines = rawText.split('\n').filter((line) => line.trim().length > 0);
    const snapshot = [];

    for (const line of lines) {
        snapshot.push(JSON.parse(line));
    }

    return snapshot;
}

function getSnapshotSummary(snapshot) {
    const header = asObject(snapshot[0]);
    const messages = snapshot.slice(1).filter((item) => item && typeof item === 'object');
    const lastMessage = messages.length > 0 ? asObject(messages[messages.length - 1]) : null;

    return {
        header,
        messages,
        messageCount: messages.length,
        lastMessagePreview: truncate(lastMessage?.mes ?? ''),
        lastMessageName: truncate(lastMessage?.name ?? ''),
        lastMessageAt: asString(lastMessage?.send_date).trim() || null,
    };
}

function buildTurnAnchorKey(source, snapshot) {
    const messages = snapshot.slice(1).filter((item) => item && typeof item === 'object');
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asObject(messages[index]);
        if (!message.is_user) {
            continue;
        }

        const stableSeed = JSON.stringify({
            kind: source.kind,
            chatId: source.chatId,
            groupId: source.groupId,
            anchor: {
                index,
                sendDate: asString(message.send_date),
                name: asString(message.name),
                textHash: hashText(message.mes),
            },
        });
        return `turn-${sha1(stableSeed).slice(0, 16)}`;
    }

    return '';
}

function toTriggerLabel(trigger) {
    const key = asString(trigger).trim();
    const labels = {
        manual: '手动备份',
        cloud_import: '云端导入',
        message_sent: '发送消息',
        message_received: '收到消息',
        message_updated: '编辑消息',
        message_deleted: '删除消息',
        message_swiped: '切换分支',
        generation_ended: '生成结束',
        chat_changed: '切换聊天',
    };
    return labels[key] || (key ? key : '未知触发');
}

function formatTimeForFile(value) {
    const date = new Date(Number(value) || Date.now());
    const pad = (number) => String(number).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join('-') + '_' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('-');
}

function applySnapshotFileTemplate(template, source, mode, trigger, createdAt) {
    const replacements = {
        chat: source.chatId || '',
        character: source.characterName || '',
        group: source.groupName || '',
        name: source.currentName || source.characterName || source.groupName || source.chatId || '',
        mode,
        trigger,
        time: formatTimeForFile(createdAt),
    };

    return asString(template || '{{name}} - {{mode}} - {{time}}').replace(/{{\s*([a-z_]+)\s*}}/gi, (match, key) => {
        return Object.hasOwn(replacements, key) ? replacements[key] : match;
    });
}

function buildSnapshotFileNameFromLabel(label, id) {
    const safeBase = sanitizePathPart(label, 'snapshot', 96);
    return `${safeBase}__${id}.jsonl`;
}

function buildSnapshotFileName(source, requestBody, mode, trigger, createdAt, id) {
    const rendered = applySnapshotFileTemplate(requestBody?.snapshotFileTemplate, source, mode, trigger, createdAt);
    return buildSnapshotFileNameFromLabel(rendered, id);
}

function createSnapshotEntry(source, snapshot, requestBody) {
    const createdAt = Math.trunc(asFiniteNumber(requestBody.createdAt, Date.now()));
    const trigger = asString(requestBody.trigger).trim() || 'manual';
    const mode = asString(requestBody.mode).trim() === 'auto' ? 'auto' : 'manual';
    const jsonl = snapshotToJsonl(snapshot);
    const summary = getSnapshotSummary(snapshot);
    const fingerprint = sha1(jsonl);
    const id = createId();
    const seriesKey = mode === 'auto' ? asString(requestBody.seriesKey).trim() : '';
    const turnAnchorKey = mode === 'auto' ? buildTurnAnchorKey(source, snapshot) : '';

    return {
        id,
        createdAt,
        trigger,
        triggerLabel: toTriggerLabel(trigger),
        mode,
        seriesKey,
        turnAnchorKey,
        customName: '',
        pinned: Boolean(requestBody.pinned),
        milestoneLabel: requestBody.pinned ? '长期保留' : '',
        snapshotFile: buildSnapshotFileName(source, requestBody, mode, trigger, createdAt, id),
        fingerprint,
        messageCount: summary.messageCount,
        lastMessagePreview: summary.lastMessagePreview,
        lastMessageName: summary.lastMessageName,
        lastMessageAt: summary.lastMessageAt,
        source,
        jsonl,
    };
}

function pruneSnapshots(paths, index, maxAutoSnapshots) {
    if (maxAutoSnapshots === -1) {
        return index;
    }

    let autoCount = 0;
    const keptEntries = [];

    for (const entry of index.entries) {
        if (entry.pinned) {
            keptEntries.push(entry);
            continue;
        }

        if (entry.mode !== 'auto') {
            keptEntries.push(entry);
            continue;
        }

        autoCount += 1;
        if (autoCount <= maxAutoSnapshots) {
            keptEntries.push(entry);
            continue;
        }

        deleteFileSafe(path.join(paths.snapshotsDirectory, entry.snapshotFile));
    }

    index.entries = keptEntries;
    return index;
}

function writeSnapshot(paths, entry) {
    const snapshotPath = path.join(paths.snapshotsDirectory, entry.snapshotFile);
    writeTextAtomic(snapshotPath, entry.jsonl);
}

function renameFileSafe(fromPath, toPath) {
    if (fromPath === toPath) {
        return;
    }

    fs.renameSync(fromPath, toPath);
}

function withoutJsonl(entry) {
    const clone = { ...entry };
    delete clone.jsonl;
    return clone;
}

function sortEntries(entries) {
    return entries.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

function updateSnapshotEntry(existingEntry, candidateEntry) {
    return {
        ...existingEntry,
        createdAt: candidateEntry.createdAt,
        trigger: candidateEntry.trigger,
        triggerLabel: candidateEntry.triggerLabel,
        mode: candidateEntry.mode,
        seriesKey: candidateEntry.seriesKey,
        turnAnchorKey: candidateEntry.turnAnchorKey,
        fingerprint: candidateEntry.fingerprint,
        messageCount: candidateEntry.messageCount,
        lastMessagePreview: candidateEntry.lastMessagePreview,
        lastMessageName: candidateEntry.lastMessageName,
        lastMessageAt: candidateEntry.lastMessageAt,
        source: candidateEntry.source,
        jsonl: candidateEntry.jsonl,
    };
}

function removeOtherAutoEntries(paths, index, keepId) {
    index.entries = index.entries.filter((entry) => {
        const shouldRemove = entry.mode === 'auto' && !entry.pinned && entry.id !== keepId;
        if (shouldRemove) {
            deleteFileSafe(path.join(paths.snapshotsDirectory, entry.snapshotFile));
            return false;
        }
        return true;
    });
    return index;
}

function removeSiblingSeriesAutoEntries(paths, index, seriesKey, keepId) {
    const normalizedSeriesKey = asString(seriesKey).trim();
    if (!normalizedSeriesKey) {
        return index;
    }

    index.entries = index.entries.filter((entry) => {
        const shouldRemove = entry.mode === 'auto'
            && !entry.pinned
            && entry.id !== keepId
            && asString(entry.seriesKey).trim() === normalizedSeriesKey;
        if (shouldRemove) {
            deleteFileSafe(path.join(paths.snapshotsDirectory, entry.snapshotFile));
            return false;
        }
        return true;
    });
    return index;
}

function removeSiblingTurnAutoEntries(paths, index, turnAnchorKey, keepId) {
    const normalizedTurnAnchorKey = asString(turnAnchorKey).trim();
    if (!normalizedTurnAnchorKey) {
        return index;
    }

    index.entries = index.entries.filter((entry) => {
        const shouldRemove = entry.mode === 'auto'
            && !entry.pinned
            && entry.id !== keepId
            && asString(entry.turnAnchorKey).trim() === normalizedTurnAnchorKey;
        if (shouldRemove) {
            deleteFileSafe(path.join(paths.snapshotsDirectory, entry.snapshotFile));
            return false;
        }
        return true;
    });
    return index;
}

function hydrateEntryDerivedFields(paths, source, entry) {
    let changed = false;

    if (!asString(entry.turnAnchorKey).trim()) {
        try {
            const snapshot = readSnapshotFile(path.join(paths.snapshotsDirectory, entry.snapshotFile));
            const turnAnchorKey = buildTurnAnchorKey(source, snapshot);
            if (turnAnchorKey) {
                entry.turnAnchorKey = turnAnchorKey;
                changed = true;
            }
        } catch (error) {
            console.warn('[chat-vault] Failed to hydrate snapshot entry:', entry.snapshotFile, error);
        }
    }

    return changed;
}

function saveDraft(paths, source, rawDraft) {
    const draft = asObject(rawDraft);
    const text = asString(draft.text);
    if (!text.trim()) {
        deleteFileSafe(paths.draftPath);
        return null;
    }

    const normalized = {
        version: 1,
        source,
        kind: asString(draft.kind).trim() === 'reasoning' ? 'reasoning' : 'message',
        messageId: Math.trunc(asFiniteNumber(draft.messageId, -1)),
        text,
        updatedAt: Math.trunc(asFiniteNumber(draft.updatedAt, Date.now())),
        anchor: asObject(draft.anchor),
    };

    writeJsonAtomic(paths.draftPath, normalized);
    return normalized;
}

function getDraft(paths) {
    return readJson(paths.draftPath, null);
}

function buildListResponse(paths, source) {
    const resolvedSource = paths.source || source;
    const index = readIndex(paths, resolvedSource);
    return {
        ok: true,
        source: index.source,
        draft: getDraft(paths),
        entries: index.entries.map(withoutJsonl),
    };
}

function createCloudDeviceId() {
    return `device-${crypto.randomBytes(6).toString('hex')}`;
}

function buildEmptyCloudConfig() {
    return {
        version: CLOUD_FORMAT_VERSION,
        repoUrl: '',
        branch: DEFAULT_CLOUD_BRANCH,
        githubToken: '',
        deviceId: createCloudDeviceId(),
        deviceName: '',
        syncPinned: true,
        syncLatestStable: true,
        syncDrafts: false,
        lastPulledAt: 0,
        lastPushedAt: 0,
    };
}

function normalizeCloudConfig(rawConfig) {
    const config = asObject(rawConfig);
    return {
        version: CLOUD_FORMAT_VERSION,
        repoUrl: asString(config.repoUrl).trim(),
        branch: asString(config.branch).trim() || DEFAULT_CLOUD_BRANCH,
        githubToken: asString(config.githubToken).trim(),
        deviceId: asString(config.deviceId).trim() || createCloudDeviceId(),
        deviceName: asString(config.deviceName).trim(),
        syncPinned: config.syncPinned === undefined ? true : Boolean(config.syncPinned),
        syncLatestStable: config.syncLatestStable === undefined ? true : Boolean(config.syncLatestStable),
        syncDrafts: Boolean(config.syncDrafts),
        lastPulledAt: Math.trunc(asFiniteNumber(config.lastPulledAt, 0)),
        lastPushedAt: Math.trunc(asFiniteNumber(config.lastPushedAt, 0)),
    };
}

function getCloudConfigPath(baseDirectory) {
    return path.join(baseDirectory, CLOUD_CONFIG_FILE_NAME);
}

function readCloudConfig(baseDirectory) {
    return normalizeCloudConfig(readJson(getCloudConfigPath(baseDirectory), buildEmptyCloudConfig()));
}

function saveCloudConfig(baseDirectory, rawConfig) {
    const config = normalizeCloudConfig(rawConfig);
    writeJsonAtomic(getCloudConfigPath(baseDirectory), config);
    return config;
}

function getSafeCloudConfig(config) {
    const normalized = normalizeCloudConfig(config);
    return {
        ...normalized,
        githubToken: '',
        hasToken: Boolean(normalized.githubToken),
    };
}

function buildCloudRemoteKey(config) {
    const repoUrl = asString(config.repoUrl).trim();
    const branch = asString(config.branch).trim() || DEFAULT_CLOUD_BRANCH;
    return sha1(`${repoUrl}|${branch}`).slice(0, 20);
}

function getCloudPaths(baseDirectory, rawConfig) {
    const config = normalizeCloudConfig(rawConfig);
    const cloudRoot = ensureDirectory(path.join(baseDirectory, CLOUD_ROOT_DIRECTORY_NAME));
    const remotesRoot = ensureDirectory(path.join(cloudRoot, CLOUD_REMOTES_DIRECTORY_NAME));
    const remoteRoot = ensureDirectory(path.join(remotesRoot, buildCloudRemoteKey(config)));
    const repoPath = ensureDirectory(path.join(remoteRoot, CLOUD_REPO_DIRECTORY_NAME));
    const devicesRoot = ensureDirectory(path.join(repoPath, CLOUD_DEVICES_DIRECTORY_NAME));
    const objectsRoot = ensureDirectory(path.join(repoPath, CLOUD_OBJECTS_DIRECTORY_NAME));
    const metaRoot = ensureDirectory(path.join(objectsRoot, CLOUD_META_DIRECTORY_NAME));
    const snapshotsRoot = ensureDirectory(path.join(objectsRoot, CLOUD_SNAPSHOTS_DIRECTORY_NAME));
    const resourceMetaRoot = ensureDirectory(path.join(objectsRoot, CLOUD_RESOURCE_META_DIRECTORY_NAME));
    const resourceDataRoot = ensureDirectory(path.join(objectsRoot, CLOUD_RESOURCE_DATA_DIRECTORY_NAME));
    return {
        cloudRoot,
        remotesRoot,
        remoteRoot,
        repoPath,
        markerPath: path.join(repoPath, CLOUD_MARKER_FILE_NAME),
        manifestPath: path.join(repoPath, CLOUD_MANIFEST_FILE_NAME),
        devicesRoot,
        objectsRoot,
        metaRoot,
        snapshotsRoot,
        resourceMetaRoot,
        resourceDataRoot,
        deviceStatePath: path.join(devicesRoot, `${config.deviceId}.json`),
    };
}

function buildEmptyCloudManifest() {
    return {
        version: CLOUD_FORMAT_VERSION,
        updatedAt: 0,
        scopeCount: 0,
        snapshotCount: 0,
        deviceCount: 0,
        scopes: [],
    };
}

function getSourceLabel(source) {
    const normalizedSource = asObject(source);
    return normalizedSource.kind === 'group'
        ? (asString(normalizedSource.groupName).trim() || asString(normalizedSource.currentName).trim() || asString(normalizedSource.chatId).trim() || 'group')
        : (asString(normalizedSource.characterName).trim() || asString(normalizedSource.currentName).trim() || asString(normalizedSource.chatId).trim() || 'character');
}

function hashBuffer(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

function buildCloudSnapshotId(scopeId, fingerprint) {
    return sha1(`${asString(scopeId).trim()}:${asString(fingerprint).trim()}`);
}

function getCloudObjectPaths(cloudPaths, scopeId, snapshotId) {
    const safeScopeId = sanitizePathPart(scopeId, 'scope', 96);
    const safeSnapshotId = sanitizePathPart(snapshotId, 'snapshot', 96);
    const metaDirectory = ensureDirectory(path.join(cloudPaths.metaRoot, safeScopeId));
    const snapshotsDirectory = ensureDirectory(path.join(cloudPaths.snapshotsRoot, safeScopeId));
    const metaPath = path.join(metaDirectory, `${safeSnapshotId}.json`);
    const snapshotPath = path.join(snapshotsDirectory, `${safeSnapshotId}.jsonl`);
    return {
        metaPath,
        snapshotPath,
        metaRelativePath: path.relative(cloudPaths.repoPath, metaPath).replace(/\\/g, '/'),
        snapshotRelativePath: path.relative(cloudPaths.repoPath, snapshotPath).replace(/\\/g, '/'),
    };
}

function getCloudResourcePaths(cloudPaths, kind, hash, extension = '') {
    const safeKind = sanitizePathPart(kind, 'resource', 48);
    const safeHash = sanitizePathPart(hash, 'hash', 96);
    const normalizedExtension = asString(extension).trim().replace(/[^a-z0-9.]/gi, '').toLowerCase();
    const metaDirectory = ensureDirectory(path.join(cloudPaths.resourceMetaRoot, safeKind));
    const dataDirectory = ensureDirectory(path.join(cloudPaths.resourceDataRoot, safeKind));
    const metaPath = path.join(metaDirectory, `${safeHash}.json`);
    const dataPath = path.join(dataDirectory, `${safeHash}${normalizedExtension}`);
    return {
        metaPath,
        dataPath,
        metaRelativePath: path.relative(cloudPaths.repoPath, metaPath).replace(/\\/g, '/'),
        dataRelativePath: path.relative(cloudPaths.repoPath, dataPath).replace(/\\/g, '/'),
    };
}

function buildCloudGitIdentity(config) {
    const deviceName = sanitizePathPart(config.deviceName || config.deviceId || 'chat-vault-device', 'chat-vault-device', 64);
    const deviceMail = sanitizePathPart(config.deviceId || 'device', 'device', 64);
    return {
        name: `Chat Vault ${deviceName}`,
        email: `chat-vault+${deviceMail}@local`,
    };
}

function buildCloudAuthenticatedRepoUrl(config) {
    const repoUrl = asString(config.repoUrl).trim();
    const token = asString(config.githubToken).trim();
    if (!repoUrl || !token || !repoUrl.startsWith('https://') || repoUrl.includes('@')) {
        return repoUrl;
    }

    return repoUrl.replace('https://', `https://x-access-token:${encodeURIComponent(token)}@`);
}

function buildCloudMarker(config, existingMarker = null) {
    const previous = asObject(existingMarker);
    return {
        version: CLOUD_FORMAT_VERSION,
        plugin: info.id,
        storage: 'git-cloud-vault',
        repoKey: buildCloudRemoteKey(config),
        branch: asString(config.branch).trim() || DEFAULT_CLOUD_BRANCH,
        createdAt: Math.trunc(asFiniteNumber(previous.createdAt, Date.now())),
    };
}

function buildCloudDeviceState(config, selection, existingState = null) {
    const previous = asObject(existingState);
    const scopes = selection.scopes.map((scope) => ({
        scopeId: scope.scopeId,
        label: scope.label,
        source: scope.source,
        snapshotIds: scope.entries.map((entry) => entry.snapshotId),
    }));
    const stableSeed = JSON.stringify({
        deviceName: config.deviceName,
        syncPinned: config.syncPinned,
        syncLatestStable: config.syncLatestStable,
        syncDrafts: config.syncDrafts,
        scopes,
    });
    const previousSeed = JSON.stringify({
        deviceName: asString(previous.deviceName).trim(),
        syncPinned: Boolean(previous.syncPinned),
        syncLatestStable: Boolean(previous.syncLatestStable),
        syncDrafts: Boolean(previous.syncDrafts),
        scopes: asArray(previous.scopes),
    });

    return {
        version: CLOUD_FORMAT_VERSION,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        syncPinned: config.syncPinned,
        syncLatestStable: config.syncLatestStable,
        syncDrafts: config.syncDrafts,
        updatedAt: stableSeed === previousSeed
            ? Math.trunc(asFiniteNumber(previous.updatedAt, Date.now()))
            : Date.now(),
        scopes,
    };
}

function normalizeCloudManifest(rawManifest) {
    const manifest = asObject(rawManifest);
    return {
        version: CLOUD_FORMAT_VERSION,
        updatedAt: Math.trunc(asFiniteNumber(manifest.updatedAt, 0)),
        scopeCount: Math.trunc(asFiniteNumber(manifest.scopeCount, 0)),
        snapshotCount: Math.trunc(asFiniteNumber(manifest.snapshotCount, 0)),
        deviceCount: Math.trunc(asFiniteNumber(manifest.deviceCount, 0)),
        scopes: asArray(manifest.scopes)
            .map((scope) => asObject(scope))
            .filter((scope) => asString(scope.scopeId).trim()),
    };
}

function cloneData(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getUserSettingsPath(directories) {
    return path.join(directories.root, 'settings.json');
}

function readUserSettings(directories) {
    return readJson(getUserSettingsPath(directories), {});
}

function saveUserSettings(directories, settings) {
    writeJsonAtomic(getUserSettingsPath(directories), settings);
}

function getPowerUserSettingsRecord(directories) {
    const settings = asObject(readUserSettings(directories));
    const powerUser = asObject(settings.power_user);
    return {
        settings,
        powerUser,
    };
}

function getAvatarFileBaseName(avatarUrl) {
    return path.parse(asString(avatarUrl).trim()).name;
}

function getCharacterExtraWorldBindingMap(directories) {
    const settings = asObject(readUserSettings(directories));
    const worldInfo = asObject(settings.world_info);
    const map = new Map();

    for (const entry of asArray(worldInfo.charLore)) {
        const normalized = asObject(entry);
        const name = asString(normalized.name).trim();
        if (!name) {
            continue;
        }

        const extraBooks = Array.from(new Set(
            asArray(normalized.extraBooks)
                .map((item) => asString(item).trim())
                .filter(Boolean),
        ));
        if (extraBooks.length === 0) {
            continue;
        }

        map.set(name, extraBooks);
    }

    return map;
}

function getCharacterExtraWorldNames(directories, avatarUrl, bindingMap = null) {
    const normalizedAvatar = getAvatarFileBaseName(avatarUrl);
    if (!normalizedAvatar) {
        return [];
    }

    const resolvedMap = bindingMap || getCharacterExtraWorldBindingMap(directories);
    return resolvedMap.get(normalizedAvatar) || [];
}

function normalizePersonaConnection(rawConnection) {
    const connection = asObject(rawConnection);
    const type = asString(connection.type).trim() === 'group' ? 'group' : 'character';
    const id = asString(connection.id).trim();
    return id ? { type, id } : null;
}

function normalizePersonaDescriptor(rawDescriptor) {
    const descriptor = asObject(rawDescriptor);
    return {
        description: asString(descriptor.description),
        position: Math.trunc(asFiniteNumber(descriptor.position, 0)),
        depth: Math.trunc(asFiniteNumber(descriptor.depth, 2)),
        role: Math.trunc(asFiniteNumber(descriptor.role, 0)),
        lorebook: asString(descriptor.lorebook).trim(),
        connections: asArray(descriptor.connections)
            .map((connection) => normalizePersonaConnection(connection))
            .filter(Boolean),
    };
}

function getSourcePersonaConnection(source) {
    if (asString(source.kind).trim() === 'group') {
        const groupId = asString(source.groupId).trim();
        return groupId ? { type: 'group', id: groupId } : null;
    }

    const avatarUrl = asString(source.avatarUrl).trim();
    return avatarUrl ? { type: 'character', id: avatarUrl } : null;
}

function getPersonaRecord(powerUser, avatarId) {
    const normalizedAvatarId = asString(avatarId).trim();
    if (!normalizedAvatarId) {
        return null;
    }

    const personas = asObject(powerUser.personas);
    const descriptors = asObject(powerUser.persona_descriptions);
    const personaName = asString(personas[normalizedAvatarId]).trim();
    const descriptor = normalizePersonaDescriptor(descriptors[normalizedAvatarId]);
    if (!personaName && !descriptor.description && !descriptor.lorebook && descriptor.connections.length === 0) {
        return null;
    }

    return {
        avatarId: normalizedAvatarId,
        personaName: personaName || normalizedAvatarId,
        descriptor,
    };
}

function getConnectedPersonaAvatarIds(powerUser, source) {
    const targetConnection = getSourcePersonaConnection(source);
    if (!targetConnection?.id) {
        return [];
    }

    return Object.entries(asObject(powerUser.persona_descriptions))
        .filter(([, rawDescriptor]) => {
            const descriptor = normalizePersonaDescriptor(rawDescriptor);
            return descriptor.connections.some((connection) => {
                return connection.type === targetConnection.type && connection.id === targetConnection.id;
            });
        })
        .map(([avatarId]) => asString(avatarId).trim())
        .filter(Boolean);
}

function readGroupDefinitionRecord(directories, groupId, groupName = '') {
    const normalizedGroupId = asString(groupId).trim();
    if (normalizedGroupId) {
        const directPath = path.join(directories.groups, `${normalizedGroupId}.json`);
        if (fs.existsSync(directPath)) {
            const text = fs.readFileSync(directPath, 'utf8');
            return {
                filePath: directPath,
                fileName: path.basename(directPath),
                text,
                data: asObject(JSON.parse(text)),
            };
        }
    }

    const normalizedGroupName = asString(groupName).trim();
    if (!normalizedGroupName || !fs.existsSync(directories.groups)) {
        return null;
    }

    for (const fileName of fs.readdirSync(directories.groups)) {
        if (path.extname(fileName).toLowerCase() !== '.json') {
            continue;
        }

        const filePath = path.join(directories.groups, fileName);
        const text = fs.readFileSync(filePath, 'utf8');
        const data = asObject(JSON.parse(text));
        if (asString(data.name).trim() !== normalizedGroupName) {
            continue;
        }

        return {
            filePath,
            fileName,
            text,
            data,
        };
    }

    return null;
}

function createCloudResourceRecord({
    kind,
    role,
    buffer,
    fileName,
    displayName = '',
    avatarUrl = '',
    ownerAvatarUrl = '',
    groupId = '',
    groupName = '',
    worldName = '',
}) {
    const normalizedFileName = asString(fileName).trim();
    return {
        kind: asString(kind).trim(),
        role: asString(role).trim(),
        hash: hashBuffer(buffer),
        fileName: normalizedFileName,
        extension: path.extname(normalizedFileName).toLowerCase(),
        displayName: asString(displayName).trim(),
        avatarUrl: asString(avatarUrl).trim(),
        ownerAvatarUrl: asString(ownerAvatarUrl).trim(),
        groupId: asString(groupId).trim(),
        groupName: asString(groupName).trim(),
        worldName: asString(worldName).trim(),
        buffer,
    };
}

function createCloudResourceRef(resource) {
    return {
        kind: resource.kind,
        role: resource.role,
        hash: resource.hash,
        fileName: resource.fileName,
        extension: resource.extension,
        displayName: resource.displayName,
        avatarUrl: resource.avatarUrl,
        ownerAvatarUrl: resource.ownerAvatarUrl,
        groupId: resource.groupId,
        groupName: resource.groupName,
        worldName: resource.worldName,
    };
}

function appendCloudResourceRef(refs, ref) {
    const key = [
        ref.kind,
        ref.role,
        ref.hash,
        ref.avatarUrl,
        ref.ownerAvatarUrl,
        ref.groupId,
        ref.worldName,
    ].join(':');
    if (refs.some((entry) => [
        entry.kind,
        entry.role,
        entry.hash,
        entry.avatarUrl,
        entry.ownerAvatarUrl,
        entry.groupId,
        entry.worldName,
    ].join(':') === key)) {
        return;
    }

    refs.push(ref);
}

function addCloudResourceRecord(resourceMap, refs, resource) {
    const mapKey = `${resource.kind}:${resource.hash}`;
    if (!resourceMap.has(mapKey)) {
        resourceMap.set(mapKey, resource);
    }
    appendCloudResourceRef(refs, createCloudResourceRef(resource));
}

function collectLocalSnapshotResourceBundle(directories, source, snapshot) {
    const refs = [];
    const resourceMap = new Map();
    const header = asObject(snapshot[0]);
    const chatMetadata = asObject(header.chat_metadata);
    const extraWorldBindingMap = getCharacterExtraWorldBindingMap(directories);
    const { powerUser } = getPowerUserSettingsRecord(directories);

    const addCharacterByAvatar = (avatarUrl, role, displayName = '') => {
        const normalizedAvatarUrl = asString(avatarUrl).trim();
        if (!normalizedAvatarUrl) {
            return;
        }

        const filePath = path.join(directories.characters, normalizedAvatarUrl);
        if (!fs.existsSync(filePath)) {
            return;
        }

        addCloudResourceRecord(resourceMap, refs, createCloudResourceRecord({
            kind: 'character_card',
            role,
            buffer: fs.readFileSync(filePath),
            fileName: normalizedAvatarUrl,
            displayName,
            avatarUrl: normalizedAvatarUrl,
        }));

        for (const worldName of getCharacterExtraWorldNames(directories, normalizedAvatarUrl, extraWorldBindingMap)) {
            const worldPath = path.join(directories.worlds, `${worldName}.json`);
            if (!fs.existsSync(worldPath)) {
                continue;
            }

            addCloudResourceRecord(resourceMap, refs, createCloudResourceRecord({
                kind: 'world_info',
                role: 'character_additional_world',
                buffer: fs.readFileSync(worldPath),
                fileName: `${worldName}.json`,
                displayName: worldName,
                ownerAvatarUrl: normalizedAvatarUrl,
                worldName,
            }));
        }
    };

    const addChatWorld = (worldName, role = 'chat_world') => {
        const normalizedWorldName = asString(worldName).trim();
        if (!normalizedWorldName) {
            return;
        }

        const filePath = path.join(directories.worlds, `${normalizedWorldName}.json`);
        if (!fs.existsSync(filePath)) {
            return;
        }

        addCloudResourceRecord(resourceMap, refs, createCloudResourceRecord({
            kind: 'world_info',
            role,
            buffer: fs.readFileSync(filePath),
            fileName: `${normalizedWorldName}.json`,
            displayName: normalizedWorldName,
            worldName: normalizedWorldName,
        }));
    };

    const addPersonaByAvatar = (avatarId, role) => {
        const record = getPersonaRecord(powerUser, avatarId);
        if (!record) {
            return;
        }

        const avatarPath = path.join(directories.avatars, record.avatarId);
        if (fs.existsSync(avatarPath)) {
            addCloudResourceRecord(resourceMap, refs, createCloudResourceRecord({
                kind: 'persona_avatar',
                role,
                buffer: fs.readFileSync(avatarPath),
                fileName: record.avatarId,
                displayName: record.personaName,
                avatarUrl: record.avatarId,
            }));
        }

        addCloudResourceRecord(resourceMap, refs, createCloudResourceRecord({
            kind: 'persona_profile',
            role,
            buffer: Buffer.from(JSON.stringify({
                avatarId: record.avatarId,
                personaName: record.personaName,
                descriptor: record.descriptor,
            }, null, 2), 'utf8'),
            fileName: `${getAvatarFileBaseName(record.avatarId) || 'persona'}.json`,
            displayName: record.personaName,
            avatarUrl: record.avatarId,
        }));

        if (record.descriptor.lorebook) {
            const lorebookName = record.descriptor.lorebook;
            const lorebookPath = path.join(directories.worlds, `${lorebookName}.json`);
            if (fs.existsSync(lorebookPath)) {
                addCloudResourceRecord(resourceMap, refs, createCloudResourceRecord({
                    kind: 'world_info',
                    role: 'persona_lorebook',
                    buffer: fs.readFileSync(lorebookPath),
                    fileName: `${lorebookName}.json`,
                    displayName: lorebookName,
                    ownerAvatarUrl: record.avatarId,
                    worldName: lorebookName,
                }));
            }
        }
    };

    if (source.kind === 'group') {
        const groupRecord = readGroupDefinitionRecord(directories, source.groupId, source.groupName);
        if (groupRecord) {
            addCloudResourceRecord(resourceMap, refs, createCloudResourceRecord({
                kind: 'group_definition',
                role: 'scope_group',
                buffer: Buffer.from(groupRecord.text, 'utf8'),
                fileName: groupRecord.fileName,
                displayName: asString(groupRecord.data.name).trim() || source.groupName,
                groupId: asString(groupRecord.data.id).trim() || source.groupId,
                groupName: asString(groupRecord.data.name).trim() || source.groupName,
            }));

            for (const memberAvatar of asArray(groupRecord.data.members)) {
                addCharacterByAvatar(memberAvatar, 'group_member');
            }
        }
    } else {
        addCharacterByAvatar(source.avatarUrl, 'scope_character', source.characterName);
    }

    addChatWorld(chatMetadata.world_info, 'chat_world');
    if (chatMetadata.persona) {
        addPersonaByAvatar(chatMetadata.persona, 'chat_persona');
    }
    for (const personaAvatarId of getConnectedPersonaAvatarIds(powerUser, source)) {
        addPersonaByAvatar(personaAvatarId, 'scope_persona_connection');
    }

    return {
        refs: refs.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        resources: Array.from(resourceMap.values()).sort((left, right) => {
            return `${left.kind}:${left.displayName}:${left.hash}`.localeCompare(`${right.kind}:${right.displayName}:${right.hash}`);
        }),
    };
}

function normalizeCloudResourceRefs(rawResources) {
    return asArray(rawResources)
        .map((resource) => asObject(resource))
        .map((resource) => ({
            kind: asString(resource.kind).trim(),
            role: asString(resource.role).trim(),
            hash: asString(resource.hash).trim(),
            fileName: asString(resource.fileName).trim(),
            extension: asString(resource.extension).trim(),
            displayName: asString(resource.displayName).trim(),
            avatarUrl: asString(resource.avatarUrl).trim(),
            ownerAvatarUrl: asString(resource.ownerAvatarUrl).trim(),
            groupId: asString(resource.groupId).trim(),
            groupName: asString(resource.groupName).trim(),
            worldName: asString(resource.worldName).trim(),
        }))
        .filter((resource) => resource.kind && resource.hash);
}

function normalizeCloudPublishedByDevices(rawPublishedByDevices, fallbackPublishedFrom = null) {
    const publishers = [];
    const pushPublisher = (rawPublisher) => {
        const publisher = asObject(rawPublisher);
        const deviceId = asString(publisher.deviceId).trim();
        if (!deviceId) {
            return;
        }

        const normalized = {
            deviceId,
            deviceName: asString(publisher.deviceName).trim() || deviceId,
            firstUploadedAt: Math.trunc(asFiniteNumber(publisher.firstUploadedAt, Date.now())),
            lastUploadedAt: Math.trunc(asFiniteNumber(publisher.lastUploadedAt, Date.now())),
        };
        const existingIndex = publishers.findIndex((item) => item.deviceId === deviceId);
        if (existingIndex < 0) {
            publishers.push(normalized);
            return;
        }

        publishers[existingIndex] = {
            ...publishers[existingIndex],
            ...normalized,
            firstUploadedAt: Math.min(
                Math.trunc(asFiniteNumber(publishers[existingIndex].firstUploadedAt, normalized.firstUploadedAt)),
                normalized.firstUploadedAt,
            ),
        };
    };

    for (const rawPublisher of asArray(rawPublishedByDevices)) {
        pushPublisher(rawPublisher);
    }
    pushPublisher(fallbackPublishedFrom);

    return publishers.sort((left, right) => {
        return Number(left.firstUploadedAt || 0) - Number(right.firstUploadedAt || 0)
            || left.deviceName.localeCompare(right.deviceName)
            || left.deviceId.localeCompare(right.deviceId);
    });
}

function summarizeCloudResourceRefs(rawResources) {
    const resources = normalizeCloudResourceRefs(rawResources);
    const summary = {
        totalCount: resources.length,
        characterCardCount: 0,
        worldInfoCount: 0,
        groupDefinitionCount: 0,
        personaAvatarCount: 0,
        personaProfileCount: 0,
    };

    for (const resource of resources) {
        if (resource.kind === 'character_card') {
            summary.characterCardCount += 1;
        } else if (resource.kind === 'world_info') {
            summary.worldInfoCount += 1;
        } else if (resource.kind === 'group_definition') {
            summary.groupDefinitionCount += 1;
        } else if (resource.kind === 'persona_avatar') {
            summary.personaAvatarCount += 1;
        } else if (resource.kind === 'persona_profile') {
            summary.personaProfileCount += 1;
        }
    }

    return summary;
}

function clearDirectoryExceptGit(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return;
    }

    for (const child of fs.readdirSync(directoryPath)) {
        if (child === '.git') {
            continue;
        }
        fs.rmSync(path.join(directoryPath, child), { recursive: true, force: true });
    }
}

function clearCloudGitLocks(repoPath) {
    const gitDirectory = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDirectory)) {
        return;
    }

    const lockPath = path.join(gitDirectory, 'index.lock');
    if (!fs.existsSync(lockPath)) {
        return;
    }

    try {
        fs.unlinkSync(lockPath);
        console.warn('[chat-vault] Removed stale git lock:', lockPath);
    } catch (error) {
        console.warn('[chat-vault] Failed to remove stale git lock:', lockPath, error);
    }
}

async function withCloudRepoOperationLock(repoPath, task) {
    const previous = cloudRepoOperationQueue.get(repoPath) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(async () => {
            clearCloudGitLocks(repoPath);
            return task();
        });

    cloudRepoOperationQueue.set(repoPath, next);

    try {
        return await next;
    } finally {
        if (cloudRepoOperationQueue.get(repoPath) === next) {
            cloudRepoOperationQueue.delete(repoPath);
        }
    }
}

function runGit(args, { cwd, allowFailure = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => {
            if (allowFailure) {
                resolve({ ok: false, code: -1, stdout, stderr: stderr || error.message, error });
                return;
            }
            reject(error);
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ ok: true, code, stdout, stderr });
                return;
            }

            const message = (stderr || stdout || `git exited with code ${code}`).trim();
            if (allowFailure) {
                resolve({ ok: false, code, stdout, stderr: message });
                return;
            }

            const error = new Error(message);
            error.code = code;
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
        });
    });
}

function isCloudNonFastForwardError(error) {
    const haystack = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes('non-fast-forward')
        || haystack.includes('fetch first')
        || haystack.includes('failed to push some refs');
}

function isCloudTransientPushError(error) {
    const haystack = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes('http 408')
        || haystack.includes('rpc failed')
        || haystack.includes('unexpected disconnect')
        || haystack.includes('remote end hung up unexpectedly')
        || haystack.includes('timed out')
        || haystack.includes('connection reset');
}

function isCloudAlreadyUpToDateMessage(error) {
    const haystack = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes('everything up-to-date');
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readGitRevision(repoPath, refName) {
    const result = await runGit(['rev-parse', refName], {
        cwd: repoPath,
        allowFailure: true,
    });
    return result.ok ? result.stdout.trim() : '';
}

async function readRemoteBranchRevision(repoPath, branch) {
    const result = await runGit(['ls-remote', '--heads', 'origin', branch], {
        cwd: repoPath,
        allowFailure: true,
    });
    if (!result.ok) {
        return '';
    }

    const line = result.stdout.split('\n').map((item) => item.trim()).find(Boolean) || '';
    return line.split(/\s+/)[0] || '';
}

async function remoteBranchMatchesLocalHead(repoPath, branch) {
    const localHead = await readGitRevision(repoPath, 'HEAD');
    if (!localHead) {
        return false;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const remoteHead = await readRemoteBranchRevision(repoPath, branch);
        if (remoteHead && remoteHead === localHead) {
            return true;
        }
        if (attempt === 0) {
            await wait(900);
        }
    }

    return false;
}

async function pushCloudBranch(cloudPaths, branch) {
    try {
        await runGit(['push', '-u', 'origin', branch], { cwd: cloudPaths.repoPath });
        return;
    } catch (error) {
        if (isCloudTransientPushError(error) && isCloudAlreadyUpToDateMessage(error)) {
            return;
        }
        if ((isCloudTransientPushError(error) || isCloudNonFastForwardError(error))
            && await remoteBranchMatchesLocalHead(cloudPaths.repoPath, branch)) {
            return;
        }
        throw error;
    }
}

async function ensureCloudRepositoryReady(baseDirectory, config) {
    const cloudPaths = getCloudPaths(baseDirectory, config);
    const gitDirectory = path.join(cloudPaths.repoPath, '.git');

    if (!fs.existsSync(gitDirectory)) {
        await runGit(['init'], { cwd: cloudPaths.repoPath });
    }

    const identity = buildCloudGitIdentity(config);
    await runGit(['config', 'user.name', identity.name], { cwd: cloudPaths.repoPath });
    await runGit(['config', 'user.email', identity.email], { cwd: cloudPaths.repoPath });
    await runGit(['config', 'pull.rebase', 'false'], { cwd: cloudPaths.repoPath });

    const remoteUrl = buildCloudAuthenticatedRepoUrl(config);
    const remoteCheck = await runGit(['remote', 'get-url', 'origin'], {
        cwd: cloudPaths.repoPath,
        allowFailure: true,
    });
    if (!remoteCheck.ok) {
        await runGit(['remote', 'add', 'origin', remoteUrl], { cwd: cloudPaths.repoPath });
    } else if (remoteCheck.stdout.trim() !== remoteUrl) {
        await runGit(['remote', 'set-url', 'origin', remoteUrl], { cwd: cloudPaths.repoPath });
    }

    await runGit(['fetch', '--prune', 'origin'], { cwd: cloudPaths.repoPath });
    const remoteBranchCheck = await runGit(['ls-remote', '--heads', 'origin', config.branch], { cwd: cloudPaths.repoPath });
    const remoteBranchExists = remoteBranchCheck.stdout.includes(`refs/heads/${config.branch}`);

    if (remoteBranchExists) {
        await runGit(['checkout', '-B', config.branch, `origin/${config.branch}`], { cwd: cloudPaths.repoPath });
        await runGit(['reset', '--hard', `origin/${config.branch}`], { cwd: cloudPaths.repoPath });
        await runGit(['clean', '-fd'], { cwd: cloudPaths.repoPath });
        const marker = readJson(cloudPaths.markerPath, null);
        if (marker) {
            const pluginId = asString(marker.plugin).trim();
            const storageKind = asString(marker.storage).trim();
            if (pluginId !== info.id || storageKind !== 'git-cloud-vault') {
                throw new Error('remote repository is not a Chat Vault cloud repository');
            }
        } else {
            const children = fs.readdirSync(cloudPaths.repoPath).filter((item) => item !== '.git');
            if (children.length > 0) {
                throw new Error('remote repository is not empty and has no Chat Vault marker');
            }
        }
    } else {
        const headCheck = await runGit(['rev-parse', '--verify', 'HEAD'], {
            cwd: cloudPaths.repoPath,
            allowFailure: true,
        });
        if (headCheck.ok) {
            await runGit(['checkout', '-B', config.branch], { cwd: cloudPaths.repoPath });
        } else {
            await runGit(['checkout', '--orphan', config.branch], { cwd: cloudPaths.repoPath });
        }
        clearDirectoryExceptGit(cloudPaths.repoPath);
    }

    return cloudPaths;
}

async function cloudRepositoryHasChanges(cloudPaths) {
    const status = await runGit(['status', '--porcelain'], { cwd: cloudPaths.repoPath });
    return Boolean(status.stdout.trim());
}

function getLatestStableEntry(entries) {
    const normalizedEntries = asArray(entries)
        .map((entry) => asObject(entry))
        .filter((entry) => asString(entry.id).trim())
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    return normalizedEntries.find((entry) => entry.mode !== 'auto') || normalizedEntries[0] || null;
}

function collectLocalCloudSelection(baseDirectory, config, directories) {
    const scopesRoot = ensureDirectory(path.join(baseDirectory, 'scopes'));
    const scopes = [];
    const selectionResources = new Map();

    for (const scopeDirectory of listScopeDirectories(scopesRoot)) {
        const index = readJson(path.join(scopeDirectory, INDEX_FILE_NAME), null);
        const source = asObject(index?.source);
        const scopeId = asString(source.scopeKey).trim() || path.basename(scopeDirectory).split('__').pop() || '';
        if (!scopeId) {
            continue;
        }

        const entries = asArray(index?.entries)
            .map((entry) => asObject(entry))
            .filter((entry) => asString(entry.id).trim())
            .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
        const selectedEntries = new Map();

        if (config.syncPinned) {
            for (const entry of entries) {
                if (entry.pinned) {
                    selectedEntries.set(entry.id, entry);
                }
            }
        }

        if (config.syncLatestStable) {
            const latestStableEntry = getLatestStableEntry(entries);
            if (latestStableEntry) {
                selectedEntries.set(latestStableEntry.id, latestStableEntry);
            }
        }

        if (selectedEntries.size === 0) {
            continue;
        }

        const scopeEntries = [];
        for (const entry of selectedEntries.values()) {
            const snapshotPath = path.join(scopeDirectory, 'snapshots', asString(entry.snapshotFile).trim());
            if (!fs.existsSync(snapshotPath)) {
                continue;
            }

            const snapshot = readSnapshotFile(snapshotPath);
            const jsonl = snapshotToJsonl(snapshot);
            const fingerprint = asString(entry.fingerprint).trim() || sha1(jsonl);
            const resourceBundle = directories
                ? collectLocalSnapshotResourceBundle(directories, source, snapshot)
                : { refs: [], resources: [] };
            for (const resource of resourceBundle.resources) {
                selectionResources.set(`${resource.kind}:${resource.hash}`, resource);
            }
            scopeEntries.push({
                ...entry,
                scopeId,
                snapshotId: buildCloudSnapshotId(scopeId, fingerprint),
                fingerprint,
                jsonl,
                resources: resourceBundle.refs,
            });
        }

        if (scopeEntries.length === 0) {
            continue;
        }

        scopes.push({
            scopeId,
            label: getSourceLabel(source),
            source,
            entries: scopeEntries.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0)),
        });
    }

    return {
        scopes,
        scopeCount: scopes.length,
        snapshotCount: scopes.reduce((sum, scope) => sum + scope.entries.length, 0),
        resources: Array.from(selectionResources.values()),
        resourceCount: selectionResources.size,
    };
}

function writeCloudMarker(cloudPaths, config) {
    const existingMarker = readJson(cloudPaths.markerPath, null);
    const nextMarker = buildCloudMarker(config, existingMarker);
    const previousMarker = asObject(existingMarker);
    if (JSON.stringify(previousMarker) !== JSON.stringify(nextMarker)) {
        writeJsonAtomic(cloudPaths.markerPath, nextMarker);
    }
    return nextMarker;
}

function writeCloudSelectionObjects(cloudPaths, config, selection) {
    for (const scope of selection.scopes) {
        for (const entry of scope.entries) {
            const objectPaths = getCloudObjectPaths(cloudPaths, scope.scopeId, entry.snapshotId);
            const existingMeta = readJson(objectPaths.metaPath, null);
            const firstUploadedAt = Math.trunc(asFiniteNumber(existingMeta?.publishedFrom?.firstUploadedAt, Date.now()));
            const mergedResources = normalizeCloudResourceRefs([
                ...normalizeCloudResourceRefs(existingMeta?.resources),
                ...normalizeCloudResourceRefs(entry.resources),
            ]);
            const mergedPublishers = normalizeCloudPublishedByDevices(existingMeta?.publishedByDevices, existingMeta?.publishedFrom);
            const existingPublisherIndex = mergedPublishers.findIndex((publisher) => publisher.deviceId === config.deviceId);
            const currentPublisher = {
                deviceId: config.deviceId,
                deviceName: config.deviceName || config.deviceId,
                firstUploadedAt: existingPublisherIndex >= 0
                    ? mergedPublishers[existingPublisherIndex].firstUploadedAt
                    : firstUploadedAt,
                lastUploadedAt: Date.now(),
            };
            if (existingPublisherIndex >= 0) {
                mergedPublishers[existingPublisherIndex] = currentPublisher;
            } else {
                mergedPublishers.push(currentPublisher);
            }
            const nextMeta = {
                version: CLOUD_FORMAT_VERSION,
                scopeId: scope.scopeId,
                snapshotId: entry.snapshotId,
                label: scope.label,
                source: scope.source,
                createdAt: Math.trunc(asFiniteNumber(entry.createdAt, Date.now())),
                trigger: asString(entry.trigger).trim() || 'manual',
                triggerLabel: asString(entry.triggerLabel).trim() || toTriggerLabel(entry.trigger),
                mode: asString(entry.mode).trim() === 'auto' ? 'auto' : 'manual',
                customName: asString(entry.customName).trim(),
                pinned: Boolean(entry.pinned),
                milestoneLabel: entry.pinned ? '长期保留' : '',
                fingerprint: entry.fingerprint,
                messageCount: Math.trunc(asFiniteNumber(entry.messageCount, 0)),
                lastMessagePreview: asString(entry.lastMessagePreview),
                lastMessageName: asString(entry.lastMessageName),
                lastMessageAt: asString(entry.lastMessageAt),
                resources: mergedResources,
                snapshotPath: objectPaths.snapshotRelativePath,
                publishedByDevices: mergedPublishers,
                publishedFrom: {
                    deviceId: config.deviceId,
                    deviceName: config.deviceName,
                    firstUploadedAt,
                    lastUploadedAt: Date.now(),
                },
            };
            const previousJsonl = fs.existsSync(objectPaths.snapshotPath)
                ? fs.readFileSync(objectPaths.snapshotPath, 'utf8')
                : null;
            const comparablePreviousMeta = existingMeta
                ? {
                    ...existingMeta,
                    publishedByDevices: normalizeCloudPublishedByDevices(existingMeta.publishedByDevices, existingMeta.publishedFrom)
                        .map((publisher) => ({
                            ...publisher,
                            lastUploadedAt: 0,
                        })),
                    publishedFrom: {
                        ...asObject(existingMeta.publishedFrom),
                        lastUploadedAt: 0,
                    },
                }
                : null;
            const comparableNextMeta = {
                ...nextMeta,
                publishedByDevices: normalizeCloudPublishedByDevices(nextMeta.publishedByDevices)
                    .map((publisher) => ({
                        ...publisher,
                        lastUploadedAt: 0,
                    })),
                publishedFrom: {
                    ...nextMeta.publishedFrom,
                    lastUploadedAt: 0,
                },
            };

            if (previousJsonl !== entry.jsonl) {
                writeTextAtomic(objectPaths.snapshotPath, entry.jsonl);
            }
            if (JSON.stringify(comparablePreviousMeta) !== JSON.stringify(comparableNextMeta)) {
                writeJsonAtomic(objectPaths.metaPath, nextMeta);
            }
        }
    }
}

function writeCloudSelectionResources(cloudPaths, selection) {
    for (const resource of asArray(selection.resources)) {
        const normalized = asObject(resource);
        const kind = asString(normalized.kind).trim();
        const hash = asString(normalized.hash).trim();
        if (!kind || !hash || !Buffer.isBuffer(normalized.buffer)) {
            continue;
        }

        const resourcePaths = getCloudResourcePaths(
            cloudPaths,
            kind,
            hash,
            asString(normalized.extension).trim() || path.extname(asString(normalized.fileName).trim()),
        );
        const nextMeta = {
            version: CLOUD_FORMAT_VERSION,
            kind,
            hash,
            fileName: asString(normalized.fileName).trim(),
            extension: asString(normalized.extension).trim(),
            displayName: asString(normalized.displayName).trim(),
            avatarUrl: asString(normalized.avatarUrl).trim(),
            ownerAvatarUrl: asString(normalized.ownerAvatarUrl).trim(),
            groupId: asString(normalized.groupId).trim(),
            groupName: asString(normalized.groupName).trim(),
            worldName: asString(normalized.worldName).trim(),
            dataPath: resourcePaths.dataRelativePath,
        };
        const existingMeta = readJson(resourcePaths.metaPath, null);
        const hasSameBuffer = fs.existsSync(resourcePaths.dataPath)
            && Buffer.compare(fs.readFileSync(resourcePaths.dataPath), normalized.buffer) === 0;

        if (!hasSameBuffer) {
            writeBufferAtomic(resourcePaths.dataPath, normalized.buffer);
        }
        if (JSON.stringify(asObject(existingMeta)) !== JSON.stringify(nextMeta)) {
            writeJsonAtomic(resourcePaths.metaPath, nextMeta);
        }
    }
}

function writeCloudDeviceSelection(cloudPaths, config, selection) {
    const existingState = readJson(cloudPaths.deviceStatePath, null);
    const nextState = buildCloudDeviceState(config, selection, existingState);
    writeJsonAtomic(cloudPaths.deviceStatePath, nextState);
    return nextState;
}

function readCloudDeviceStates(cloudPaths) {
    if (!fs.existsSync(cloudPaths.devicesRoot)) {
        return [];
    }

    return fs.readdirSync(cloudPaths.devicesRoot)
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => readJson(path.join(cloudPaths.devicesRoot, fileName), null))
        .map((state) => asObject(state))
        .filter((state) => asString(state.deviceId).trim());
}

function buildReferencedCloudSnapshotMap(deviceStates) {
    const referenced = new Map();

    for (const deviceState of deviceStates) {
        for (const scope of asArray(deviceState.scopes)) {
            const scopeState = asObject(scope);
            const scopeId = asString(scopeState.scopeId).trim();
            if (!scopeId) {
                continue;
            }
            if (!referenced.has(scopeId)) {
                referenced.set(scopeId, new Set());
            }
            const scopeSnapshots = referenced.get(scopeId);
            for (const snapshotId of asArray(scopeState.snapshotIds)) {
                const normalizedSnapshotId = asString(snapshotId).trim();
                if (normalizedSnapshotId) {
                    scopeSnapshots.add(normalizedSnapshotId);
                }
            }
        }
    }

    return referenced;
}

function pruneCloudObjects(cloudPaths, referencedMap) {
    const pruneDirectory = (rootDirectory, extension) => {
        if (!fs.existsSync(rootDirectory)) {
            return;
        }

        for (const scopeDirectory of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
            if (!scopeDirectory.isDirectory()) {
                continue;
            }
            const scopeId = scopeDirectory.name;
            const allowedSnapshotIds = referencedMap.get(scopeId) || new Set();
            const absoluteScopePath = path.join(rootDirectory, scopeDirectory.name);
            for (const fileName of fs.readdirSync(absoluteScopePath)) {
                if (!fileName.endsWith(extension)) {
                    continue;
                }
                const snapshotId = fileName.slice(0, -extension.length);
                if (!allowedSnapshotIds.has(snapshotId)) {
                    deleteFileSafe(path.join(absoluteScopePath, fileName));
                }
            }
            if (fs.readdirSync(absoluteScopePath).length === 0) {
                fs.rmSync(absoluteScopePath, { recursive: true, force: true });
            }
        }
    };

    pruneDirectory(cloudPaths.metaRoot, '.json');
    pruneDirectory(cloudPaths.snapshotsRoot, '.jsonl');
}

function buildReferencedCloudResourceMap(cloudPaths, referencedSnapshotMap) {
    const referenced = new Map();

    for (const [scopeId, snapshotIds] of referencedSnapshotMap.entries()) {
        for (const snapshotId of snapshotIds) {
            const objectPaths = getCloudObjectPaths(cloudPaths, scopeId, snapshotId);
            const meta = asObject(readJson(objectPaths.metaPath, null));
            for (const resource of normalizeCloudResourceRefs(meta.resources)) {
                if (!referenced.has(resource.kind)) {
                    referenced.set(resource.kind, new Set());
                }
                referenced.get(resource.kind).add(resource.hash);
            }
        }
    }

    return referenced;
}

function pruneCloudResources(cloudPaths, referencedMap) {
    const pruneDirectory = (rootDirectory, extension, keyField) => {
        if (!fs.existsSync(rootDirectory)) {
            return;
        }

        for (const kindDirectory of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
            if (!kindDirectory.isDirectory()) {
                continue;
            }

            const allowedHashes = referencedMap.get(kindDirectory.name) || new Set();
            const absoluteKindPath = path.join(rootDirectory, kindDirectory.name);
            for (const fileName of fs.readdirSync(absoluteKindPath)) {
                if (!fileName.endsWith(extension)) {
                    continue;
                }

                const hash = keyField === 'filename'
                    ? path.parse(fileName).name
                    : fileName.slice(0, -extension.length);
                if (!allowedHashes.has(hash)) {
                    deleteFileSafe(path.join(absoluteKindPath, fileName));
                }
            }
            if (fs.readdirSync(absoluteKindPath).length === 0) {
                fs.rmSync(absoluteKindPath, { recursive: true, force: true });
            }
        }
    };

    pruneDirectory(cloudPaths.resourceMetaRoot, '.json', 'filename');

    if (fs.existsSync(cloudPaths.resourceDataRoot)) {
        for (const kindDirectory of fs.readdirSync(cloudPaths.resourceDataRoot, { withFileTypes: true })) {
            if (!kindDirectory.isDirectory()) {
                continue;
            }

            const allowedHashes = referencedMap.get(kindDirectory.name) || new Set();
            const absoluteKindPath = path.join(cloudPaths.resourceDataRoot, kindDirectory.name);
            for (const fileName of fs.readdirSync(absoluteKindPath)) {
                const hash = path.parse(fileName).name;
                if (!allowedHashes.has(hash)) {
                    deleteFileSafe(path.join(absoluteKindPath, fileName));
                }
            }
            if (fs.readdirSync(absoluteKindPath).length === 0) {
                fs.rmSync(absoluteKindPath, { recursive: true, force: true });
            }
        }
    }
}

function rebuildCloudManifest(cloudPaths) {
    const previousManifest = normalizeCloudManifest(readJson(cloudPaths.manifestPath, buildEmptyCloudManifest()));
    const scopeMap = new Map();
    const allDevices = new Map();

    if (fs.existsSync(cloudPaths.metaRoot)) {
        for (const scopeDirectory of fs.readdirSync(cloudPaths.metaRoot, { withFileTypes: true })) {
            if (!scopeDirectory.isDirectory()) {
                continue;
            }

            const scopeId = scopeDirectory.name;
            const absoluteScopePath = path.join(cloudPaths.metaRoot, scopeDirectory.name);
            for (const fileName of fs.readdirSync(absoluteScopePath)) {
                if (!fileName.endsWith('.json')) {
                    continue;
                }

                const meta = asObject(readJson(path.join(absoluteScopePath, fileName), null));
                if (!asString(meta.snapshotId).trim()) {
                    continue;
                }

                const scopeRecord = scopeMap.get(scopeId) || {
                    scopeId,
                    label: asString(meta.label).trim(),
                    source: asObject(meta.source),
                    devices: new Map(),
                    entries: new Map(),
                };
                const normalizedPublishers = normalizeCloudPublishedByDevices(meta.publishedByDevices, meta.publishedFrom);
                for (const publisher of normalizedPublishers) {
                    scopeRecord.devices.set(publisher.deviceId, publisher.deviceName || publisher.deviceId);
                    allDevices.set(publisher.deviceId, publisher.deviceName || publisher.deviceId);
                }

                const existingEntry = scopeRecord.entries.get(asString(meta.snapshotId).trim()) || {
                    ...meta,
                    publishedByDevices: [],
                };
                existingEntry.publishedByDevices = normalizedPublishers.map((publisher) => publisher.deviceId);
                scopeRecord.label = existingEntry.label || scopeRecord.label;
                scopeRecord.source = asObject(existingEntry.source)?.scopeKey ? existingEntry.source : scopeRecord.source;
                scopeRecord.entries.set(asString(meta.snapshotId).trim(), existingEntry);
                scopeMap.set(scopeId, scopeRecord);
            }
        }
    }

    const scopes = Array.from(scopeMap.values()).map((scopeRecord) => {
        const entries = Array.from(scopeRecord.entries.values())
            .map((entry) => ({
                snapshotId: asString(entry.snapshotId).trim(),
                createdAt: Math.trunc(asFiniteNumber(entry.createdAt, 0)),
                trigger: asString(entry.trigger).trim(),
                triggerLabel: asString(entry.triggerLabel).trim(),
                mode: asString(entry.mode).trim() === 'auto' ? 'auto' : 'manual',
                customName: asString(entry.customName).trim(),
                pinned: Boolean(entry.pinned),
                milestoneLabel: asString(entry.milestoneLabel).trim(),
                fingerprint: asString(entry.fingerprint).trim(),
                messageCount: Math.trunc(asFiniteNumber(entry.messageCount, 0)),
                lastMessagePreview: asString(entry.lastMessagePreview),
                lastMessageName: asString(entry.lastMessageName),
                lastMessageAt: asString(entry.lastMessageAt),
                label: asString(entry.label).trim(),
                source: asObject(entry.source),
                resources: normalizeCloudResourceRefs(entry.resources),
                resourceSummary: summarizeCloudResourceRefs(entry.resources),
                publishedByDevices: asArray(entry.publishedByDevices).map((item) => asString(item).trim()).filter(Boolean),
            }))
            .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));

        return {
            scopeId: scopeRecord.scopeId,
            label: scopeRecord.label || getSourceLabel(scopeRecord.source),
            source: scopeRecord.source,
            updatedAt: entries[0]?.createdAt || 0,
            entryCount: entries.length,
            deviceCount: scopeRecord.devices.size,
            devices: Array.from(scopeRecord.devices, ([deviceId, deviceName]) => ({
                deviceId,
                deviceName,
            })),
            latestEntry: entries[0] || null,
            entries,
        };
    }).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

    const comparablePrevious = {
        scopeCount: previousManifest.scopeCount,
        snapshotCount: previousManifest.snapshotCount,
        deviceCount: previousManifest.deviceCount,
        scopes: previousManifest.scopes,
    };
    const comparableNext = {
        scopeCount: scopes.length,
        snapshotCount: scopes.reduce((sum, scope) => sum + scope.entryCount, 0),
        deviceCount: allDevices.size,
        scopes,
    };

    const manifest = {
        version: CLOUD_FORMAT_VERSION,
        updatedAt: JSON.stringify(comparablePrevious) === JSON.stringify(comparableNext)
            ? previousManifest.updatedAt
            : Date.now(),
        ...comparableNext,
    };
    writeJsonAtomic(cloudPaths.manifestPath, manifest);
    return manifest;
}

async function readCloudManifest(baseDirectory, config) {
    const cloudPaths = await ensureCloudRepositoryReady(baseDirectory, config);
    const manifest = normalizeCloudManifest(readJson(cloudPaths.manifestPath, buildEmptyCloudManifest()));
    if (manifest.scopes.length > 0 || fs.existsSync(cloudPaths.manifestPath)) {
        return {
            cloudPaths,
            manifest,
        };
    }

    return {
        cloudPaths,
        manifest: rebuildCloudManifest(cloudPaths),
    };
}

async function connectCloudRemote(baseDirectory) {
    const config = readCloudConfig(baseDirectory);
    if (!config.repoUrl || !config.githubToken) {
        throw new Error('repo_url_or_token_missing');
    }

    const repoPath = getCloudPaths(baseDirectory, config).repoPath;
    return withCloudRepoOperationLock(repoPath, async () => {
        const cloudPaths = await ensureCloudRepositoryReady(baseDirectory, config);
        const manifest = normalizeCloudManifest(readJson(cloudPaths.manifestPath, buildEmptyCloudManifest()));
        return {
            config,
            manifest,
        };
    });
}

async function pushCloudSelectionToRemote(baseDirectory, directories) {
    const initialConfig = readCloudConfig(baseDirectory);
    if (!initialConfig.repoUrl || !initialConfig.githubToken) {
        throw new Error('repo_url_or_token_missing');
    }

    const selection = collectLocalCloudSelection(baseDirectory, initialConfig, directories);
    let lastError = null;
    const repoPath = getCloudPaths(baseDirectory, initialConfig).repoPath;

    return withCloudRepoOperationLock(repoPath, async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const config = readCloudConfig(baseDirectory);
            try {
                const cloudPaths = await ensureCloudRepositoryReady(baseDirectory, config);
                writeCloudMarker(cloudPaths, config);
                writeCloudSelectionObjects(cloudPaths, config, selection);
                writeCloudSelectionResources(cloudPaths, selection);
                writeCloudDeviceSelection(cloudPaths, config, selection);
                const manifest = rebuildCloudManifest(cloudPaths);

                if (!(await cloudRepositoryHasChanges(cloudPaths))) {
                    saveCloudConfig(baseDirectory, {
                        ...config,
                        lastPulledAt: Date.now(),
                        lastPushedAt: Date.now(),
                    });
                    return {
                        config: readCloudConfig(baseDirectory),
                        manifest,
                        selection,
                        pushed: false,
                    };
                }

                await runGit(['add', '-A'], { cwd: cloudPaths.repoPath });
                const commitResult = await runGit(['commit', '-m', `Chat Vault cloud sync: ${config.deviceName || config.deviceId}`], {
                    cwd: cloudPaths.repoPath,
                    allowFailure: true,
                });
                if (!commitResult.ok && !commitResult.stderr.toLowerCase().includes('nothing to commit')) {
                    throw new Error(commitResult.stderr || 'failed to commit cloud sync');
                }

                await pushCloudBranch(cloudPaths, config.branch);
                saveCloudConfig(baseDirectory, {
                    ...config,
                    lastPulledAt: Date.now(),
                    lastPushedAt: Date.now(),
                });
                return {
                    config: readCloudConfig(baseDirectory),
                    manifest,
                    selection,
                    pushed: true,
                };
            } catch (error) {
                lastError = error;
                if ((!isCloudNonFastForwardError(error) && !isCloudTransientPushError(error)) || attempt >= 1) {
                    throw error;
                }
            }
        }

        throw lastError || new Error('failed_to_push_cloud_selection');
    });
}

async function listRemoteCloudScopes(baseDirectory) {
    const config = readCloudConfig(baseDirectory);
    if (!config.repoUrl || !config.githubToken) {
        throw new Error('repo_url_or_token_missing');
    }

    const repoPath = getCloudPaths(baseDirectory, config).repoPath;
    return withCloudRepoOperationLock(repoPath, async () => {
        const { manifest } = await readCloudManifest(baseDirectory, config);
        saveCloudConfig(baseDirectory, {
            ...config,
            lastPulledAt: Date.now(),
        });
        return {
            config: readCloudConfig(baseDirectory),
            manifest,
        };
    });
}

async function getRemoteCloudSnapshot(baseDirectory, scopeId, snapshotId) {
    const config = readCloudConfig(baseDirectory);
    if (!config.repoUrl || !config.githubToken) {
        throw new Error('repo_url_or_token_missing');
    }

    const repoPath = getCloudPaths(baseDirectory, config).repoPath;
    return withCloudRepoOperationLock(repoPath, async () => {
        const { cloudPaths, manifest } = await readCloudManifest(baseDirectory, config);
        const targetScope = manifest.scopes.find((scope) => asString(scope.scopeId).trim() === asString(scopeId).trim());
        const entry = targetScope?.entries?.find((item) => asString(item.snapshotId).trim() === asString(snapshotId).trim());
        if (!targetScope || !entry) {
            throw new Error('cloud_snapshot_not_found');
        }

        const objectPaths = getCloudObjectPaths(cloudPaths, scopeId, snapshotId);
        const meta = asObject(readJson(objectPaths.metaPath, null));
        if (!asString(meta.snapshotId).trim()) {
            throw new Error('cloud_snapshot_meta_not_found');
        }

        const snapshot = readSnapshotFile(objectPaths.snapshotPath);
        const summary = getSnapshotSummary(snapshot);
        return {
            config,
            cloudPaths,
            scope: targetScope,
            entry,
            meta,
            snapshot,
            header: summary.header,
            messages: summary.messages,
        };
    });
}

function replaceAvatarToken(value, oldAvatar, newAvatar) {
    if (!value || !oldAvatar || oldAvatar === newAvatar) {
        return value;
    }

    return asString(value)
        .replaceAll(encodeURIComponent(oldAvatar), encodeURIComponent(newAvatar))
        .replaceAll(oldAvatar, newAvatar);
}

function buildImportedFileName(baseName, extension, hash, directoryPath) {
    const safeBase = sanitizePathPart(baseName, 'resource', 96);
    const safeExtension = asString(extension).trim().toLowerCase();
    const directName = `${safeBase}${safeExtension}`;
    if (!fs.existsSync(path.join(directoryPath, directName))) {
        return directName;
    }

    const variantBase = `${safeBase}__vault_${hash.slice(0, 8)}`;
    let variantName = `${variantBase}${safeExtension}`;
    let counter = 2;
    while (fs.existsSync(path.join(directoryPath, variantName))) {
        if (hashBuffer(fs.readFileSync(path.join(directoryPath, variantName))) === hash) {
            return variantName;
        }
        variantName = `${variantBase}_${counter}${safeExtension}`;
        counter += 1;
    }
    return variantName;
}

function findExistingFileByHash(directoryPath, extension, hash) {
    const normalizedExtension = asString(extension).trim().toLowerCase();
    if (!fs.existsSync(directoryPath)) {
        return '';
    }

    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        if (!entry.isFile()) {
            continue;
        }

        if (normalizedExtension && path.extname(entry.name).toLowerCase() !== normalizedExtension) {
            continue;
        }

        const filePath = path.join(directoryPath, entry.name);
        if (hashBuffer(fs.readFileSync(filePath)) === hash) {
            return entry.name;
        }
    }

    return '';
}

function readCloudResourcePayload(cloudPaths, ref) {
    const resourcePaths = getCloudResourcePaths(
        cloudPaths,
        ref.kind,
        ref.hash,
        ref.extension || path.extname(asString(ref.fileName).trim()),
    );
    if (!fs.existsSync(resourcePaths.metaPath) || !fs.existsSync(resourcePaths.dataPath)) {
        throw new Error(`cloud_resource_not_found:${ref.kind}:${ref.hash}`);
    }

    return {
        meta: asObject(readJson(resourcePaths.metaPath, null)),
        data: fs.readFileSync(resourcePaths.dataPath),
    };
}

function importCloudWorldResource(directories, resourceMeta, buffer) {
    const originalName = asString(resourceMeta.worldName).trim() || path.parse(asString(resourceMeta.fileName).trim()).name || `world_${asString(resourceMeta.hash).slice(0, 8)}`;
    const desiredFileName = `${sanitizePathPart(originalName, 'world', 120)}.json`;
    const desiredPath = path.join(directories.worlds, desiredFileName);
    const incomingHash = hashBuffer(buffer);
    const existingFileByHash = findExistingFileByHash(directories.worlds, '.json', incomingHash);

    if (existingFileByHash) {
        return {
            originalName,
            finalName: path.parse(existingFileByHash).name,
            created: false,
        };
    }

    if (fs.existsSync(desiredPath) && hashBuffer(fs.readFileSync(desiredPath)) === incomingHash) {
        return {
            originalName,
            finalName: path.parse(desiredFileName).name,
            created: false,
        };
    }

    const finalFileName = fs.existsSync(desiredPath)
        ? buildImportedFileName(path.parse(desiredFileName).name, '.json', incomingHash, directories.worlds)
        : desiredFileName;
    writeBufferAtomic(path.join(directories.worlds, finalFileName), buffer);
    return {
        originalName,
        finalName: path.parse(finalFileName).name,
        created: true,
    };
}

function importCloudCharacterResource(directories, resourceMeta, buffer) {
    const originalAvatarUrl = asString(resourceMeta.avatarUrl).trim() || asString(resourceMeta.fileName).trim() || `character_${asString(resourceMeta.hash).slice(0, 8)}.png`;
    const desiredBaseName = asString(resourceMeta.displayName).trim()
        || tryDecodePathPart(path.parse(originalAvatarUrl).name)
        || `character_${asString(resourceMeta.hash).slice(0, 8)}`;
    const desiredExtension = path.extname(originalAvatarUrl) || '.png';
    const desiredFileName = `${sanitizePathPart(desiredBaseName, 'character', 120)}${desiredExtension}`;
    const desiredPath = path.join(directories.characters, desiredFileName);
    const incomingHash = hashBuffer(buffer);
    const existingFileByHash = findExistingFileByHash(directories.characters, desiredExtension, incomingHash);

    if (existingFileByHash) {
        return {
            originalAvatarUrl,
            finalAvatarUrl: existingFileByHash,
            created: false,
        };
    }

    if (fs.existsSync(desiredPath) && hashBuffer(fs.readFileSync(desiredPath)) === incomingHash) {
        return {
            originalAvatarUrl,
            finalAvatarUrl: desiredFileName,
            created: false,
        };
    }

    const finalFileName = fs.existsSync(desiredPath)
        ? buildImportedFileName(path.parse(desiredFileName).name, desiredExtension, incomingHash, directories.characters)
        : desiredFileName;
    writeBufferAtomic(path.join(directories.characters, finalFileName), buffer);
    return {
        originalAvatarUrl,
        finalAvatarUrl: finalFileName,
        created: true,
    };
}

function importCloudPersonaAvatarResource(directories, resourceMeta, buffer) {
    const originalAvatarId = asString(resourceMeta.avatarUrl).trim() || asString(resourceMeta.fileName).trim() || `persona_${asString(resourceMeta.hash).slice(0, 8)}.png`;
    const desiredBaseName = path.parse(originalAvatarId).name || `persona_${asString(resourceMeta.hash).slice(0, 8)}`;
    const desiredExtension = path.extname(originalAvatarId) || '.png';
    const desiredFileName = `${sanitizePathPart(desiredBaseName, 'persona', 120)}${desiredExtension}`;
    const desiredPath = path.join(directories.avatars, desiredFileName);
    const incomingHash = hashBuffer(buffer);
    const existingFileByHash = findExistingFileByHash(directories.avatars, desiredExtension, incomingHash);

    if (existingFileByHash) {
        return {
            originalAvatarId,
            finalAvatarId: existingFileByHash,
            created: false,
        };
    }

    if (fs.existsSync(desiredPath) && hashBuffer(fs.readFileSync(desiredPath)) === incomingHash) {
        return {
            originalAvatarId,
            finalAvatarId: desiredFileName,
            created: false,
        };
    }

    const finalFileName = fs.existsSync(desiredPath)
        ? buildImportedFileName(path.parse(desiredFileName).name, desiredExtension, incomingHash, directories.avatars)
        : desiredFileName;
    writeBufferAtomic(path.join(directories.avatars, finalFileName), buffer);
    return {
        originalAvatarId,
        finalAvatarId: finalFileName,
        created: true,
    };
}

function buildImportedGroupData(groupData, finalGroupId, characterAvatarMap, worldNameMap) {
    const nextGroup = cloneData(groupData) || {};
    nextGroup.id = finalGroupId;
    nextGroup.chat_id = finalGroupId;
    nextGroup.chats = [];
    nextGroup.past_metadata = {};
    nextGroup.members = asArray(nextGroup.members).map((memberAvatar) => {
        return characterAvatarMap.get(asString(memberAvatar).trim()) || asString(memberAvatar).trim();
    }).filter(Boolean);

    if (asObject(nextGroup.chat_metadata).world_info) {
        const currentWorldName = asString(nextGroup.chat_metadata.world_info).trim();
        if (worldNameMap.has(currentWorldName)) {
            nextGroup.chat_metadata.world_info = worldNameMap.get(currentWorldName);
        }
    }

    return nextGroup;
}

function buildComparableGroupState(groupData) {
    const comparable = cloneData(groupData) || {};
    delete comparable.id;
    delete comparable.chat_id;
    delete comparable.chats;
    delete comparable.past_metadata;
    return JSON.stringify(comparable);
}

function importCloudGroupResource(directories, resourceMeta, buffer, characterAvatarMap, worldNameMap) {
    const parsedGroup = asObject(JSON.parse(buffer.toString('utf8')));
    const originalGroupId = asString(resourceMeta.groupId).trim() || asString(parsedGroup.id).trim() || createId();
    const desiredPath = path.join(directories.groups, `${sanitizePathPart(originalGroupId, 'group', 120)}.json`);
    const desiredGroup = buildImportedGroupData(parsedGroup, originalGroupId, characterAvatarMap, worldNameMap);
    const desiredText = JSON.stringify(desiredGroup, null, 4);
    const comparableDesiredState = buildComparableGroupState(desiredGroup);

    if (fs.existsSync(desiredPath) && fs.readFileSync(desiredPath, 'utf8') === desiredText) {
        return {
            originalGroupId,
            finalGroupId: desiredGroup.id,
            finalGroupName: asString(desiredGroup.name).trim(),
            created: false,
        };
    }

    if (fs.existsSync(directories.groups)) {
        for (const fileName of fs.readdirSync(directories.groups)) {
            if (path.extname(fileName).toLowerCase() !== '.json') {
                continue;
            }

            const filePath = path.join(directories.groups, fileName);
            const existingGroupText = fs.readFileSync(filePath, 'utf8');
            const existingGroup = asObject(JSON.parse(existingGroupText));
            if (buildComparableGroupState(existingGroup) !== comparableDesiredState) {
                continue;
            }

            return {
                originalGroupId,
                finalGroupId: asString(existingGroup.id).trim() || path.parse(fileName).name,
                finalGroupName: asString(existingGroup.name).trim(),
                created: false,
            };
        }
    }

    let finalGroupId = desiredGroup.id;
    let finalText = desiredText;
    let finalPath = desiredPath;

    if (fs.existsSync(desiredPath)) {
        do {
            finalGroupId = createId();
            const candidateGroup = buildImportedGroupData(parsedGroup, finalGroupId, characterAvatarMap, worldNameMap);
            finalText = JSON.stringify(candidateGroup, null, 4);
            finalPath = path.join(directories.groups, `${sanitizePathPart(finalGroupId, 'group', 120)}.json`);
        } while (fs.existsSync(finalPath));
    }

    writeTextAtomic(finalPath, finalText);
    const finalGroup = JSON.parse(finalText);
    return {
        originalGroupId,
        finalGroupId: asString(finalGroup.id).trim() || finalGroupId,
        finalGroupName: asString(finalGroup.name).trim(),
        created: true,
    };
}

function applyImportedExtraWorldBindings(directories, bindings) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
        return [];
    }

    const settings = asObject(readUserSettings(directories));
    const worldInfo = asObject(settings.world_info);
    const charLore = asArray(worldInfo.charLore).map((entry) => asObject(entry)).filter((entry) => asString(entry.name).trim());
    let changed = false;
    const applied = [];

    for (const binding of bindings) {
        const avatarUrl = asString(binding.avatarUrl).trim();
        const worldNames = Array.from(new Set(asArray(binding.worldNames).map((item) => asString(item).trim()).filter(Boolean)));
        const avatarBase = getAvatarFileBaseName(avatarUrl);
        if (!avatarBase || worldNames.length === 0) {
            continue;
        }

        const existingIndex = charLore.findIndex((entry) => asString(entry.name).trim() === avatarBase);
        if (existingIndex < 0) {
            charLore.push({
                name: avatarBase,
                extraBooks: worldNames,
            });
            changed = true;
        } else {
            const merged = Array.from(new Set(asArray(charLore[existingIndex].extraBooks).map((item) => asString(item).trim()).filter(Boolean).concat(worldNames)));
            if (JSON.stringify(merged) !== JSON.stringify(asArray(charLore[existingIndex].extraBooks))) {
                charLore[existingIndex].extraBooks = merged;
                changed = true;
            }
        }

        applied.push({
            avatarUrl,
            worldNames,
        });
    }

    if (changed) {
        settings.world_info = {
            ...worldInfo,
            charLore,
        };
        saveUserSettings(directories, settings);
    }

    return applied;
}

function mergePersonaConnections(existingConnections, newConnection) {
    const normalizedConnections = asArray(existingConnections)
        .map((connection) => normalizePersonaConnection(connection))
        .filter(Boolean);
    if (!newConnection?.id) {
        return normalizedConnections;
    }

    if (normalizedConnections.some((connection) => connection.type === newConnection.type && connection.id === newConnection.id)) {
        return normalizedConnections;
    }

    return [...normalizedConnections, newConnection];
}

function applyImportedPersonas(directories, personaImports) {
    if (!Array.isArray(personaImports) || personaImports.length === 0) {
        return [];
    }

    const { settings, powerUser } = getPowerUserSettingsRecord(directories);
    powerUser.personas = asObject(powerUser.personas);
    powerUser.persona_descriptions = asObject(powerUser.persona_descriptions);
    const applied = [];
    let changed = false;

    for (const personaImport of personaImports) {
        const avatarId = asString(personaImport.avatarId).trim();
        if (!avatarId) {
            continue;
        }

        const personaName = asString(personaImport.personaName).trim() || avatarId;
        const descriptor = normalizePersonaDescriptor(personaImport.descriptor);
        const existingName = asString(powerUser.personas[avatarId]).trim();
        const existingDescriptor = normalizePersonaDescriptor(powerUser.persona_descriptions[avatarId]);
        const nextDescriptor = {
            description: descriptor.description,
            position: descriptor.position,
            depth: descriptor.depth,
            role: descriptor.role,
            lorebook: descriptor.lorebook,
            connections: personaImport.connectToSource
                ? mergePersonaConnections(existingDescriptor.connections, normalizePersonaConnection(personaImport.connection))
                : existingDescriptor.connections,
        };

        if (existingName !== personaName) {
            powerUser.personas[avatarId] = personaName;
            changed = true;
        }
        if (JSON.stringify(existingDescriptor) !== JSON.stringify(nextDescriptor)) {
            powerUser.persona_descriptions[avatarId] = nextDescriptor;
            changed = true;
        }

        applied.push({
            avatarId,
            personaName,
            descriptor: nextDescriptor,
            chatLocked: Boolean(personaImport.chatLocked),
            connectedToSource: Boolean(personaImport.connectToSource),
        });
    }

    if (changed) {
        settings.power_user = {
            ...powerUser,
            personas: powerUser.personas,
            persona_descriptions: powerUser.persona_descriptions,
        };
        saveUserSettings(directories, settings);
    }

    return applied;
}

function prepareCloudSnapshotResources(directories, cloudPaths, meta, snapshot) {
    const resourceRefs = normalizeCloudResourceRefs(meta.resources);
    if (resourceRefs.length === 0) {
        return {
            meta,
            snapshot,
            source: normalizeSource(meta.source),
            header: asObject(snapshot[0]),
            messages: snapshot.slice(1),
            resourceImport: {
                characterMappings: [],
                worldMappings: [],
                groupMappings: [],
                extraWorldBindings: [],
                personas: [],
                importedCharacterCount: 0,
                importedWorldCount: 0,
                importedGroupCount: 0,
                importedPersonaCount: 0,
            },
        };
    }

    const worldNameMap = new Map();
    const characterAvatarMap = new Map();
    const groupIdMap = new Map();
    const personaAvatarMap = new Map();
    const processedResources = new Set();
    let importedWorldCount = 0;
    let importedCharacterCount = 0;
    let importedGroupCount = 0;
    let importedPersonaCount = 0;

    for (const ref of resourceRefs.filter((resource) => resource.kind === 'world_info')) {
        const resourceKey = `${ref.kind}:${ref.hash}`;
        if (processedResources.has(resourceKey)) {
            continue;
        }
        processedResources.add(resourceKey);

        const payload = readCloudResourcePayload(cloudPaths, ref);
        const result = importCloudWorldResource(directories, payload.meta, payload.data);
        worldNameMap.set(result.originalName, result.finalName);
        if (result.created) {
            importedWorldCount += 1;
        }
    }

    for (const ref of resourceRefs.filter((resource) => resource.kind === 'character_card')) {
        const resourceKey = `${ref.kind}:${ref.hash}`;
        if (processedResources.has(resourceKey)) {
            continue;
        }
        processedResources.add(resourceKey);

        const payload = readCloudResourcePayload(cloudPaths, ref);
        const result = importCloudCharacterResource(directories, payload.meta, payload.data);
        characterAvatarMap.set(result.originalAvatarUrl, result.finalAvatarUrl);
        if (result.created) {
            importedCharacterCount += 1;
        }
    }

    for (const ref of resourceRefs.filter((resource) => resource.kind === 'group_definition')) {
        const resourceKey = `${ref.kind}:${ref.hash}`;
        if (processedResources.has(resourceKey)) {
            continue;
        }
        processedResources.add(resourceKey);

        const payload = readCloudResourcePayload(cloudPaths, ref);
        const result = importCloudGroupResource(directories, payload.meta, payload.data, characterAvatarMap, worldNameMap);
        groupIdMap.set(result.originalGroupId, {
            finalGroupId: result.finalGroupId,
            finalGroupName: result.finalGroupName,
        });
        if (result.created) {
            importedGroupCount += 1;
        }
    }

    for (const ref of resourceRefs.filter((resource) => resource.kind === 'persona_avatar')) {
        const resourceKey = `${ref.kind}:${ref.hash}`;
        if (processedResources.has(resourceKey)) {
            continue;
        }
        processedResources.add(resourceKey);

        const payload = readCloudResourcePayload(cloudPaths, ref);
        const result = importCloudPersonaAvatarResource(directories, payload.meta, payload.data);
        personaAvatarMap.set(result.originalAvatarId, result.finalAvatarId);
        if (result.created) {
            importedPersonaCount += 1;
        }
    }

    const extraWorldBindingMap = new Map();
    for (const ref of resourceRefs.filter((resource) => resource.role === 'character_additional_world')) {
        const originalAvatarUrl = asString(ref.ownerAvatarUrl).trim();
        const originalWorldName = asString(ref.worldName).trim();
        const finalAvatarUrl = characterAvatarMap.get(originalAvatarUrl) || originalAvatarUrl;
        const finalWorldName = worldNameMap.get(originalWorldName) || originalWorldName;
        if (!finalAvatarUrl || !finalWorldName) {
            continue;
        }

        if (!extraWorldBindingMap.has(finalAvatarUrl)) {
            extraWorldBindingMap.set(finalAvatarUrl, new Set());
        }
        extraWorldBindingMap.get(finalAvatarUrl).add(finalWorldName);
    }

    const appliedExtraWorldBindings = applyImportedExtraWorldBindings(directories, Array.from(extraWorldBindingMap, ([avatarUrl, worldNames]) => ({
        avatarUrl,
        worldNames: Array.from(worldNames),
    })));

    const preparedSnapshot = cloneData(snapshot);
    const preparedHeader = asObject(preparedSnapshot[0]);
    const preparedMessages = preparedSnapshot.slice(1).filter((item) => item && typeof item === 'object');
    const preparedMeta = {
        ...meta,
        source: {
            ...asObject(meta.source),
        },
    };

    const source = asObject(preparedMeta.source);
    if (source.avatarUrl) {
        source.avatarUrl = characterAvatarMap.get(asString(source.avatarUrl).trim()) || source.avatarUrl;
    }
    if (source.kind === 'group' && source.groupId) {
        const groupMapping = groupIdMap.get(asString(source.groupId).trim());
        if (groupMapping) {
            source.groupId = groupMapping.finalGroupId;
            if (groupMapping.finalGroupName) {
                source.groupName = groupMapping.finalGroupName;
                source.currentName = groupMapping.finalGroupName;
            }
        }
    }
    preparedMeta.source = normalizeSource(source);
    const sourceConnection = getSourcePersonaConnection(preparedMeta.source);

    const preparedChatMetadata = asObject(preparedHeader.chat_metadata);
    const currentChatWorld = asString(preparedChatMetadata.world_info).trim();
    if (currentChatWorld && worldNameMap.has(currentChatWorld)) {
        preparedChatMetadata.world_info = worldNameMap.get(currentChatWorld);
        preparedHeader.chat_metadata = preparedChatMetadata;
    }

    const personaProfileRefs = resourceRefs.filter((resource) => resource.kind === 'persona_profile');
    const personaImports = [];
    const processedPersonaProfiles = new Set();
    for (const ref of personaProfileRefs) {
        const profileKey = `${ref.hash}:${ref.avatarUrl}`;
        if (processedPersonaProfiles.has(profileKey)) {
            continue;
        }
        processedPersonaProfiles.add(profileKey);

        const relatedRefs = personaProfileRefs.filter((item) => item.hash === ref.hash && item.avatarUrl === ref.avatarUrl);
        const roleSet = new Set(relatedRefs.map((item) => asString(item.role).trim()));
        const payload = readCloudResourcePayload(cloudPaths, ref);
        const profile = asObject(JSON.parse(payload.data.toString('utf8')));
        const originalAvatarId = asString(profile.avatarId).trim() || asString(ref.avatarUrl).trim();
        const finalAvatarId = personaAvatarMap.get(originalAvatarId) || originalAvatarId;
        const descriptor = normalizePersonaDescriptor(profile.descriptor);
        if (descriptor.lorebook && worldNameMap.has(descriptor.lorebook)) {
            descriptor.lorebook = worldNameMap.get(descriptor.lorebook);
        }

        personaImports.push({
            avatarId: finalAvatarId,
            personaName: asString(profile.personaName).trim() || asString(ref.displayName).trim() || finalAvatarId,
            descriptor,
            chatLocked: roleSet.has('chat_persona'),
            connectToSource: roleSet.has('scope_persona_connection'),
            connection: roleSet.has('scope_persona_connection') ? sourceConnection : null,
        });
    }
    const appliedPersonas = applyImportedPersonas(directories, personaImports);

    const currentChatPersona = asString(preparedChatMetadata.persona).trim();
    if (currentChatPersona && personaAvatarMap.has(currentChatPersona)) {
        preparedChatMetadata.persona = personaAvatarMap.get(currentChatPersona);
        preparedHeader.chat_metadata = preparedChatMetadata;
    }

    for (const message of preparedMessages) {
        const originalAvatar = asString(message.original_avatar).trim();
        if (originalAvatar && characterAvatarMap.has(originalAvatar)) {
            const nextAvatar = characterAvatarMap.get(originalAvatar);
            message.original_avatar = nextAvatar;
            if (message.force_avatar) {
                message.force_avatar = replaceAvatarToken(message.force_avatar, originalAvatar, nextAvatar);
            }
        }
    }

    return {
        meta: preparedMeta,
        snapshot: preparedSnapshot,
        source: preparedMeta.source,
        header: preparedHeader,
        messages: preparedMessages,
        resourceImport: {
            characterMappings: Array.from(characterAvatarMap, ([originalAvatarUrl, finalAvatarUrl]) => ({
                originalAvatarUrl,
                finalAvatarUrl,
            })),
            worldMappings: Array.from(worldNameMap, ([originalName, finalName]) => ({
                originalName,
                finalName,
            })),
            groupMappings: Array.from(groupIdMap, ([originalGroupId, value]) => ({
                originalGroupId,
                finalGroupId: value.finalGroupId,
                finalGroupName: value.finalGroupName,
            })),
            extraWorldBindings: appliedExtraWorldBindings,
            personas: appliedPersonas,
            importedCharacterCount,
            importedWorldCount,
            importedGroupCount,
            importedPersonaCount,
        },
    };
}

function buildReferencedCloudSnapshotMapFromMetaRoot(cloudPaths) {
    const referenced = new Map();
    if (!fs.existsSync(cloudPaths.metaRoot)) {
        return referenced;
    }

    for (const scopeDirectory of fs.readdirSync(cloudPaths.metaRoot, { withFileTypes: true })) {
        if (!scopeDirectory.isDirectory()) {
            continue;
        }

        const scopeId = scopeDirectory.name;
        const absoluteScopePath = path.join(cloudPaths.metaRoot, scopeDirectory.name);
        for (const fileName of fs.readdirSync(absoluteScopePath)) {
            if (!fileName.endsWith('.json')) {
                continue;
            }

            const meta = asObject(readJson(path.join(absoluteScopePath, fileName), null));
            const snapshotId = asString(meta.snapshotId).trim() || path.parse(fileName).name;
            if (!snapshotId) {
                continue;
            }

            if (!referenced.has(scopeId)) {
                referenced.set(scopeId, new Set());
            }
            referenced.get(scopeId).add(snapshotId);
        }
    }

    return referenced;
}

function removeSnapshotFromCloudDeviceStates(cloudPaths, scopeId, snapshotId) {
    if (!fs.existsSync(cloudPaths.devicesRoot)) {
        return;
    }

    for (const fileName of fs.readdirSync(cloudPaths.devicesRoot)) {
        if (!fileName.endsWith('.json')) {
            continue;
        }

        const statePath = path.join(cloudPaths.devicesRoot, fileName);
        const state = asObject(readJson(statePath, null));
        const scopes = asArray(state.scopes);
        const nextScopes = scopes.map((scope) => {
            const scopeState = asObject(scope);
            if (asString(scopeState.scopeId).trim() !== scopeId) {
                return scopeState;
            }

            return {
                ...scopeState,
                snapshotIds: asArray(scopeState.snapshotIds).map((item) => asString(item).trim()).filter((item) => item && item !== snapshotId),
            };
        }).filter((scopeState) => asString(scopeState.scopeId).trim() && asArray(scopeState.snapshotIds).length > 0);

        if (JSON.stringify(scopes) === JSON.stringify(nextScopes)) {
            continue;
        }

        writeJsonAtomic(statePath, {
            ...state,
            scopes: nextScopes,
            updatedAt: Date.now(),
        });
    }
}

function deleteCloudSnapshotArtifacts(cloudPaths, scopeId, snapshotId) {
    const objectPaths = getCloudObjectPaths(cloudPaths, scopeId, snapshotId);
    deleteFileSafe(objectPaths.metaPath);
    deleteFileSafe(objectPaths.snapshotPath);
    for (const directoryPath of [path.dirname(objectPaths.metaPath), path.dirname(objectPaths.snapshotPath)]) {
        if (fs.existsSync(directoryPath) && fs.readdirSync(directoryPath).length === 0) {
            fs.rmSync(directoryPath, { recursive: true, force: true });
        }
    }
}

function cleanupCloudAfterExplicitDelete(cloudPaths) {
    const referencedMap = buildReferencedCloudSnapshotMapFromMetaRoot(cloudPaths);
    pruneCloudObjects(cloudPaths, referencedMap);
    pruneCloudResources(cloudPaths, buildReferencedCloudResourceMap(cloudPaths, referencedMap));
}

async function deleteRemoteCloudSnapshot(baseDirectory, scopeId, snapshotId) {
    const config = readCloudConfig(baseDirectory);
    if (!config.repoUrl || !config.githubToken) {
        throw new Error('repo_url_or_token_missing');
    }

    const repoPath = getCloudPaths(baseDirectory, config).repoPath;
    return withCloudRepoOperationLock(repoPath, async () => {
        const cloudPaths = await ensureCloudRepositoryReady(baseDirectory, config);
        const objectPaths = getCloudObjectPaths(cloudPaths, scopeId, snapshotId);
        if (!fs.existsSync(objectPaths.metaPath)) {
            throw new Error('cloud_snapshot_not_found');
        }

        deleteCloudSnapshotArtifacts(cloudPaths, scopeId, snapshotId);
        removeSnapshotFromCloudDeviceStates(cloudPaths, scopeId, snapshotId);
        cleanupCloudAfterExplicitDelete(cloudPaths);
        const manifest = rebuildCloudManifest(cloudPaths);

        if (await cloudRepositoryHasChanges(cloudPaths)) {
            await runGit(['add', '-A'], { cwd: cloudPaths.repoPath });
            const commitResult = await runGit(['commit', '-m', `Chat Vault cloud delete: ${scopeId}/${snapshotId}`], {
                cwd: cloudPaths.repoPath,
                allowFailure: true,
            });
            if (!commitResult.ok && !commitResult.stderr.toLowerCase().includes('nothing to commit')) {
                throw new Error(commitResult.stderr || 'failed to commit cloud delete');
            }
            await pushCloudBranch(cloudPaths, config.branch);
        }

        saveCloudConfig(baseDirectory, {
            ...config,
            lastPulledAt: Date.now(),
            lastPushedAt: Date.now(),
        });

        return {
            config: readCloudConfig(baseDirectory),
            manifest,
        };
    });
}

function importCloudSnapshotIntoLocal(baseDirectory, meta, snapshot) {
    const source = normalizeSource(meta.source);
    const paths = getScopePathsFromBaseDirectory(baseDirectory, source);
    const index = readIndex(paths, paths.source);
    const remoteFingerprint = asString(meta.fingerprint).trim() || sha1(snapshotToJsonl(snapshot));
    const existingEntry = index.entries.find((entry) => asString(entry.fingerprint).trim() === remoteFingerprint);
    if (existingEntry) {
        return {
            created: false,
            source: paths.source,
            entry: existingEntry,
        };
    }

    const entry = createSnapshotEntry(paths.source, snapshot, {
        createdAt: Math.trunc(asFiniteNumber(meta.createdAt, Date.now())),
        trigger: 'cloud_import',
        mode: 'manual',
        pinned: Boolean(meta.pinned),
        snapshotFileTemplate: '{{name}} - cloud-import - {{time}}',
    });
    const customName = asString(meta.customName).trim();
    if (customName) {
        entry.customName = customName.slice(0, 120);
        entry.snapshotFile = buildSnapshotFileNameFromLabel(entry.customName, entry.id);
    }

    writeSnapshot(paths, entry);
    index.source = paths.source;
    index.entries.unshift(withoutJsonl(entry));
    sortEntries(index.entries);
    saveIndex(paths, index);

    return {
        created: true,
        source: paths.source,
        entry: withoutJsonl(entry),
    };
}

export async function init(router) {
    router.use(express.json({ limit: MAX_REQUEST_SIZE }));

    router.post('/probe', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        response.send({
            ok: true,
            plugin: info.id,
        });
    });

    router.post('/snapshot/create', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            if (!source.chatId) {
                return response.status(400).send({ ok: false, error: 'chatId is required' });
            }

            const snapshot = asArray(request.body?.snapshot).filter((item) => item && typeof item === 'object');
            if (snapshot.length === 0) {
                return response.status(400).send({ ok: false, error: 'snapshot is required' });
            }

            const forceNew = Boolean(request.body?.forceNew);
            const replaceLatest = Boolean(request.body?.replaceLatest);
            const maxAutoSnapshots = normalizeMaxAutoSnapshots(request.body?.maxAutoSnapshots);
            const paths = getScopePaths(request, source);
            const resolvedSource = paths.source;
            const index = readIndex(paths, resolvedSource);
            let indexHydrated = false;
            for (const entry of index.entries) {
                if (entry.mode === 'auto') {
                    indexHydrated = hydrateEntryDerivedFields(paths, resolvedSource, entry) || indexHydrated;
                }
            }
            if (indexHydrated) {
                saveIndex(paths, index);
            }
            const candidateEntry = createSnapshotEntry(resolvedSource, snapshot, request.body ?? {});
            const latestEntry = index.entries[0];
            const sameTurnAutoEntry = candidateEntry.mode === 'auto' && candidateEntry.turnAnchorKey
                ? index.entries.find((entry) => entry.mode === 'auto' && entry.turnAnchorKey === candidateEntry.turnAnchorKey && !entry.pinned)
                : null;
            const sameSeriesAutoEntry = candidateEntry.mode === 'auto' && candidateEntry.seriesKey
                ? index.entries.find((entry) => entry.mode === 'auto' && entry.seriesKey === candidateEntry.seriesKey && !entry.pinned)
                : null;
            const replaceableAutoEntry = replaceLatest
                ? index.entries.find((entry) => entry.mode === 'auto' && !entry.pinned)
                : null;
            const matchedAutoEntry = sameTurnAutoEntry || sameSeriesAutoEntry || null;

            if (!forceNew && matchedAutoEntry?.fingerprint && matchedAutoEntry.fingerprint === candidateEntry.fingerprint) {
                return response.send({
                    ok: true,
                    created: false,
                    deduped: true,
                    entry: matchedAutoEntry,
                    draft: getDraft(paths),
                });
            }

            if (!forceNew && replaceableAutoEntry?.fingerprint && replaceableAutoEntry.fingerprint === candidateEntry.fingerprint) {
                removeOtherAutoEntries(paths, index, replaceableAutoEntry.id);
                saveIndex(paths, index);
                return response.send({
                    ok: true,
                    created: false,
                    deduped: true,
                    entry: replaceableAutoEntry,
                    draft: getDraft(paths),
                });
            }

            if (!forceNew && !replaceLatest && latestEntry?.fingerprint && latestEntry.fingerprint === candidateEntry.fingerprint) {
                return response.send({
                    ok: true,
                    created: false,
                    deduped: true,
                    entry: latestEntry,
                    draft: getDraft(paths),
                });
            }

            let storedEntry = candidateEntry;
            if (matchedAutoEntry) {
                storedEntry = updateSnapshotEntry(matchedAutoEntry, candidateEntry);
            }

            index.source = resolvedSource;
            writeSnapshot(paths, storedEntry);

            if (matchedAutoEntry) {
                const targetIndex = index.entries.findIndex((entry) => entry.id === storedEntry.id);
                if (targetIndex >= 0) {
                    index.entries[targetIndex] = withoutJsonl(storedEntry);
                }
            } else {
                index.entries.unshift(withoutJsonl(storedEntry));
            }

            if (storedEntry.mode === 'auto' && storedEntry.turnAnchorKey) {
                removeSiblingTurnAutoEntries(paths, index, storedEntry.turnAnchorKey, storedEntry.id);
            }
            if (storedEntry.mode === 'auto' && storedEntry.seriesKey) {
                removeSiblingSeriesAutoEntries(paths, index, storedEntry.seriesKey, storedEntry.id);
            }

            if (replaceLatest) {
                removeOtherAutoEntries(paths, index, storedEntry.id);
            }

            sortEntries(index.entries);
            pruneSnapshots(paths, index, maxAutoSnapshots);
            saveIndex(paths, index);

            return response.send({
                ok: true,
                created: true,
                entry: withoutJsonl(storedEntry),
                draft: getDraft(paths),
            });
        } catch (error) {
            console.error('[chat-vault] Failed to create snapshot:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_create_snapshot' });
        }
    });

    router.post('/snapshot/list', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            if (!source.chatId) {
                return response.send({ ok: true, source, draft: null, entries: [] });
            }

            const paths = getScopePaths(request, source);
            return response.send(buildListResponse(paths, paths.source));
        } catch (error) {
            console.error('[chat-vault] Failed to list snapshots:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_list_snapshots' });
        }
    });

    router.post('/scope/list', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const baseDirectory = getBaseDirectory(request);
            const scopesRoot = ensureDirectory(path.join(baseDirectory, 'scopes'));
            const scopesIndex = rebuildScopesIndex(baseDirectory, scopesRoot);
            return response.send({
                ok: true,
                generatedAt: scopesIndex.generatedAt,
                scopes: scopesIndex.scopes,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to list global scopes:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_list_scopes' });
        }
    });

    router.post('/scope/rebind-chat', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const oldSource = normalizeSource(request.body?.oldSource);
            const newSource = normalizeSource(request.body?.newSource);
            if (!oldSource.chatId || !newSource.chatId) {
                return response.status(400).send({ ok: false, error: 'oldSource and newSource are required' });
            }

            const result = rebindChatScope(request, oldSource, newSource);
            return response.send({
                ok: true,
                scopeId: result.scopeId,
                source: result.source,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to rebind chat scope:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_rebind_chat_scope' });
        }
    });

    router.post('/snapshot/preview', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!source.chatId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'source and snapshotId are required' });
            }

            const paths = getScopePaths(request, source);
            const resolvedSource = paths.source;
            const index = readIndex(paths, resolvedSource);
            const entry = index.entries.find((item) => item.id === snapshotId);
            if (!entry) {
                return response.status(404).send({ ok: false, error: 'snapshot_not_found' });
            }

            const previewLimit = normalizePreviewLimit(request.body?.limit);
            const snapshot = readSnapshotFile(path.join(paths.snapshotsDirectory, entry.snapshotFile));
            const summary = getSnapshotSummary(snapshot);
            const previewMessages = summary.messages.slice(-previewLimit).map((message, indexValue) => ({
                index: summary.messageCount - previewLimit + indexValue >= 0
                    ? summary.messageCount - Math.min(previewLimit, summary.messageCount) + indexValue
                    : indexValue,
                name: asString(message?.name),
                sendDate: asString(message?.send_date),
                text: asString(message?.mes),
            }));

            return response.send({
                ok: true,
                entry,
                previewMessages,
                messageCount: summary.messageCount,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to preview snapshot:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_preview_snapshot' });
        }
    });

    router.post('/snapshot/get', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!source.chatId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'source and snapshotId are required' });
            }

            const paths = getScopePaths(request, source);
            const resolvedSource = paths.source;
            const index = readIndex(paths, resolvedSource);
            const entry = index.entries.find((item) => item.id === snapshotId);
            if (!entry) {
                return response.status(404).send({ ok: false, error: 'snapshot_not_found' });
            }

            const snapshot = readSnapshotFile(path.join(paths.snapshotsDirectory, entry.snapshotFile));
            const summary = getSnapshotSummary(snapshot);

            return response.send({
                ok: true,
                entry,
                header: summary.header,
                messages: summary.messages,
                snapshot,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to read snapshot:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_read_snapshot' });
        }
    });

    router.post('/snapshot/pin', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!source.chatId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'source and snapshotId are required' });
            }

            const paths = getScopePaths(request, source);
            const resolvedSource = paths.source;
            const index = readIndex(paths, resolvedSource);
            const entry = index.entries.find((item) => item.id === snapshotId);
            if (!entry) {
                return response.status(404).send({ ok: false, error: 'snapshot_not_found' });
            }

            const shouldPin = request.body?.pinned === undefined ? !entry.pinned : Boolean(request.body?.pinned);
            entry.pinned = shouldPin;
            entry.milestoneLabel = shouldPin ? '长期保留' : '';
            saveIndex(paths, index);

            return response.send({
                ok: true,
                entry,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to update snapshot pin state:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_update_snapshot' });
        }
    });

    router.post('/snapshot/delete', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!source.chatId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'source and snapshotId are required' });
            }

            const paths = getScopePaths(request, source);
            const resolvedSource = paths.source;
            const index = readIndex(paths, resolvedSource);
            const entry = index.entries.find((item) => item.id === snapshotId);
            if (!entry) {
                return response.status(404).send({ ok: false, error: 'snapshot_not_found' });
            }

            deleteFileSafe(path.join(paths.snapshotsDirectory, entry.snapshotFile));
            index.entries = index.entries.filter((item) => item.id !== snapshotId);
            saveIndex(paths, index);

            return response.send({
                ok: true,
                deleted: true,
                snapshotId,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to delete snapshot:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_delete_snapshot' });
        }
    });

    router.post('/snapshot/rename', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            const snapshotId = asString(request.body?.snapshotId).trim();
            const requestedName = asString(request.body?.name).trim();
            if (!source.chatId || !snapshotId || !requestedName) {
                return response.status(400).send({ ok: false, error: 'source, snapshotId and name are required' });
            }

            const paths = getScopePaths(request, source);
            const resolvedSource = paths.source;
            const index = readIndex(paths, resolvedSource);
            const entry = index.entries.find((item) => item.id === snapshotId);
            if (!entry) {
                return response.status(404).send({ ok: false, error: 'snapshot_not_found' });
            }

            const customName = requestedName.slice(0, 120);
            const nextFileName = buildSnapshotFileNameFromLabel(customName, entry.id);
            const currentPath = path.join(paths.snapshotsDirectory, entry.snapshotFile);
            const nextPath = path.join(paths.snapshotsDirectory, nextFileName);

            renameFileSafe(currentPath, nextPath);
            entry.customName = customName;
            entry.snapshotFile = nextFileName;
            saveIndex(paths, index);

            return response.send({
                ok: true,
                entry,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to rename snapshot:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_rename_snapshot' });
        }
    });

    router.post('/draft/save', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            if (!source.chatId) {
                return response.status(400).send({ ok: false, error: 'chatId is required' });
            }

            const paths = getScopePaths(request, source);
            const draft = saveDraft(paths, paths.source, request.body?.draft);

            return response.send({
                ok: true,
                draft,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to save draft:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_save_draft' });
        }
    });

    router.post('/draft/get', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            if (!source.chatId) {
                return response.send({ ok: true, draft: null });
            }

            const paths = getScopePaths(request, source);
            return response.send({
                ok: true,
                draft: getDraft(paths),
            });
        } catch (error) {
            console.error('[chat-vault] Failed to read draft:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_read_draft' });
        }
    });

    router.post('/draft/clear', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const source = normalizeSource(request.body?.source);
            if (!source.chatId) {
                return response.send({ ok: true, cleared: false });
            }

            const paths = getScopePaths(request, source);
            deleteFileSafe(paths.draftPath);

            return response.send({
                ok: true,
                cleared: true,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to clear draft:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_clear_draft' });
        }
    });

    router.post('/cloud/status', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const baseDirectory = getBaseDirectory(request);
            const config = readCloudConfig(baseDirectory);
            const cloudPaths = getCloudPaths(baseDirectory, config);
            const manifest = normalizeCloudManifest(readJson(cloudPaths.manifestPath, buildEmptyCloudManifest()));
            return response.send({
                ok: true,
                config: getSafeCloudConfig(config),
                manifest,
                connected: Boolean(config.repoUrl && config.githubToken),
            });
        } catch (error) {
            console.error('[chat-vault] Failed to read cloud status:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_read_cloud_status' });
        }
    });

    router.post('/cloud/config/save', (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const baseDirectory = getBaseDirectory(request);
            const currentConfig = readCloudConfig(baseDirectory);
            const nextConfig = saveCloudConfig(baseDirectory, {
                ...currentConfig,
                repoUrl: request.body?.repoUrl !== undefined ? request.body.repoUrl : currentConfig.repoUrl,
                branch: request.body?.branch !== undefined ? request.body.branch : currentConfig.branch,
                githubToken: request.body?.githubToken
                    ? request.body.githubToken
                    : currentConfig.githubToken,
                deviceName: request.body?.deviceName !== undefined ? request.body.deviceName : currentConfig.deviceName,
                syncPinned: request.body?.syncPinned !== undefined ? request.body.syncPinned : currentConfig.syncPinned,
                syncLatestStable: request.body?.syncLatestStable !== undefined ? request.body.syncLatestStable : currentConfig.syncLatestStable,
                syncDrafts: request.body?.syncDrafts !== undefined ? request.body.syncDrafts : currentConfig.syncDrafts,
            });
            return response.send({
                ok: true,
                config: getSafeCloudConfig(nextConfig),
            });
        } catch (error) {
            console.error('[chat-vault] Failed to save cloud config:', error);
            return response.status(500).send({ ok: false, error: 'failed_to_save_cloud_config' });
        }
    });

    router.post('/cloud/connect', async (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const baseDirectory = getBaseDirectory(request);
            const result = await connectCloudRemote(baseDirectory);
            return response.send({
                ok: true,
                config: getSafeCloudConfig(result.config),
                manifest: result.manifest,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to connect cloud remote:', error);
            const statusCode = asString(error.message).trim() === 'repo_url_or_token_missing' ? 400 : 500;
            return response.status(statusCode).send({ ok: false, error: 'failed_to_connect_cloud_remote', detail: error.message });
        }
    });

    router.post('/cloud/sync/push', async (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const baseDirectory = getBaseDirectory(request);
            const result = await pushCloudSelectionToRemote(baseDirectory, request.user.directories);
            return response.send({
                ok: true,
                config: getSafeCloudConfig(result.config),
                manifest: result.manifest,
                pushed: result.pushed,
                scopeCount: result.selection.scopeCount,
                snapshotCount: result.selection.snapshotCount,
                resourceCount: result.selection.resourceCount,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to push cloud selection:', error);
            const statusCode = asString(error.message).trim() === 'repo_url_or_token_missing' ? 400 : 500;
            return response.status(statusCode).send({ ok: false, error: 'failed_to_push_cloud_selection', detail: error.message });
        }
    });

    router.post('/cloud/list', async (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const baseDirectory = getBaseDirectory(request);
            const result = await listRemoteCloudScopes(baseDirectory);
            return response.send({
                ok: true,
                config: getSafeCloudConfig(result.config),
                manifest: result.manifest,
                scopes: result.manifest.scopes,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to list cloud scopes:', error);
            const statusCode = asString(error.message).trim() === 'repo_url_or_token_missing' ? 400 : 500;
            return response.status(statusCode).send({ ok: false, error: 'failed_to_list_cloud_scopes', detail: error.message });
        }
    });

    router.post('/cloud/snapshot/get', async (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const scopeId = asString(request.body?.scopeId).trim();
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!scopeId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'scopeId_and_snapshotId_are_required' });
            }

            const baseDirectory = getBaseDirectory(request);
            const result = await getRemoteCloudSnapshot(baseDirectory, scopeId, snapshotId);
            return response.send({
                ok: true,
                scope: result.scope,
                entry: result.entry,
                meta: result.meta,
                header: result.header,
                messages: result.messages,
                snapshot: result.snapshot,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to read cloud snapshot:', error);
            const errorKey = asString(error.message).trim();
            const statusCode = errorKey === 'repo_url_or_token_missing'
                ? 400
                : (['cloud_snapshot_not_found', 'cloud_snapshot_meta_not_found'].includes(errorKey) ? 404 : 500);
            return response.status(statusCode).send({ ok: false, error: 'failed_to_read_cloud_snapshot', detail: error.message });
        }
    });

    router.post('/cloud/snapshot/prepare-restore', async (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const scopeId = asString(request.body?.scopeId).trim();
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!scopeId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'scopeId_and_snapshotId_are_required' });
            }

            const baseDirectory = getBaseDirectory(request);
            const remoteSnapshot = await getRemoteCloudSnapshot(baseDirectory, scopeId, snapshotId);
            const prepared = prepareCloudSnapshotResources(request.user.directories, remoteSnapshot.cloudPaths, remoteSnapshot.meta, remoteSnapshot.snapshot);
            return response.send({
                ok: true,
                scope: remoteSnapshot.scope,
                entry: remoteSnapshot.entry,
                meta: prepared.meta,
                header: prepared.header,
                messages: prepared.messages,
                source: prepared.source,
                resourceImport: prepared.resourceImport,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to prepare cloud snapshot restore:', error);
            const errorKey = asString(error.message).trim();
            const statusCode = errorKey === 'repo_url_or_token_missing'
                ? 400
                : (['cloud_snapshot_not_found', 'cloud_snapshot_meta_not_found'].includes(errorKey) ? 404 : 500);
            return response.status(statusCode).send({ ok: false, error: 'failed_to_prepare_cloud_snapshot_restore', detail: error.message });
        }
    });

    router.post('/cloud/snapshot/import', async (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const scopeId = asString(request.body?.scopeId).trim();
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!scopeId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'scopeId_and_snapshotId_are_required' });
            }

            const baseDirectory = getBaseDirectory(request);
            const remoteSnapshot = await getRemoteCloudSnapshot(baseDirectory, scopeId, snapshotId);
            const prepared = prepareCloudSnapshotResources(request.user.directories, remoteSnapshot.cloudPaths, remoteSnapshot.meta, remoteSnapshot.snapshot);
            const imported = importCloudSnapshotIntoLocal(baseDirectory, prepared.meta, prepared.snapshot);
            return response.send({
                ok: true,
                created: imported.created,
                source: imported.source,
                entry: imported.entry,
                resourceImport: prepared.resourceImport,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to import cloud snapshot:', error);
            const errorKey = asString(error.message).trim();
            const statusCode = errorKey === 'repo_url_or_token_missing'
                ? 400
                : (['cloud_snapshot_not_found', 'cloud_snapshot_meta_not_found'].includes(errorKey) ? 404 : 500);
            return response.status(statusCode).send({ ok: false, error: 'failed_to_import_cloud_snapshot', detail: error.message });
        }
    });

    router.post('/cloud/snapshot/delete', async (request, response) => {
        if (!assertUser(request, response)) {
            return;
        }

        try {
            const scopeId = asString(request.body?.scopeId).trim();
            const snapshotId = asString(request.body?.snapshotId).trim();
            if (!scopeId || !snapshotId) {
                return response.status(400).send({ ok: false, error: 'scopeId_and_snapshotId_are_required' });
            }

            const baseDirectory = getBaseDirectory(request);
            const result = await deleteRemoteCloudSnapshot(baseDirectory, scopeId, snapshotId);
            return response.send({
                ok: true,
                config: getSafeCloudConfig(result.config),
                manifest: result.manifest,
            });
        } catch (error) {
            console.error('[chat-vault] Failed to delete cloud snapshot:', error);
            const errorKey = asString(error.message).trim();
            const statusCode = errorKey === 'repo_url_or_token_missing'
                ? 400
                : (['cloud_snapshot_not_found', 'cloud_snapshot_meta_not_found'].includes(errorKey) ? 404 : 500);
            return response.status(statusCode).send({ ok: false, error: 'failed_to_delete_cloud_snapshot', detail: error.message });
        }
    });
}
