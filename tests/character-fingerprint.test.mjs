import {
    extractPngCharaChunk,
    parseCharaJson,
    stableStringify,
    characterDefinitionFingerprint,
} from '../server-plugin/character-fingerprint.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assertEqual(actual, expected, message) {
    if (actual === expected) {
        passed += 1;
    } else {
        failed += 1;
        failures.push(`FAIL: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}

function assertNotEqual(actual, expected, message) {
    if (actual !== expected) {
        passed += 1;
    } else {
        failed += 1;
        failures.push(`FAIL: ${message}\n  expected NOT to equal: ${JSON.stringify(expected)}`);
    }
}

function assertNull(value, message) {
    assertEqual(value, null, message);
}

// === PNG synthesis helpers ===

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeChunk(type, dataBuffer) {
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(dataBuffer.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4); // fake CRC - the parser does not validate
    return Buffer.concat([lengthBuf, typeBuf, dataBuffer, crcBuf]);
}

function makeTextChunk(keyword, textLatin1) {
    return makeChunk('tEXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(textLatin1, 'latin1'),
    ]));
}

const IEND = makeChunk('IEND', Buffer.alloc(0));

function makePngWithCharaJson(charaObj) {
    const base64 = Buffer.from(JSON.stringify(charaObj), 'utf-8').toString('base64');
    return Buffer.concat([PNG_SIG, makeTextChunk('chara', base64), IEND]);
}

function makePngNoChara() {
    return Buffer.concat([PNG_SIG, IEND]);
}

// === extractPngCharaChunk ===

(function testExtractBasic() {
    const png = Buffer.concat([PNG_SIG, makeTextChunk('chara', 'aGVsbG8='), IEND]);
    assertEqual(extractPngCharaChunk(png), 'aGVsbG8=', 'extractPngCharaChunk basic');
})();

(function testExtractNoChara() {
    assertNull(extractPngCharaChunk(makePngNoChara()), 'extractPngCharaChunk no-chara returns null');
})();

(function testExtractBadSignature() {
    assertNull(extractPngCharaChunk(Buffer.from('not a png at all here')), 'extractPngCharaChunk non-PNG returns null');
})();

(function testExtractIgnoresOtherText() {
    const png = Buffer.concat([
        PNG_SIG,
        makeTextChunk('Comment', 'irrelevant'),
        makeTextChunk('chara', 'eyJuYW1lIjoidGVzdCJ9'),
        IEND,
    ]);
    assertEqual(extractPngCharaChunk(png), 'eyJuYW1lIjoidGVzdCJ9', 'extractPngCharaChunk skips non-chara tEXt');
})();

// === parseCharaJson ===

(function testParseValid() {
    const base64 = Buffer.from('{"name":"test","description":"desc"}', 'utf-8').toString('base64');
    const parsed = parseCharaJson(base64);
    assertEqual(parsed?.name, 'test', 'parseCharaJson valid name');
    assertEqual(parsed?.description, 'desc', 'parseCharaJson valid description');
})();

(function testParseEmptyString() {
    assertNull(parseCharaJson(''), 'parseCharaJson empty string returns null');
})();

(function testParseBadBase64() {
    assertNull(parseCharaJson('!@#%^&*not_base64'), 'parseCharaJson non-base64 returns null');
})();

(function testParseNonObjectJson() {
    const base64 = Buffer.from('"just a string"', 'utf-8').toString('base64');
    assertNull(parseCharaJson(base64), 'parseCharaJson string-not-object returns null');
})();

// === stableStringify ===

(function testStableObjectKeyOrder() {
    const a = stableStringify({ a: 1, b: 2, c: 3 });
    const b = stableStringify({ c: 3, b: 2, a: 1 });
    assertEqual(a, b, 'stableStringify same object different key order');
})();

(function testStableNestedObject() {
    const a = stableStringify({ x: { p: 1, q: 2 } });
    const b = stableStringify({ x: { q: 2, p: 1 } });
    assertEqual(a, b, 'stableStringify nested object');
})();

(function testStableArrayOrder() {
    assertNotEqual(
        stableStringify([1, 2, 3]),
        stableStringify([3, 2, 1]),
        'stableStringify preserves array order (different order = different string)',
    );
})();

(function testStableUndefinedSkipped() {
    assertEqual(
        stableStringify({ a: 1, b: undefined, c: 3 }),
        '{"a":1,"c":3}',
        'stableStringify skips undefined values in objects',
    );
})();

(function testStableNullPreserved() {
    assertEqual(
        stableStringify({ a: null }),
        '{"a":null}',
        'stableStringify preserves null',
    );
})();

(function testStableArrayUndefinedBecomesNull() {
    assertEqual(
        stableStringify([1, undefined, 3]),
        '[1,null,3]',
        'stableStringify converts undefined to null in arrays (mirroring JSON.stringify)',
    );
})();

// === characterDefinitionFingerprint ===

const cardV1Base = {
    name: 'Test Character',
    description: 'A test card',
    personality: 'Friendly',
    first_mes: 'Hello!',
    scenario: 'A test scenario',
    mes_example: '',
    tags: ['test', 'fixture'],
};

const cardV2Base = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { ...cardV1Base },
};

(function testFingerprintV1V2SameContent() {
    const fp1 = characterDefinitionFingerprint(makePngWithCharaJson(cardV1Base));
    const fp2 = characterDefinitionFingerprint(makePngWithCharaJson(cardV2Base));
    assertEqual(fp1, fp2, 'V1 and V2 with same core content produce same fingerprint');
})();

(function testFingerprintIgnoresV2Extensions() {
    const a = makePngWithCharaJson({
        spec: 'chara_card_v2',
        data: { ...cardV1Base, extensions: { fav: false, talkativeness: '0.5' } },
    });
    const b = makePngWithCharaJson({
        spec: 'chara_card_v2',
        data: { ...cardV1Base, extensions: { fav: true, talkativeness: '0.9', depth_prompt: { x: 1 } } },
    });
    assertEqual(
        characterDefinitionFingerprint(a),
        characterDefinitionFingerprint(b),
        'V2 same content with different extensions produces same fingerprint',
    );
})();

(function testFingerprintIgnoresV1RuntimeFields() {
    const a = makePngWithCharaJson({ ...cardV1Base });
    const b = makePngWithCharaJson({
        ...cardV1Base,
        fav: false,
        talkativeness: '0.5',
        chat: 'some_chat_id',
        create_date: '2026-01-01',
        avatar: 'whatever.png',
    });
    assertEqual(
        characterDefinitionFingerprint(a),
        characterDefinitionFingerprint(b),
        'V1 same content with/without runtime fields produces same fingerprint',
    );
})();

(function testFingerprintDifferentDescription() {
    const a = makePngWithCharaJson(cardV1Base);
    const b = makePngWithCharaJson({ ...cardV1Base, description: 'A different test card' });
    assertNotEqual(
        characterDefinitionFingerprint(a),
        characterDefinitionFingerprint(b),
        'Different description produces different fingerprint',
    );
})();

(function testFingerprintDifferentName() {
    const a = makePngWithCharaJson(cardV1Base);
    const b = makePngWithCharaJson({ ...cardV1Base, name: 'Another Character' });
    assertNotEqual(
        characterDefinitionFingerprint(a),
        characterDefinitionFingerprint(b),
        'Different name produces different fingerprint',
    );
})();

(function testFingerprintCharacterBookIgnoresExtensions() {
    const baseBook = {
        spec: 'chara_card_v2',
        data: {
            ...cardV1Base,
            character_book: {
                name: 'book',
                entries: [
                    { keys: ['k1'], content: 'c1' },
                    { keys: ['k2'], content: 'c2' },
                ],
            },
        },
    };
    const withBookExt = {
        spec: 'chara_card_v2',
        data: {
            ...cardV1Base,
            character_book: {
                name: 'book',
                extensions: { ui_color: 'red' },
                entries: [
                    { keys: ['k1'], content: 'c1', extensions: { foo: 1 } },
                    { keys: ['k2'], content: 'c2', extensions: { bar: 2 } },
                ],
            },
        },
    };
    assertEqual(
        characterDefinitionFingerprint(makePngWithCharaJson(baseBook)),
        characterDefinitionFingerprint(makePngWithCharaJson(withBookExt)),
        'character_book ignores extensions at all levels',
    );
})();

(function testFingerprintCharacterBookContentChangeMatters() {
    const a = {
        spec: 'chara_card_v2',
        data: {
            ...cardV1Base,
            character_book: { name: 'book', entries: [{ keys: ['k1'], content: 'c1' }] },
        },
    };
    const b = {
        spec: 'chara_card_v2',
        data: {
            ...cardV1Base,
            character_book: { name: 'book', entries: [{ keys: ['k1'], content: 'modified content' }] },
        },
    };
    assertNotEqual(
        characterDefinitionFingerprint(makePngWithCharaJson(a)),
        characterDefinitionFingerprint(makePngWithCharaJson(b)),
        'character_book entry content change changes fingerprint',
    );
})();

(function testFingerprintNoCharaChunk() {
    assertNull(characterDefinitionFingerprint(makePngNoChara()), 'PNG without chara returns null');
})();

(function testFingerprintNonPng() {
    assertNull(characterDefinitionFingerprint(Buffer.from('not a png at all here')), 'Non-PNG returns null');
})();

(function testFingerprintMixedV1V2() {
    // If both spec=v2 and top-level fields exist, V2 data should win
    const mixed = {
        spec: 'chara_card_v2',
        name: 'TOP_LEVEL_NAME',
        data: { ...cardV1Base, name: 'V2_DATA_NAME' },
    };
    const v2Only = {
        spec: 'chara_card_v2',
        data: { ...cardV1Base, name: 'V2_DATA_NAME' },
    };
    assertEqual(
        characterDefinitionFingerprint(makePngWithCharaJson(mixed)),
        characterDefinitionFingerprint(makePngWithCharaJson(v2Only)),
        'V2 spec ignores top-level fields when data present',
    );
})();

// === Report ===

console.log('');
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
    console.log('');
    failures.forEach((f) => console.log(f));
    process.exit(1);
}
process.exit(0);
