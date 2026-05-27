import crypto from 'node:crypto';

// === Character card definition fingerprint (PNG chara tEXt chunk) ===
// 0.3.0+: hash only the canonical card definition fields (name, description,
// first_mes, ...) instead of the full PNG bytes. This prevents duplicate
// cloud-resource entries when SillyTavern writes runtime data (fav,
// talkativeness, extensions, etc.) back into the PNG, while still
// distinguishing real card updates such as v1.0 -> v2.0.

export const CHARACTER_FINGERPRINT_FIELDS = [
    'name',
    'description',
    'personality',
    'first_mes',
    'scenario',
    'mes_example',
    'system_prompt',
    'post_history_instructions',
    'alternate_greetings',
    'creator',
    'creator_notes',
    'character_version',
    'tags',
];

export const CHARACTER_BOOK_FIELDS = [
    'name',
    'description',
    'scan_depth',
    'token_budget',
    'recursive_scanning',
];

export const CHARACTER_BOOK_ENTRY_FIELDS = [
    'keys',
    'secondary_keys',
    'content',
    'comment',
    'constant',
    'selective',
    'insertion_order',
    'probability',
    'enabled',
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function extractPngCharaChunk(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 12) {
        return null;
    }
    if (buffer.compare(PNG_SIGNATURE, 0, PNG_SIGNATURE.length, 0, PNG_SIGNATURE.length) !== 0) {
        return null;
    }

    let offset = PNG_SIGNATURE.length;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) {
            return null;
        }

        if (type === 'tEXt') {
            const nullIdx = buffer.indexOf(0, dataStart);
            if (nullIdx !== -1 && nullIdx < dataEnd) {
                const keyword = buffer.toString('latin1', dataStart, nullIdx);
                if (keyword === 'chara') {
                    return buffer.toString('latin1', nullIdx + 1, dataEnd);
                }
            }
        }

        if (type === 'IEND') {
            return null;
        }

        offset = dataEnd + 4;
    }
    return null;
}

export function parseCharaJson(base64Text) {
    if (typeof base64Text !== 'string' || base64Text.length === 0) {
        return null;
    }
    try {
        const jsonText = Buffer.from(base64Text, 'base64').toString('utf-8');
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function pickWhitelistKeys(source, keys) {
    const result = {};
    if (!source || typeof source !== 'object') {
        return result;
    }
    for (const key of keys) {
        if (source[key] !== undefined) {
            result[key] = source[key];
        }
    }
    return result;
}

export function normalizeCharacterBookForFingerprint(book) {
    if (!book || typeof book !== 'object') {
        return null;
    }
    const normalized = pickWhitelistKeys(book, CHARACTER_BOOK_FIELDS);
    if (Array.isArray(book.entries)) {
        normalized.entries = book.entries.map((entry) => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            return pickWhitelistKeys(entry, CHARACTER_BOOK_ENTRY_FIELDS);
        });
    }
    return normalized;
}

export function stableStringify(value) {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        const parts = value.map((item) => {
            const serialized = stableStringify(item);
            return serialized === undefined ? 'null' : serialized;
        });
        return '[' + parts.join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
        const serialized = stableStringify(value[key]);
        if (serialized === undefined) {
            continue;
        }
        parts.push(JSON.stringify(key) + ':' + serialized);
    }
    return '{' + parts.join(',') + '}';
}

export function characterDefinitionFingerprint(pngBuffer) {
    const base64Text = extractPngCharaChunk(pngBuffer);
    if (!base64Text) {
        return null;
    }
    const chara = parseCharaJson(base64Text);
    if (!chara) {
        return null;
    }
    const isV2Spec = typeof chara.spec === 'string' && chara.spec.trim() === 'chara_card_v2';
    const data = isV2Spec ? (chara.data && typeof chara.data === 'object' ? chara.data : {}) : chara;
    const fingerprintObject = pickWhitelistKeys(data, CHARACTER_FINGERPRINT_FIELDS);
    if (data.character_book) {
        fingerprintObject.character_book = normalizeCharacterBookForFingerprint(data.character_book);
    }
    return crypto.createHash('sha1').update(stableStringify(fingerprintObject), 'utf-8').digest('hex');
}
