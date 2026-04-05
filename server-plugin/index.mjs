import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
const DEFAULT_MAX_AUTO_SNAPSHOTS = 1;
const DEFAULT_PREVIEW_MESSAGES = 12;
const MAX_REQUEST_SIZE = '64mb';

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

function getScopePaths(request, source) {
    const baseDirectory = getBaseDirectory(request);
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
}
