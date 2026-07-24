import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const CLOUD_SNAPSHOT_RAW_THRESHOLD = 40 * 1024 * 1024;
export const CLOUD_SNAPSHOT_CHUNK_SIZE = 8 * 1024 * 1024;
export const CLOUD_SNAPSHOT_CHUNK_FORMAT = 'chunked-gzip-v1';

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

function sha1Buffer(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

function toRepoRelative(repoPath, filePath) {
    return path.relative(repoPath, filePath).replace(/\\/g, '/');
}

function parseSnapshotJsonl(rawText, sourcePath = 'snapshot') {
    const lines = rawText.split('\n').filter((line) => line.trim().length > 0);
    const snapshot = [];

    for (let index = 0; index < lines.length; index += 1) {
        try {
            snapshot.push(JSON.parse(lines[index]));
        } catch (error) {
            throw new Error(`Invalid snapshot JSONL at ${sourcePath}, line ${index + 1}: ${error.message}`);
        }
    }

    return snapshot;
}

export function readSnapshotFile(snapshotPath) {
    if (!fs.existsSync(snapshotPath)) {
        throw new Error(`Snapshot file not found: ${snapshotPath}`);
    }

    return parseSnapshotJsonl(fs.readFileSync(snapshotPath, 'utf8'), snapshotPath);
}

export function writeCloudSnapshotStorage({
    repoPath,
    snapshotPath,
    snapshotRelativePath,
    chunksRoot,
    jsonl,
}) {
    const rawBuffer = Buffer.from(jsonl, 'utf8');
    if (rawBuffer.length <= CLOUD_SNAPSHOT_RAW_THRESHOLD) {
        writeTextAtomic(snapshotPath, jsonl);
        return {
            format: 'plain-jsonl-v1',
            path: snapshotRelativePath,
            rawSize: rawBuffer.length,
        };
    }

    ensureDirectory(chunksRoot);
    const chunks = [];
    for (let offset = 0; offset < rawBuffer.length; offset += CLOUD_SNAPSHOT_CHUNK_SIZE) {
        const rawChunk = rawBuffer.subarray(offset, Math.min(offset + CLOUD_SNAPSHOT_CHUNK_SIZE, rawBuffer.length));
        const hash = sha1Buffer(rawChunk);
        const compressed = gzipSync(rawChunk, { level: 6 });
        const chunkPath = path.join(chunksRoot, `${hash}.jsonl.gz`);
        if (!fs.existsSync(chunkPath)) {
            writeBufferAtomic(chunkPath, compressed);
        }
        chunks.push({
            hash,
            rawSize: rawChunk.length,
            compressedSize: compressed.length,
            path: toRepoRelative(repoPath, chunkPath),
        });
    }

    if (fs.existsSync(snapshotPath)) {
        fs.rmSync(snapshotPath, { force: true });
    }

    return {
        format: CLOUD_SNAPSHOT_CHUNK_FORMAT,
        rawSize: rawBuffer.length,
        chunkSize: CLOUD_SNAPSHOT_CHUNK_SIZE,
        chunks,
    };
}

function assertSafeChunkHash(value) {
    const hash = String(value || '').trim();
    if (!/^[a-f0-9]{40}$/.test(hash)) {
        throw new Error(`Invalid cloud snapshot chunk hash: ${hash || '(empty)'}`);
    }
    return hash;
}

export function readCloudSnapshotStorage({
    snapshotPath,
    chunksRoot,
    storage,
}) {
    const normalizedStorage = storage && typeof storage === 'object' ? storage : null;
    if (!normalizedStorage || !normalizedStorage.format || normalizedStorage.format === 'plain-jsonl-v1') {
        return readSnapshotFile(snapshotPath);
    }

    if (normalizedStorage.format !== CLOUD_SNAPSHOT_CHUNK_FORMAT) {
        throw new Error(`Unsupported cloud snapshot format: ${normalizedStorage.format}`);
    }

    const chunks = Array.isArray(normalizedStorage.chunks) ? normalizedStorage.chunks : [];
    if (chunks.length === 0) {
        throw new Error('Cloud snapshot has no chunks');
    }

    const rawChunks = chunks.map((chunk) => {
        const hash = assertSafeChunkHash(chunk?.hash);
        const chunkPath = path.join(chunksRoot, `${hash}.jsonl.gz`);
        if (!fs.existsSync(chunkPath)) {
            throw new Error(`Cloud snapshot chunk not found: ${hash}`);
        }

        const rawChunk = gunzipSync(fs.readFileSync(chunkPath));
        if (sha1Buffer(rawChunk) !== hash) {
            throw new Error(`Cloud snapshot chunk hash mismatch: ${hash}`);
        }
        if (Number.isFinite(Number(chunk?.rawSize)) && rawChunk.length !== Number(chunk.rawSize)) {
            throw new Error(`Cloud snapshot chunk size mismatch: ${hash}`);
        }
        return rawChunk;
    });

    const rawText = Buffer.concat(rawChunks).toString('utf8');
    return parseSnapshotJsonl(rawText, 'cloud snapshot chunks');
}

export function pruneCloudSnapshotChunks(chunksRoot, referencedHashes) {
    if (!fs.existsSync(chunksRoot)) {
        return 0;
    }

    const referenced = referencedHashes instanceof Set ? referencedHashes : new Set();
    let removed = 0;
    for (const fileName of fs.readdirSync(chunksRoot)) {
        const match = /^([a-f0-9]{40})\.jsonl\.gz$/.exec(fileName);
        if (!match || referenced.has(match[1])) {
            continue;
        }
        fs.rmSync(path.join(chunksRoot, fileName), { force: true });
        removed += 1;
    }
    return removed;
}
