import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSillyTavernRoot } from './sillytavern-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_NAME = 'chat-vault';

function readTextIfExists(filePath) {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    return fs.readFileSync(filePath, 'utf8');
}

function getDockerComposeText(sillyTavernRoot) {
    return [
        path.join(sillyTavernRoot, 'docker-compose.yml'),
        path.join(sillyTavernRoot, 'docker-compose.yaml'),
    ].map(readTextIfExists).join('\n');
}

function isDirectory(targetPath) {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

function getDataRootCandidates(sillyTavernRoot) {
    const composeText = getDockerComposeText(sillyTavernRoot);
    const candidates = [
        path.join(sillyTavernRoot, 'data'),
        path.join(sillyTavernRoot, 'docker', 'data'),
    ];

    const mountMatches = composeText.matchAll(/(?:^|\s|["'])((?:\.{1,2}\/|\/)?[^"'#\s]+?)\s*:\s*\/home\/node\/app\/data(?::|["'\s]|$)/gm);
    for (const match of mountMatches) {
        const hostPath = String(match[1] || '').trim();
        if (hostPath) {
            candidates.push(path.resolve(sillyTavernRoot, hostPath));
        }
    }

    return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))));
}

function getLegacyExtensionTargetDirs(sillyTavernRoot) {
    const targets = [
        path.join(
            sillyTavernRoot,
            'public',
            'scripts',
            'extensions',
            'third-party',
            EXTENSION_NAME,
        ),
    ];

    const composeText = getDockerComposeText(sillyTavernRoot);
    const hasDockerMountedExtensions = composeText.includes('/home/node/app/public/scripts/extensions/third-party');
    if (hasDockerMountedExtensions) {
        targets.push(path.join(sillyTavernRoot, 'extensions', EXTENSION_NAME));
    }

    return Array.from(new Set(targets));
}

function getUserBaseDirs(sillyTavernRoot) {
    const userBaseDirs = [];
    for (const dataDir of getDataRootCandidates(sillyTavernRoot).filter(isDirectory)) {
        userBaseDirs.push(...getUserBaseDirsInDataRoot(dataDir));
    }

    return Array.from(new Set(userBaseDirs));
}

function getUserBaseDirsInDataRoot(dataDir) {
    return fs.readdirSync(dataDir)
        .map((entry) => path.join(dataDir, entry))
        .filter(isDirectory)
        .filter((entryPath) => {
            return fs.existsSync(path.join(entryPath, 'settings.json'))
                || fs.existsSync(path.join(entryPath, 'extensions'))
                || path.basename(entryPath) === 'default-user';
        });
}

function getExtensionTargetDirs(sillyTavernRoot) {
    const userBaseDirs = getUserBaseDirs(sillyTavernRoot);
    const userTargets = userBaseDirs.map((userBaseDir) => path.join(userBaseDir, 'extensions', EXTENSION_NAME));
    return Array.from(new Set([
        ...userTargets,
        ...getLegacyExtensionTargetDirs(sillyTavernRoot),
    ]));
}

async function main() {
    const resolution = await resolveSillyTavernRoot({
        explicitInput: process.argv[2] || '',
        envInput: process.env.SILLYTAVERN_DIR || '',
        cwd: process.cwd(),
        scriptDirectory: __dirname,
        actionText: '卸载',
        scriptName: 'uninstall.mjs',
    });
    const sillyTavernRoot = resolution.root;
    const extensionTargetDirs = getExtensionTargetDirs(sillyTavernRoot);
    const serverPluginTargetDir = path.join(sillyTavernRoot, 'plugins', EXTENSION_NAME);

    for (const extensionTargetDir of extensionTargetDirs) {
        fs.rmSync(extensionTargetDir, { recursive: true, force: true });
    }
    fs.rmSync(serverPluginTargetDir, { recursive: true, force: true });

    if (resolution.detectionMode !== 'argument' && resolution.detectionMode !== 'environment') {
        console.log(`已自动定位 SillyTavern: ${sillyTavernRoot}`);
    }
    console.log('聊天保险箱已卸载');
    for (const extensionTargetDir of extensionTargetDirs) {
        console.log(`已删除扩展目录: ${extensionTargetDir}`);
    }
    console.log(`已删除插件目录: ${serverPluginTargetDir}`);
    console.log('如需完全停用 server plugins，请手动把生效配置文件里的 enableServerPlugins 改回 false（通常是 config/config.yaml 或根目录 config.yaml）。');
}

await main();
