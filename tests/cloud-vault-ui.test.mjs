import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(testDirectory, '..');
const read = (relativePath) => fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8');
const source = read('extension/index.js');
const styles = read('extension/style.css');
const zh = JSON.parse(read('extension/i18n/zh-cn.json'));
const en = JSON.parse(read('extension/i18n/en-us.json'));

const cloudPage = source.slice(
    source.indexOf('<section class="cvt-page" data-cvt-page="cloud">'),
    source.indexOf('<section class="cvt-page" data-cvt-page="character-merge">'),
);

assert.ok(cloudPage.includes('id="cvt_cloud_manage"'));
assert.ok(cloudPage.includes('id="cvt_cloud_sync"'));
assert.ok(cloudPage.includes('id="cvt_cloud_help"'));
assert.match(cloudPage, /id="cvt_cloud_refresh"[^>]*><i[^>]*><\/i><span>\$\{t\('cloud\.actions\.refreshRemote'\)\}<\/span>/);
assert.match(cloudPage, /id="cvt_cloud_help"[^>]*><i[^>]*><\/i><span>\$\{t\('cloud\.actions\.help'\)\}<\/span>/);
assert.ok(cloudPage.includes('id="cvt_cloud_scope_list"'));
assert.equal(cloudPage.includes('cvt_cloud_repo_url'), false);
assert.equal(cloudPage.includes('cvt_cloud_member_list'), false);
assert.equal(cloudPage.includes("t('cloud.useCase')"), false);
assert.equal(cloudPage.includes("t('cloud.restoreExplain')"), false);

assert.match(source, /document\.createElement\('dialog'\)/);
assert.match(source, /dialog\.showModal\(\)/);
assert.match(source, /const overlay = document\.createElement\('dialog'\)/);
assert.match(source, /overlay\.showModal\(\)/);
assert.match(source, /overlay\.addEventListener\('cancel'/);
assert.match(source, /function openCloudHelpDialog\(\)/);
assert.match(source, /body\.scrollTop = 0;/);
assert.match(source, /mode: 'create-member'/);
assert.match(source, /cloudRepositoryEditor = null;\s*renderCloudRepositoryDialog\(\);/);
assert.match(source, /await connectCloudPanel\(payload\)/);
assert.doesNotMatch(source, /function addCloudRepositoryEditor/);
assert.doesNotMatch(source, /cvt_cloud_member_list/);
assert.doesNotMatch(source, /cloud\.manager\.advancedConnection/);
assert.doesNotMatch(source, /cloud\.manager\.help/);

assert.match(styles, /dialog\.cvt-cloud-manager\[open\]/);
assert.match(styles, /dialog\.cvt-cloud-manager::backdrop/);
assert.match(styles, /dialog\.cvt-overlay\[open\]/);
assert.match(styles, /dialog\.cvt-overlay::backdrop/);
assert.match(styles, /height: min\(86dvh, 900px\)/);
assert.match(styles, /\.cvt-cloud-actions/);
assert.match(styles, /\.cvt-cloud-manager-settings/);
assert.match(styles, /\.cvt-cloud-help-content/);
assert.doesNotMatch(source, /SmartTheme/);
assert.doesNotMatch(styles, /SmartTheme/);
assert.doesNotMatch(styles, /--cvt-field-bg|color:\s*var\(--cvt-text,\s*inherit\)/);
assert.match(styles, /appearance: none;/);
assert.match(styles, /::-webkit-scrollbar-thumb/);
assert.match(styles, /scrollbar-color: color-mix/);
assert.match(styles, /outline: none !important;/);
assert.match(styles, /box-shadow: none !important;/);
assert.match(styles, /filter: none !important;/);
assert.match(styles, /clip-path: polygon\(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%\)/);
assert.doesNotMatch(styles, /content:\s*'\\2713'/);

for (const key of [
    'common.cancel',
    'common.close',
    'cloud.actions.manageRepositories',
    'cloud.actions.saveAndConnect',
    'cloud.actions.addAndConnect',
    'cloud.actions.help',
    'cloud.manager.title',
    'cloud.help.description',
    'cloud.manager.repoRequired',
    'cloud.manager.connectionError',
]) {
    assert.ok(zh[key], `missing Chinese key: ${key}`);
    assert.ok(en[key], `missing English key: ${key}`);
}

for (const [language, dictionary] of [['zh-cn', zh], ['en-us', en]]) {
    const missingKeys = [...source.matchAll(/\bt\('([^']+)'/g)]
        .map((match) => match[1])
        .filter((key) => !(key in dictionary));
    assert.deepEqual([...new Set(missingKeys)], [], `missing ${language} i18n keys`);
}

assert.equal(zh['cloud.fields.memberToken'], '访问令牌（可选）');
assert.equal(zh['cloud.fields.memberToken'].includes('成员'), false);
assert.equal(zh['cloud.manager.member'], '附加仓库');
assert.equal(zh['cloud.manager.editMemberTitle'].includes('成员'), false);
assert.equal(en['cloud.manager.member'], 'Additional Repository');
assert.equal(en['cloud.manager.editMemberTitle'].includes('Member Repository'), false);
assert.equal(zh['cloud.actions.help'], '说明');
assert.equal(zh['theme.auto'], '默认');
assert.equal(en['theme.auto'], 'Default');

const characterMergeUi = source.slice(
    source.indexOf('function renderDuplicateGroups('),
    source.indexOf('async function wizardStepNext()'),
);
assert.match(characterMergeUi, /cvm-card-name|cvm-candidate-filename/);
assert.match(characterMergeUi, /characterMerge\.preview\.finalAvatar|characterMerge\.complete\.finalAvatar/);
assert.equal(zh['characterMerge.wizard.step2.pickA'], '保留 A：{name}');
assert.equal(zh['characterMerge.wizard.step2.pickB'], '保留 B：{name}');
assert.equal(read('README.md').includes('成员令牌'), false);
assert.equal(read('README.md').includes('成员仓库'), false);

const cloudManager = source.slice(
    source.indexOf('function buildCloudManagerEditor()'),
    source.indexOf('function cleanupCloudRepositoryDialog('),
);
assert.equal(cloudManager.includes("document.createElement('details')"), false);
assert.ok(
    cloudManager.indexOf('body.appendChild(buildCloudManagerSettings());')
        < cloudManager.indexOf('body.appendChild(listTitle);'),
    'sync settings must render above the repository pool',
);

console.log('cloud-vault-ui: passed');
