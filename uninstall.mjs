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
    const dataDir = path.join(sillyTavernRoot, 'data');
    if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
        return [];
    }

    return fs.readdirSync(dataDir)
        .map((entry) => path.join(dataDir, entry))
        .filter((entryPath) => fs.existsSync(entryPath) && fs.statSync(entryPath).isDirectory())
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
    console.log('如需完全停用 server plugins，请手动把 config.yaml 里的 enableServerPlugins 改回 false。');
}

await main();
