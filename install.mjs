import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSillyTavernRoot } from './sillytavern-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXTENSION_NAME = 'chat-vault';
const EXTENSION_SOURCE_DIR = path.join(__dirname, 'extension');
const SERVER_PLUGIN_SOURCE_DIR = path.join(__dirname, 'server-plugin');

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

function getPreferredExtensionTargetDirs(sillyTavernRoot) {
    const userBaseDirs = getUserBaseDirs(sillyTavernRoot);
    if (userBaseDirs.length > 0) {
        return userBaseDirs.map((userBaseDir) => path.join(userBaseDir, 'extensions', EXTENSION_NAME));
    }

    return getLegacyExtensionTargetDirs(sillyTavernRoot);
}

function copyRecursive(sourcePath, targetPath) {
    const stats = fs.statSync(sourcePath);
    if (stats.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        for (const entry of fs.readdirSync(sourcePath)) {
            copyRecursive(path.join(sourcePath, entry), path.join(targetPath, entry));
        }
        return;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertYamlBoolean(text, key, nextValue) {
    const pattern = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*:\\s*)(true|false)\\s*$`, 'm');
    if (pattern.test(text)) {
        return text.replace(pattern, `$1${nextValue ? 'true' : 'false'}`);
    }

    const normalized = text.trimEnd();
    return `${normalized ? `${normalized}\n` : ''}${key}: ${nextValue ? 'true' : 'false'}\n`;
}

function patchConfigYaml(sillyTavernRoot) {
    const configPath = path.join(sillyTavernRoot, 'config.yaml');
    const originalText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const nextText = upsertYamlBoolean(originalText, 'enableServerPlugins', true);
    fs.writeFileSync(configPath, nextText, 'utf8');
    return configPath;
}

async function main() {
    const resolution = await resolveSillyTavernRoot({
        explicitInput: process.argv[2] || '',
        envInput: process.env.SILLYTAVERN_DIR || '',
        cwd: process.cwd(),
        scriptDirectory: __dirname,
        actionText: '安装',
        scriptName: 'install.mjs',
    });
    const sillyTavernRoot = resolution.root;

    const extensionTargetDirs = getPreferredExtensionTargetDirs(sillyTavernRoot);
    const cleanupExtensionTargetDirs = Array.from(new Set([
        ...extensionTargetDirs,
        ...getLegacyExtensionTargetDirs(sillyTavernRoot),
    ]));
    const serverPluginTargetDir = path.join(sillyTavernRoot, 'plugins', EXTENSION_NAME);

    for (const extensionTargetDir of cleanupExtensionTargetDirs) {
        fs.rmSync(extensionTargetDir, { recursive: true, force: true });
    }
    fs.rmSync(serverPluginTargetDir, { recursive: true, force: true });

    for (const extensionTargetDir of extensionTargetDirs) {
        copyRecursive(EXTENSION_SOURCE_DIR, extensionTargetDir);
    }
    copyRecursive(SERVER_PLUGIN_SOURCE_DIR, serverPluginTargetDir);

    const configPath = patchConfigYaml(sillyTavernRoot);

    if (resolution.detectionMode !== 'argument' && resolution.detectionMode !== 'environment') {
        console.log(`已自动定位 SillyTavern: ${sillyTavernRoot}`);
    }
    console.log('聊天保险箱安装完成');
    console.log(`SillyTavern: ${sillyTavernRoot}`);
    for (const extensionTargetDir of extensionTargetDirs) {
        console.log(`前端扩展: ${extensionTargetDir}`);
    }
    console.log(`Server Plugin: ${serverPluginTargetDir}`);
    console.log(`配置已更新: ${configPath}`);
    console.log('请重启 SillyTavern。');
}

await main();
