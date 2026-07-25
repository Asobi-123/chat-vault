import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    adoptCloudPoolDescriptor,
    assignCloudPoolScopes,
    backfillCatalogScopeHomes,
    buildAggregateCloudManifest,
    buildCloudPoolDescriptor,
    getSafeCloudPoolConfig,
    normalizeCloudPoolConfig,
    validateCloudPoolDescriptor,
} from '../server-plugin/cloud-pool.mjs';

const ids = {
    pool: 'pool-12345678',
    catalog: 'repo-catalog1',
    second: 'repo-second11',
    device: 'device-local001',
};

let repositoryCount = 0;
const normalizeOptions = {
    now: 100,
    createPoolId: () => ids.pool,
    createDevice: () => ids.device,
    createRepositoryId: () => {
        repositoryCount += 1;
        return repositoryCount === 1 ? ids.catalog : ids.second;
    },
};

const migrated = normalizeCloudPoolConfig({
    version: 1,
    repoUrl: 'https://github.com/example/vault-a.git',
    branch: 'main',
    githubToken: 'legacy-token',
    deviceId: ids.device,
    deviceName: 'Test device',
    syncPinned: true,
    syncLatestStable: false,
}, normalizeOptions);

assert.equal(migrated.version, 2);
assert.equal(migrated.repositories.length, 1);
assert.equal(migrated.catalogRepositoryId, ids.catalog);
assert.equal(migrated.defaultGithubToken, 'legacy-token');
assert.equal(migrated.repositories[0].githubTokenOverride, '');
assert.equal(migrated.syncLatestStable, false);

const safe = getSafeCloudPoolConfig(migrated);
assert.equal(safe.defaultGithubToken, '');
assert.equal(safe.hasDefaultToken, true);
assert.equal(safe.repositories[0].githubTokenOverride, '');
assert.equal(safe.repositories[0].hasToken, true);
assert.equal(JSON.stringify(safe).includes('legacy-token'), false);

const poolConfig = normalizeCloudPoolConfig({
    ...migrated,
    repositories: [
        migrated.repositories[0],
        {
            repositoryId: ids.second,
            repoUrl: 'https://github.com/example/vault-b.git',
            branch: 'main',
            addedAt: 200,
        },
    ],
}, normalizeOptions);
const descriptor = buildCloudPoolDescriptor(poolConfig, null, { now: 300 });
assert.equal(validateCloudPoolDescriptor(descriptor, poolConfig).ok, true);
assert.equal(JSON.stringify(descriptor).includes('legacy-token'), false);

const discovered = adoptCloudPoolDescriptor({
    repoUrl: 'https://github.com/example/vault-a.git',
    branch: 'main',
    githubToken: 'local-token-only',
    deviceId: ids.device,
}, descriptor, normalizeOptions);
assert.equal(discovered.poolId, ids.pool);
assert.equal(discovered.repositories.length, 2);
assert.equal(discovered.catalogRepositoryId, ids.catalog);
assert.equal(discovered.defaultGithubToken, 'local-token-only');
assert.equal(discovered.repositories.find((repository) => repository.repositoryId === ids.second).githubTokenOverride, '');

const catalogManifest = {
    updatedAt: 400,
    scopeCount: 1,
    snapshotCount: 1,
    scopes: [{
        scopeId: 'scope-old',
        label: 'Old chat',
        source: { scopeKey: 'scope-old' },
        entries: [{ snapshotId: 'old-snapshot', createdAt: 300, logicalBytes: 1000 }],
    }],
};
const backfilled = backfillCatalogScopeHomes(descriptor, catalogManifest, ids.catalog, { now: 500 });
assert.equal(backfilled.scopeHomes['scope-old'].repositoryId, ids.catalog);

const assigned = assignCloudPoolScopes(backfilled, [
    { scopeId: 'scope-old', logicalBytes: 1000 },
    { scopeId: 'scope-new-a', logicalBytes: 600 },
    { scopeId: 'scope-new-b', logicalBytes: 700 },
], [
    { repositoryId: ids.catalog, manifest: catalogManifest },
    { repositoryId: ids.second, manifest: { scopes: [] } },
], { now: 600 });

assert.equal(assigned.assignments.get('scope-old'), ids.catalog);
assert.equal(assigned.assignments.get('scope-new-a'), ids.second);
assert.equal(assigned.assignments.get('scope-new-b'), ids.second);
assert.deepEqual(assigned.newlyAssignedScopeIds, ['scope-new-a', 'scope-new-b']);

const stable = assignCloudPoolScopes(assigned.descriptor, [
    { scopeId: 'scope-new-a', logicalBytes: 999999 },
], [
    { repositoryId: ids.catalog, manifest: catalogManifest },
    { repositoryId: ids.second, manifest: { scopes: [] } },
], { now: 700 });
assert.equal(stable.assignments.get('scope-new-a'), ids.second);

const unavailableSecond = assignCloudPoolScopes(backfilled, [
    { scopeId: 'scope-new-c', logicalBytes: 50 },
], [
    { repositoryId: ids.catalog, manifest: catalogManifest },
    { repositoryId: ids.second, manifest: { scopes: [] } },
], { now: 750, availableRepositoryIds: [ids.catalog] });
assert.equal(unavailableSecond.assignments.get('scope-new-c'), ids.catalog);

