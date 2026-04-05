import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

const KNOWN_DIR_NAMES = [
    'SillyTavern',
    'sillytavern',
    'SillyTavern-release',
    'sillytavern-release',
    'ST',
    'st',
];

function isDirectory(targetPath) {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

export function isSillyTavernRoot(targetPath) {
    return isDirectory(targetPath)
        && fs.existsSync(path.join(targetPath, 'public', 'script.js'))
        && fs.existsSync(path.join(targetPath, 'src', 'plugin-loader.js'));
}

function uniquePaths(paths) {
    return Array.from(new Set(paths.filter(Boolean).map((item) => path.resolve(item))));
}

function addCandidate(candidateMap, targetPath, reason) {
    if (!targetPath) {
        return;
    }

    const resolved = path.resolve(targetPath);
    if (!isSillyTavernRoot(resolved)) {
        return;
    }

    const canonicalPath = fs.realpathSync.native(resolved);

    const current = candidateMap.get(canonicalPath) || {
        path: canonicalPath,
        reasons: new Set(),
    };
    current.reasons.add(reason);
    candidateMap.set(canonicalPath, current);
}

function collectKnownNameCandidates(baseDirectory, candidateMap) {
    for (const name of KNOWN_DIR_NAMES) {
        addCandidate(candidateMap, path.join(baseDirectory, name), `${baseDirectory} 下常见目录`);
    }
}

function collectSiblingCandidates(baseDirectory, candidateMap) {
    if (!isDirectory(baseDirectory)) {
        return;
    }

    const children = fs.readdirSync(baseDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'));

    for (const childName of children) {
        const normalizedName = childName.toLowerCase();
        const matchesKnownPattern = normalizedName.includes('sillytavern')
            || KNOWN_DIR_NAMES.some((name) => name.toLowerCase() === normalizedName);
        if (!matchesKnownPattern) {
            continue;
        }

        addCandidate(candidateMap, path.join(baseDirectory, childName), `${baseDirectory} 下同级目录`);
    }
}

function getCandidatePriority(candidate) {
    const normalizedName = path.basename(candidate.path).toLowerCase();
    if (normalizedName === 'sillytavern') {
        return 0;
    }
    if (normalizedName === 'sillytavern-release') {
        return 1;
    }
    if (normalizedName.includes('sillytavern')) {
        return 2;
    }
    return 3;
}

function normalizeCandidates(candidateMap) {
    return Array.from(candidateMap.values())
        .sort((left, right) => {
            const priorityDiff = getCandidatePriority(left) - getCandidatePriority(right);
            if (priorityDiff !== 0) {
                return priorityDiff;
            }

            return left.path.localeCompare(right.path, 'en');
        })
        .map((candidate) => ({
            path: candidate.path,
            reasons: Array.from(candidate.reasons),
        }));
}

function discoverSillyTavernRoots(scriptDirectory, cwd) {
    const stages = [
        {
            baseDirs: uniquePaths([cwd, scriptDirectory]).filter(isDirectory),
            includeSiblings: false,
        },
        {
            baseDirs: uniquePaths([path.dirname(cwd), path.dirname(scriptDirectory)]).filter(isDirectory),
            includeSiblings: true,
        },
        {
            baseDirs: uniquePaths([os.homedir()]).filter(isDirectory),
            includeSiblings: true,
        },
    ];

    for (const stage of stages) {
        const candidateMap = new Map();
        for (const baseDirectory of stage.baseDirs) {
            collectKnownNameCandidates(baseDirectory, candidateMap);
            if (stage.includeSiblings) {
                collectSiblingCandidates(baseDirectory, candidateMap);
            }
        }

        const candidates = normalizeCandidates(candidateMap);
        if (candidates.length > 0) {
            return candidates;
        }
    }

    return [];
}

function buildExplicitPathError(rawInput) {
    const resolved = path.resolve(rawInput);
    return `指定的 SillyTavern 根目录无效：${resolved}`;
}

function buildMissingPathError(scriptDirectory, cwd, scriptName) {
    return [
        '找不到 SillyTavern 根目录。',
        `已检查当前目录：${path.resolve(cwd)}`,
        `已检查项目目录：${path.resolve(scriptDirectory)}`,
        '可手动指定：',
        `  node ${scriptName} /path/to/SillyTavern`,
        '或设置环境变量：',
        '  SILLYTAVERN_DIR=/path/to/SillyTavern',
    ].join('\n');
}

function buildMultipleCandidatesError(candidates, actionText) {
    return [
        `检测到多个 SillyTavern 目录，无法自动决定要${actionText}哪个目标：`,
        ...candidates.map((candidate, index) => `  ${index + 1}. ${candidate.path}`),
        '请直接传入路径，或在交互终端里重新运行。',
    ].join('\n');
}

async function promptForCandidate(candidates, actionText) {
    if (!stdin.isTTY || !stdout.isTTY) {
        throw new Error(buildMultipleCandidatesError(candidates, actionText));
    }

    console.log(`检测到多个 SillyTavern 目录，请选择要${actionText}的目标：`);
    candidates.forEach((candidate, index) => {
        const reasonText = candidate.reasons.length > 0 ? ` (${candidate.reasons.join('；')})` : '';
        console.log(`  ${index + 1}. ${candidate.path}${reasonText}`);
    });

    const readline = createInterface({ input: stdin, output: stdout });
    try {
        while (true) {
            const answer = (await readline.question(`请输入序号 [1-${candidates.length}]，默认 1：`)).trim() || '1';
            const selectedIndex = Number(answer);
            if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= candidates.length) {
                return candidates[selectedIndex - 1].path;
            }

            console.log('输入无效，请重新输入。');
        }
    } finally {
        readline.close();
    }
}

export async function resolveSillyTavernRoot({
    explicitInput = '',
    envInput = '',
    cwd = process.cwd(),
    scriptDirectory = cwd,
    actionText = '操作',
    scriptName = 'install.mjs',
} = {}) {
    const preferredInput = String(explicitInput || envInput || '').trim();
    if (preferredInput) {
        const resolved = path.resolve(preferredInput);
        if (!isSillyTavernRoot(resolved)) {
            throw new Error(buildExplicitPathError(preferredInput));
        }

        return {
            root: resolved,
            detectionMode: explicitInput ? 'argument' : 'environment',
            candidates: [{ path: resolved, reasons: ['手动指定'] }],
        };
    }

    const resolvedCwd = path.resolve(cwd);
    if (isSillyTavernRoot(resolvedCwd)) {
        return {
            root: resolvedCwd,
            detectionMode: 'cwd',
            candidates: [{ path: resolvedCwd, reasons: ['当前目录'] }],
        };
    }

    const candidates = discoverSillyTavernRoots(scriptDirectory, cwd);
    if (candidates.length === 0) {
        throw new Error(buildMissingPathError(scriptDirectory, cwd, scriptName));
    }

    if (candidates.length === 1) {
        return {
            root: candidates[0].path,
            detectionMode: 'auto',
            candidates,
        };
    }

    const selectedRoot = await promptForCandidate(candidates, actionText);
    return {
        root: selectedRoot,
        detectionMode: 'prompt',
        candidates,
    };
}
