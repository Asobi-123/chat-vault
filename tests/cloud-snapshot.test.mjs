import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
    CLOUD_SNAPSHOT_CHUNK_FORMAT,
    CLOUD_SNAPSHOT_CHUNK_SIZE,
    CLOUD_SNAPSHOT_RAW_THRESHOLD,
    pruneCloudSnapshotChunks,
    readCloudSnapshotStorage,
    writeCloudSnapshotStorage,
} from '../server-plugin/cloud-snapshot.mjs';

const MEBIBYTE = 1024 * 1024;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-vault-cloud-snapshot-'));

function createJsonl(messageCount, messageSize, { incompressible = false } = {}) {
    const lines = [JSON.stringify({ chat_metadata: { title: 'Simulated oversized chat' } })];
    for (let index = 0; index < messageCount; index += 1) {
        const payload = incompressible
            ? crypto.randomBytes(Math.ceil(messageSize * 0.75)).toString('base64').slice(0, messageSize)
            : 'chat-vault-payload-'.repeat(Math.ceil(messageSize / 19)).slice(0, messageSize);
        lines.push(JSON.stringify({
            name: index % 2 === 0 ? 'User' : 'Assistant',
            is_user: index % 2 === 0,
            mes: `${index}:${payload}`,
            send_date: `2026-07-24 @ ${index}`,
        }));
    }
    return lines.join('\n');
}

try {
    const repoPath = path.join(tempRoot, 'repo');
    const snapshotsRoot = path.join(repoPath, 'objects', 'snapshots', 'scope-a');
    const chunksRoot = path.join(repoPath, 'objects', 'snapshot-chunks');
    const smallSnapshotPath = path.join(snapshotsRoot, 'small.jsonl');
    const smallJsonl = createJsonl(2, 1024);

    const smallStorage = writeCloudSnapshotStorage({
        repoPath,
        snapshotPath: smallSnapshotPath,
        snapshotRelativePath: 'objects/snapshots/scope-a/small.jsonl',
        chunksRoot,
        jsonl: smallJsonl,
    });
    assert.equal(smallStorage.format, 'plain-jsonl-v1');
    assert.deepEqual(readCloudSnapshotStorage({
        snapshotPath: smallSnapshotPath,
        chunksRoot,
        storage: smallStorage,
    }), [
        { chat_metadata: { title: 'Simulated oversized chat' } },
        ...Array.from({ length: 2 }, (_, index) => ({
            name: index % 2 === 0 ? 'User' : 'Assistant',
            is_user: index % 2 === 0,
            mes: `${index}:${'chat-vault-payload-'.repeat(Math.ceil(1024 / 19)).slice(0, 1024)}`,
            send_date: `2026-07-24 @ ${index}`,
        })),
    ]);
    assert.equal(readCloudSnapshotStorage({
        snapshotPath: smallSnapshotPath,
        chunksRoot,
        storage: null,
    }).length, 3, 'legacy cloud meta without snapshotStorage stays readable');

    // 105 MiB of JSONL: intentionally beyond GitHub's 100 MiB Git blob cap.
    const oversizedJsonl = createJsonl(105, MEBIBYTE, { incompressible: true });
    assert.ok(Buffer.byteLength(oversizedJsonl, 'utf8') > 100 * MEBIBYTE);
    assert.ok(Buffer.byteLength(oversizedJsonl, 'utf8') > CLOUD_SNAPSHOT_RAW_THRESHOLD);

    const oversizedSnapshotPath = path.join(snapshotsRoot, 'oversized.jsonl');
    const oversizedStorage = writeCloudSnapshotStorage({
        repoPath,
        snapshotPath: oversizedSnapshotPath,
        snapshotRelativePath: 'objects/snapshots/scope-a/oversized.jsonl',
        chunksRoot,
        jsonl: oversizedJsonl,
    });
    assert.equal(oversizedStorage.format, CLOUD_SNAPSHOT_CHUNK_FORMAT);
    assert.ok(oversizedStorage.chunks.length > 1);
    assert.equal(fs.existsSync(oversizedSnapshotPath), false);

    for (const chunk of oversizedStorage.chunks) {
        assert.ok(chunk.rawSize <= CLOUD_SNAPSHOT_CHUNK_SIZE);
        assert.ok(chunk.compressedSize < 9 * MEBIBYTE);
        assert.equal(fs.existsSync(path.join(repoPath, chunk.path)), true);
    }

    const recovered = readCloudSnapshotStorage({
        snapshotPath: oversizedSnapshotPath,
        chunksRoot,
        storage: oversizedStorage,
    });
    assert.equal(recovered.length, 106);
    assert.equal(recovered[0].chat_metadata.title, 'Simulated oversized chat');
    assert.equal(recovered[105].mes.length, MEBIBYTE + 4);

    const duplicateStorage = writeCloudSnapshotStorage({
        repoPath,
        snapshotPath: oversizedSnapshotPath,
        snapshotRelativePath: 'objects/snapshots/scope-a/oversized.jsonl',
        chunksRoot,
        jsonl: oversizedJsonl,
    });
    assert.deepEqual(
        duplicateStorage.chunks.map((chunk) => chunk.hash),
        oversizedStorage.chunks.map((chunk) => chunk.hash),
    );

    const orphanPath = path.join(chunksRoot, `${'f'.repeat(40)}.jsonl.gz`);
    fs.writeFileSync(orphanPath, 'orphan');
    const removed = pruneCloudSnapshotChunks(chunksRoot, new Set(oversizedStorage.chunks.map((chunk) => chunk.hash)));
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(orphanPath), false);

    // This is the same ordinary Git path used by the cloud vault. A 105 MiB
    // logical chat must stage and push as only small physical blobs.
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Chat Vault test'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'chat-vault-test@local'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Simulated oversized cloud snapshot'], { cwd: repoPath, stdio: 'pipe' });
    const tree = execFileSync('git', ['ls-tree', '-r', '-l', 'HEAD'], { cwd: repoPath, encoding: 'utf8' });
    const largestBlob = tree.split('\n').reduce((largest, line) => {
        const [mode, type, hash, size] = line.split(/\s+/);
        const parsedSize = Number(size);
        return mode && type === 'blob' && /^[a-f0-9]+$/.test(hash) && Number.isFinite(parsedSize)
            ? Math.max(largest, parsedSize)
            : largest;
    }, 0);
    assert.ok(largestBlob > 0, 'Git tree includes the cloud snapshot blobs');
    assert.ok(largestBlob < 45 * MEBIBYTE, `largest staged Git blob is ${largestBlob} bytes`);

    const remotePath = path.join(tempRoot, 'remote.git');
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoPath, stdio: 'pipe' });

    console.log(`cloud-snapshot.test.mjs: passed (simulated ${Math.round(Buffer.byteLength(oversizedJsonl, 'utf8') / MEBIBYTE)} MiB chat; largest Git blob ${(largestBlob / MEBIBYTE).toFixed(2)} MiB)`);
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