const aggregate = buildAggregateCloudManifest([
    {
        repositoryId: ids.catalog,
        repositoryName: 'example/vault-a',
        status: 'ready',
        manifest: catalogManifest,
    },
    {
        repositoryId: ids.second,
        repositoryName: 'example/vault-b',
        status: 'failed',
        stale: true,
        error: 'network unavailable',
        manifest: {
            updatedAt: 450,
            scopeCount: 1,
            snapshotCount: 1,
            scopes: [{
                scopeId: 'scope-new-a',
                label: 'New chat',
                source: { scopeKey: 'scope-new-a' },
                entries: [{
                    snapshotId: 'new-snapshot',
                    createdAt: 450,
                    snapshotStorage: { rawSize: 600 },
                }],
            }],
        },
    },
]);

assert.equal(aggregate.scopeCount, 2);
assert.equal(aggregate.snapshotCount, 2);
assert.equal(aggregate.failedMemberCount, 1);
assert.equal(aggregate.logicalBytes, 1600);
assert.equal(aggregate.scopes.find((scope) => scope.scopeId === 'scope-new-a').entries[0].repositoryId, ids.second);
assert.equal(aggregate.scopes.find((scope) => scope.scopeId === 'scope-new-a').entries[0].repositoryStale, true);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-vault-cloud-pool-'));
try {
    const catalogRemote = path.join(tempRoot, 'catalog.git');
    const secondRemote = path.join(tempRoot, 'second.git');
    const missingRemote = path.join(tempRoot, 'missing.git');
    execFileSync('git', ['init', '--bare', catalogRemote], { stdio: 'pipe' });
    execFileSync('git', ['init', '--bare', secondRemote], { stdio: 'pipe' });

    const poolDescriptor = {
        ...assigned.descriptor,
        scopeHomes: {
            'scope-old': { repositoryId: ids.catalog, assignedAt: 500, assignedLogicalBytes: 1000 },
            'scope-new-a': { repositoryId: ids.second, assignedAt: 600, assignedLogicalBytes: 600 },
        },
    };
    const publish = (remotePath, repositoryId, scopeId) => {
        const workspace = path.join(tempRoot, repositoryId);
        fs.mkdirSync(workspace, { recursive: true });
        execFileSync('git', ['init', '--initial-branch=main'], { cwd: workspace, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Chat Vault test'], { cwd: workspace, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'chat-vault-test@local'], { cwd: workspace, stdio: 'pipe' });
        execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: workspace, stdio: 'pipe' });
        fs.writeFileSync(path.join(workspace, 'vault-pool.json'), JSON.stringify(poolDescriptor, null, 2));
        const objectPath = path.join(workspace, 'objects', 'meta', scopeId, 'snapshot.json');
        fs.mkdirSync(path.dirname(objectPath), { recursive: true });
        fs.writeFileSync(objectPath, JSON.stringify({ scopeId, repositoryId }));
        execFileSync('git', ['add', '-A'], { cwd: workspace, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', `Publish ${scopeId}`], { cwd: workspace, stdio: 'pipe' });
        execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: workspace, stdio: 'pipe' });
        return workspace;
    };

    publish(catalogRemote, ids.catalog, 'scope-old');
    publish(secondRemote, ids.second, 'scope-new-a');
    const catalogInspect = path.join(tempRoot, 'catalog-inspect');
    const secondInspect = path.join(tempRoot, 'second-inspect');
    execFileSync('git', ['clone', '--branch', 'main', catalogRemote, catalogInspect], { stdio: 'pipe' });
    execFileSync('git', ['clone', '--branch', 'main', secondRemote, secondInspect], { stdio: 'pipe' });
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(catalogInspect, 'vault-pool.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(secondInspect, 'vault-pool.json'), 'utf8')),
    );
    assert.equal(fs.existsSync(path.join(catalogInspect, 'objects', 'meta', 'scope-old', 'snapshot.json')), true);
    assert.equal(fs.existsSync(path.join(catalogInspect, 'objects', 'meta', 'scope-new-a', 'snapshot.json')), false);
    assert.equal(fs.existsSync(path.join(secondInspect, 'objects', 'meta', 'scope-new-a', 'snapshot.json')), true);
    assert.equal(fs.existsSync(path.join(secondInspect, 'objects', 'meta', 'scope-old', 'snapshot.json')), false);

    const failedWorkspace = path.join(tempRoot, 'failed-member');
    fs.mkdirSync(failedWorkspace, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: failedWorkspace, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Chat Vault test'], { cwd: failedWorkspace, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'chat-vault-test@local'], { cwd: failedWorkspace, stdio: 'pipe' });
    fs.writeFileSync(path.join(failedWorkspace, 'vault-pool.json'), JSON.stringify(poolDescriptor));
    execFileSync('git', ['add', '-A'], { cwd: failedWorkspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Prepare failed member'], { cwd: failedWorkspace, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', missingRemote], { cwd: failedWorkspace, stdio: 'pipe' });
    assert.throws(() => execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: failedWorkspace, stdio: 'pipe' }));
    assert.equal(fs.existsSync(path.join(catalogInspect, 'objects', 'meta', 'scope-old', 'snapshot.json')), true);
    assert.equal(fs.existsSync(path.join(secondInspect, 'objects', 'meta', 'scope-new-a', 'snapshot.json')), true);
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('cloud-pool.test.mjs: passed');
