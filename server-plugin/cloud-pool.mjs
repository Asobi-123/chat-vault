import crypto from 'node:crypto';

export const CLOUD_POOL_CONFIG_VERSION = 2;
export const CLOUD_POOL_DESCRIPTOR_VERSION = 1;

function asString(value) {
    return value === undefined || value === null ? '' : String(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeTimestamp(value, fallback = 0) {
    return Math.max(0, Math.trunc(asFiniteNumber(value, fallback)));
}

function isIdentifier(value, prefix) {
    return new RegExp(`^${prefix}-[a-zA-Z0-9_-]{6,128}$`).test(asString(value).trim());
}

function createIdentifier(prefix) {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function createCloudPoolId() {
    return createIdentifier('pool');
}

export function createCloudRepositoryId() {
    return createIdentifier('repo');
}

function createCloudDeviceId() {
    return createIdentifier('device');
}

function normalizeRepository(rawRepository, {
    defaultBranch,
    createRepositoryId = createCloudRepositoryId,
    now = Date.now(),
} = {}) {
    const raw = asObject(rawRepository);
    return {
        repositoryId: isIdentifier(raw.repositoryId, 'repo')
            ? asString(raw.repositoryId).trim()
            : createRepositoryId(),
        repoUrl: asString(raw.repoUrl).trim(),
        branch: asString(raw.branch).trim() || defaultBranch,
        githubTokenOverride: asString(raw.githubTokenOverride ?? raw.githubToken).trim(),
        addedAt: normalizeTimestamp(raw.addedAt, now),
        lastPulledAt: normalizeTimestamp(raw.lastPulledAt),
        lastPushedAt: normalizeTimestamp(raw.lastPushedAt),
    };
}

export function buildEmptyCloudPoolConfig({
    defaultBranch = 'main',
    createPoolId = createCloudPoolId,
    createDevice = createCloudDeviceId,
} = {}) {
    return {
        version: CLOUD_POOL_CONFIG_VERSION,
        poolId: createPoolId(),
        catalogRepositoryId: '',
        defaultGithubToken: '',
        deviceId: createDevice(),
        deviceName: '',
        syncPinned: true,
        syncLatestStable: true,
        syncDrafts: false,
        repositories: [],
    };
}

export function normalizeCloudPoolConfig(rawConfig, {
    defaultBranch = 'main',
    createPoolId = createCloudPoolId,
    createRepositoryId = createCloudRepositoryId,
    createDevice = createCloudDeviceId,
    now = Date.now(),
} = {}) {
    const raw = asObject(rawConfig);
    const hasPoolRepositories = Array.isArray(raw.repositories);
    const sourceRepositories = hasPoolRepositories
        ? raw.repositories
        : (asString(raw.repoUrl).trim() ? [{
            repositoryId: raw.repositoryId,
            repoUrl: raw.repoUrl,
            branch: raw.branch,
            githubTokenOverride: '',
            addedAt: raw.addedAt,
            lastPulledAt: raw.lastPulledAt,
            lastPushedAt: raw.lastPushedAt,
        }] : []);
    const usedIds = new Set();
    const repositories = sourceRepositories
        .map((repository) => normalizeRepository(repository, {
            defaultBranch,
            createRepositoryId,
            now,
        }))
        .filter((repository) => Boolean(repository.repoUrl))
        .map((repository) => {
            if (!usedIds.has(repository.repositoryId)) {
                usedIds.add(repository.repositoryId);
                return repository;
            }

            let nextId = createRepositoryId();
            while (usedIds.has(nextId)) {
                nextId = createRepositoryId();
            }
            usedIds.add(nextId);
            return {
                ...repository,
                repositoryId: nextId,
            };
        });
    const requestedCatalogId = asString(raw.catalogRepositoryId).trim();
    const catalogRepositoryId = repositories.some((repository) => repository.repositoryId === requestedCatalogId)
        ? requestedCatalogId
        : (repositories[0]?.repositoryId || '');
    const poolId = isIdentifier(raw.poolId, 'pool')
        ? asString(raw.poolId).trim()
        : createPoolId();

    return {
        version: CLOUD_POOL_CONFIG_VERSION,
        poolId,
        catalogRepositoryId,
        defaultGithubToken: hasPoolRepositories
            ? asString(raw.defaultGithubToken ?? raw.githubToken).trim()
            : asString(raw.githubToken).trim(),
        deviceId: isIdentifier(raw.deviceId, 'device')
            ? asString(raw.deviceId).trim()
            : createDevice(),
        deviceName: asString(raw.deviceName).trim(),
        syncPinned: raw.syncPinned === undefined ? true : Boolean(raw.syncPinned),
        syncLatestStable: raw.syncLatestStable === undefined ? true : Boolean(raw.syncLatestStable),
        syncDrafts: Boolean(raw.syncDrafts),
        repositories,
    };
}

export function getCloudPoolRepository(config, repositoryId) {
    const normalized = normalizeCloudPoolConfig(config);
    const targetId = asString(repositoryId).trim();
    return normalized.repositories.find((repository) => repository.repositoryId === targetId) || null;
}

export function getCloudPoolRepositoryToken(config, repositoryId) {
    const normalized = normalizeCloudPoolConfig(config);
    const repository = normalized.repositories.find((item) => item.repositoryId === asString(repositoryId).trim());
    if (!repository) {
        return '';
    }
    return repository.githubTokenOverride || normalized.defaultGithubToken;
}

export function getSafeCloudPoolConfig(rawConfig) {
    const config = normalizeCloudPoolConfig(rawConfig);
    return {
        ...config,
        defaultGithubToken: '',
        hasDefaultToken: Boolean(config.defaultGithubToken),
        repositories: config.repositories.map((repository) => ({
            ...repository,
            githubTokenOverride: '',
            hasToken: Boolean(repository.githubTokenOverride || config.defaultGithubToken),
            hasTokenOverride: Boolean(repository.githubTokenOverride),
        })),
    };
}

function normalizePoolMember(rawMember, defaultBranch = 'main') {
    const member = asObject(rawMember);
    const repositoryId = asString(member.repositoryId).trim();
    if (!isIdentifier(repositoryId, 'repo')) {
        return null;
    }
    const repoUrl = asString(member.repoUrl).trim();
    if (!repoUrl) {
        return null;
    }
    return {
        repositoryId,
        repoUrl,
        branch: asString(member.branch).trim() || defaultBranch,
        addedAt: normalizeTimestamp(member.addedAt),
    };
}

function normalizeScopeHome(rawHome) {
    const home = asObject(rawHome);
    const repositoryId = asString(home.repositoryId).trim();
    if (!isIdentifier(repositoryId, 'repo')) {
        return null;
    }
    return {
        repositoryId,
        assignedAt: normalizeTimestamp(home.assignedAt),
        assignedLogicalBytes: normalizeTimestamp(home.assignedLogicalBytes),
    };
}

export function buildEmptyCloudPoolDescriptor(config, { now = Date.now() } = {}) {
    const normalized = normalizeCloudPoolConfig(config);
    return {
        version: CLOUD_POOL_DESCRIPTOR_VERSION,
        poolId: normalized.poolId,
        catalogRepositoryId: normalized.catalogRepositoryId,
        members: normalized.repositories.map((repository) => ({
            repositoryId: repository.repositoryId,
            repoUrl: repository.repoUrl,
            branch: repository.branch,
            addedAt: repository.addedAt,
        })),
        scopeHomes: {},
        createdAt: now,
        updatedAt: now,
    };
}

export function normalizeCloudPoolDescriptor(rawDescriptor, {
    defaultBranch = 'main',
    now = Date.now(),
} = {}) {
    const raw = asObject(rawDescriptor);
    const memberIds = new Set();
    const members = asArray(raw.members)
        .map((member) => normalizePoolMember(member, defaultBranch))
        .filter(Boolean)
        .filter((member) => {
            if (memberIds.has(member.repositoryId)) {
                return false;
            }
            memberIds.add(member.repositoryId);
            return true;
        });
    const catalogRepositoryId = asString(raw.catalogRepositoryId).trim();
    const scopeHomes = {};
    for (const [scopeId, home] of Object.entries(asObject(raw.scopeHomes))) {
        const normalizedHome = normalizeScopeHome(home);
        if (asString(scopeId).trim() && normalizedHome && memberIds.has(normalizedHome.repositoryId)) {
            scopeHomes[asString(scopeId).trim()] = normalizedHome;
        }
    }
    return {
        version: CLOUD_POOL_DESCRIPTOR_VERSION,
        poolId: isIdentifier(raw.poolId, 'pool') ? asString(raw.poolId).trim() : '',
        catalogRepositoryId: memberIds.has(catalogRepositoryId) ? catalogRepositoryId : '',
        members,
        scopeHomes,
        createdAt: normalizeTimestamp(raw.createdAt, now),
        updatedAt: normalizeTimestamp(raw.updatedAt, now),
    };
}

export function buildCloudPoolDescriptor(config, existingDescriptor = null, {
    scopeHomes = null,
    now = Date.now(),
} = {}) {
    const normalizedConfig = normalizeCloudPoolConfig(config);
    const previous = normalizeCloudPoolDescriptor(existingDescriptor, { now });
    const nextHomes = scopeHomes === null ? previous.scopeHomes : scopeHomes;
    const descriptor = {
        version: CLOUD_POOL_DESCRIPTOR_VERSION,
        poolId: normalizedConfig.poolId,
        catalogRepositoryId: normalizedConfig.catalogRepositoryId,
        members: normalizedConfig.repositories.map((repository) => ({
            repositoryId: repository.repositoryId,
            repoUrl: repository.repoUrl,
            branch: repository.branch,
            addedAt: repository.addedAt,
        })),
        scopeHomes: Object.fromEntries(Object.entries(asObject(nextHomes))
            .map(([scopeId, home]) => [asString(scopeId).trim(), normalizeScopeHome(home)])
            .filter(([scopeId, home]) => scopeId && home)),
        createdAt: previous.createdAt || now,
        updatedAt: now,
    };
    return normalizeCloudPoolDescriptor(descriptor, { now });
}

export function validateCloudPoolDescriptor(rawDescriptor, rawConfig) {
    const descriptor = normalizeCloudPoolDescriptor(rawDescriptor);
    const config = normalizeCloudPoolConfig(rawConfig);
    if (!descriptor.poolId || descriptor.poolId !== config.poolId) {
        return { ok: false, error: 'cloud_pool_id_mismatch', descriptor };
    }
    if (!descriptor.catalogRepositoryId || descriptor.catalogRepositoryId !== config.catalogRepositoryId) {
        return { ok: false, error: 'cloud_pool_catalog_mismatch', descriptor };
    }
    const configMembers = new Map(config.repositories.map((repository) => [repository.repositoryId, repository]));
    if (descriptor.members.length !== configMembers.size) {
        return { ok: false, error: 'cloud_pool_member_count_mismatch', descriptor };
    }
    for (const member of descriptor.members) {
        const configured = configMembers.get(member.repositoryId);
        if (!configured || configured.repoUrl !== member.repoUrl || configured.branch !== member.branch) {
            return { ok: false, error: 'cloud_pool_member_mismatch', descriptor };
        }
    }
    return { ok: true, descriptor };
}

export function adoptCloudPoolDescriptor(rawConfig, rawDescriptor, options = {}) {
    const config = normalizeCloudPoolConfig(rawConfig, options);
    const descriptor = normalizeCloudPoolDescriptor(rawDescriptor, options);
    if (!descriptor.poolId || !descriptor.catalogRepositoryId || descriptor.members.length === 0) {
        return config;
    }
    const configuredByLocation = new Map(config.repositories.map((repository) => [
        `${repository.repoUrl}|${repository.branch}`,
        repository,
    ]));
    const adopted = {
        ...config,
        version: CLOUD_POOL_CONFIG_VERSION,
        poolId: descriptor.poolId,
        catalogRepositoryId: descriptor.catalogRepositoryId,
        repositories: descriptor.members.map((member) => {
            const existing = configuredByLocation.get(`${member.repoUrl}|${member.branch}`);
            return {
                repositoryId: member.repositoryId,
                repoUrl: member.repoUrl,
                branch: member.branch,
                githubTokenOverride: existing?.githubTokenOverride || '',
                addedAt: member.addedAt,
                lastPulledAt: existing?.lastPulledAt || 0,
                lastPushedAt: existing?.lastPushedAt || 0,
            };
        }),
    };
    return normalizeCloudPoolConfig(adopted, options);
}

export function getCloudEntryLogicalBytes(rawEntry) {
    const entry = asObject(rawEntry);
    const explicitBytes = normalizeTimestamp(entry.logicalBytes);
    if (explicitBytes > 0) {
        return explicitBytes;
    }
    const storageBytes = normalizeTimestamp(asObject(entry.snapshotStorage).rawSize);
    if (storageBytes > 0) {
        return storageBytes;
    }
    return normalizeTimestamp(entry.snapshotSize);
}

export function getCloudScopeLogicalBytes(rawScope) {
    return asArray(asObject(rawScope).entries)
        .reduce((sum, entry) => sum + getCloudEntryLogicalBytes(entry), 0);
}

export function getCloudManifestLogicalBytes(rawManifest) {
    return asArray(asObject(rawManifest).scopes)
        .reduce((sum, scope) => sum + getCloudScopeLogicalBytes(scope), 0);
}

export function backfillCatalogScopeHomes(rawDescriptor, rawManifest, catalogRepositoryId, {
    now = Date.now(),
} = {}) {
    const descriptor = normalizeCloudPoolDescriptor(rawDescriptor, { now });
    const catalogId = asString(catalogRepositoryId).trim() || descriptor.catalogRepositoryId;
    if (!descriptor.members.some((member) => member.repositoryId === catalogId)) {
        return descriptor;
    }
    const scopeHomes = { ...descriptor.scopeHomes };
    for (const scope of asArray(asObject(rawManifest).scopes)) {
        const scopeId = asString(asObject(scope).scopeId).trim();
        if (!scopeId || scopeHomes[scopeId]) {
            continue;
        }
        scopeHomes[scopeId] = {
            repositoryId: catalogId,
            assignedAt: now,
            assignedLogicalBytes: getCloudScopeLogicalBytes(scope),
        };
    }
    return normalizeCloudPoolDescriptor({
        ...descriptor,
        scopeHomes,
        updatedAt: now,
    }, { now });
}

function getMemberManifest(memberManifests, repositoryId) {
    if (memberManifests instanceof Map) {
        return memberManifests.get(repositoryId)?.manifest || memberManifests.get(repositoryId) || null;
    }
    return asArray(memberManifests).find((item) => asString(item?.repositoryId).trim() === repositoryId)?.manifest || null;
}

export function assignCloudPoolScopes(rawDescriptor, candidates, memberManifests, {
    now = Date.now(),
    availableRepositoryIds = null,
} = {}) {
    const descriptor = normalizeCloudPoolDescriptor(rawDescriptor, { now });
    const availableIds = availableRepositoryIds === null
        ? null
        : new Set(asArray(availableRepositoryIds).map((item) => asString(item).trim()).filter(Boolean));
    const loads = new Map(descriptor.members.map((member) => [
        member.repositoryId,
        getCloudManifestLogicalBytes(getMemberManifest(memberManifests, member.repositoryId)),
    ]));
    const scopeHomes = { ...descriptor.scopeHomes };
    const assignments = new Map();
    const newlyAssignedScopeIds = [];
    const normalizedCandidates = asArray(candidates)
        .map((candidate) => ({
            scopeId: asString(asObject(candidate).scopeId).trim(),
            logicalBytes: normalizeTimestamp(asObject(candidate).logicalBytes),
        }))
        .filter((candidate) => candidate.scopeId)
        .sort((left, right) => left.scopeId.localeCompare(right.scopeId));

    for (const candidate of normalizedCandidates) {
        const existingHome = normalizeScopeHome(scopeHomes[candidate.scopeId]);
        if (existingHome && loads.has(existingHome.repositoryId)) {
            assignments.set(candidate.scopeId, existingHome.repositoryId);
            continue;
        }
        const target = descriptor.members
            .filter((member) => availableIds === null || availableIds.has(member.repositoryId))
            .slice()
            .sort((left, right) => {
                const loadDelta = (loads.get(left.repositoryId) || 0) - (loads.get(right.repositoryId) || 0);
                return loadDelta || left.repositoryId.localeCompare(right.repositoryId);
            })[0];
        if (!target) {
            continue;
        }
        scopeHomes[candidate.scopeId] = {
            repositoryId: target.repositoryId,
            assignedAt: now,
            assignedLogicalBytes: candidate.logicalBytes,
        };
        assignments.set(candidate.scopeId, target.repositoryId);
        loads.set(target.repositoryId, (loads.get(target.repositoryId) || 0) + candidate.logicalBytes);
        newlyAssignedScopeIds.push(candidate.scopeId);
    }

    return {
        descriptor: normalizeCloudPoolDescriptor({
            ...descriptor,
            scopeHomes,
            updatedAt: now,
        }, { now }),
        assignments,
        newlyAssignedScopeIds,
        loads,
    };
}

export function getCloudPoolRepositoryDisplayName(rawRepository) {
    const repository = asObject(rawRepository);
    const repoUrl = asString(repository.repoUrl).trim();
    const matched = /(?:github\.com[/:])([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(repoUrl);
    if (matched) {
        return `${matched[1]}/${matched[2]}`;
    }
    return repoUrl || asString(repository.repositoryId).trim() || 'Repository';
}

function normalizeMemberStatus(rawMember) {
    const member = asObject(rawMember);
    return {
        repositoryId: asString(member.repositoryId).trim(),
        repositoryName: asString(member.repositoryName).trim(),
        status: asString(member.status).trim() || 'ready',
        stale: Boolean(member.stale),
        error: asString(member.error).trim(),
        manifest: asObject(member.manifest),
    };
}

export function buildAggregateCloudManifest(rawMembers) {
    const members = asArray(rawMembers)
        .map(normalizeMemberStatus)
        .filter((member) => member.repositoryId);
    const scopeMap = new Map();
    const deviceMap = new Map();
    let snapshotCount = 0;
    let logicalBytes = 0;

    for (const member of members) {
        const manifest = member.manifest;
        for (const scope of asArray(manifest.scopes)) {
            const normalizedScope = asObject(scope);
            const scopeId = asString(normalizedScope.scopeId).trim();
            if (!scopeId) {
                continue;
            }
            const scopeRecord = scopeMap.get(scopeId) || {
                scopeId,
                label: asString(normalizedScope.label).trim(),
                source: asObject(normalizedScope.source),
                entries: [],
                devices: new Map(),
                repositoryIds: new Set(),
            };
            scopeRecord.repositoryIds.add(member.repositoryId);
            for (const device of asArray(normalizedScope.devices)) {
                const deviceId = asString(asObject(device).deviceId).trim();
                if (!deviceId) {
                    continue;
                }
                const deviceName = asString(asObject(device).deviceName).trim() || deviceId;
                scopeRecord.devices.set(deviceId, deviceName);
                deviceMap.set(deviceId, deviceName);
            }
            for (const entry of asArray(normalizedScope.entries)) {
                const normalizedEntry = asObject(entry);
                const snapshotId = asString(normalizedEntry.snapshotId).trim();
                if (!snapshotId) {
                    continue;
                }
                const entryLogicalBytes = getCloudEntryLogicalBytes(normalizedEntry);
                scopeRecord.entries.push({
                    ...normalizedEntry,
                    repositoryId: member.repositoryId,
                    repositoryName: member.repositoryName || member.repositoryId,
                    repositoryStatus: member.status,
                    repositoryStale: member.stale,
                    logicalBytes: entryLogicalBytes,
                });
                snapshotCount += 1;
                logicalBytes += entryLogicalBytes;
            }
            scopeMap.set(scopeId, scopeRecord);
        }
    }

    const scopes = Array.from(scopeMap.values()).map((scopeRecord) => {
        const entries = scopeRecord.entries.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
        return {
            scopeId: scopeRecord.scopeId,
            label: scopeRecord.label,
            source: scopeRecord.source,
            updatedAt: entries[0]?.createdAt || 0,
            entryCount: entries.length,
            deviceCount: scopeRecord.devices.size,
            devices: Array.from(scopeRecord.devices, ([deviceId, deviceName]) => ({ deviceId, deviceName })),
            repositoryCount: scopeRecord.repositoryIds.size,
            repositoryIds: Array.from(scopeRecord.repositoryIds),
            logicalBytes: entries.reduce((sum, entry) => sum + getCloudEntryLogicalBytes(entry), 0),
            latestEntry: entries[0] || null,
            entries,
        };
    }).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

    return {
        version: 1,
        updatedAt: Math.max(0, ...members.map((member) => normalizeTimestamp(member.manifest.updatedAt))),
        scopeCount: scopes.length,
        snapshotCount,
        deviceCount: deviceMap.size,
        logicalBytes,
        memberCount: members.length,
        availableMemberCount: members.filter((member) => member.status === 'ready').length,
        failedMemberCount: members.filter((member) => member.status !== 'ready').length,
        members: members.map(({ manifest, ...member }) => ({
            ...member,
            scopeCount: normalizeTimestamp(manifest.scopeCount),
            snapshotCount: normalizeTimestamp(manifest.snapshotCount),
            logicalBytes: getCloudManifestLogicalBytes(manifest),
        })),
        scopes,
    };
}
