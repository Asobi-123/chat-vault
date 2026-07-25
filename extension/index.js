import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE, Popup } from '../../../popup.js';
import { getUserAvatars } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { waitUntilCondition } from '../../../utils.js';
import { world_info } from '../../../world-info.js';
import { applyI18n, initializeI18n, t } from './i18n.js';

const MODULE_NAME = 'third-party/chat-vault';
const API_ROOT = '/api/plugins/chat-vault';
const SETTINGS_KEY = 'chatVault';
const DEFAULT_SETTINGS = {
    enabled: true,
    showRecoveryToast: true,
    showTrigger: true,
    themeId: 'auto',
    autoSlotCount: 1,
    saveDelayMs: 350,
    draftMirrorMs: 300,
    previewMessages: 12,
    restoreNameTemplate: '{{chat}} - Chat Vault {{time}}',
    snapshotFileTemplate: '{{name}} - {{mode}} - {{time}}',
    collapsedSections: {},
};
const SNAPSHOT_DELAYS = Object.freeze({
    message_sent: 1800,
    message_received: 500,
    message_updated: 250,
    message_deleted: 250,
    message_swiped: 900,
    manual: 0,
});
const PANEL_IDS = Object.freeze({
    trigger: 'cvt_trigger',
    overlay: 'cvt_overlay',
    modal: 'cvt_modal',
    close: 'cvt_modal_close',
});
const DEFAULT_THEME = Object.freeze({
    bg: '#171d25',
    surface: '#222b36',
    fieldBg: '#10171f',
    border: '#465568',
    text: '#edf2f7',
    dim: '#a7b3c2',
    accent: '#76b7f2',
    accentSoft: 'rgba(118,183,242,.16)',
});
const THEMES = Object.freeze({
    auto: DEFAULT_THEME,
    slate: { bg: '#182028', surface: '#232d39', fieldBg: '#121920', border: '#435366', text: '#eef3f7', dim: '#9eb0c3', accent: '#e4b35d', accentSoft: 'rgba(228,179,93,.16)' },
    ocean: { bg: '#0d1721', surface: '#152534', fieldBg: '#0a1219', border: '#3f607f', text: '#edf6ff', dim: '#86a3c0', accent: '#69b8ff', accentSoft: 'rgba(105,184,255,.16)' },
    mocha: { bg: '#1a1412', surface: '#2e231d', fieldBg: '#140f0c', border: '#5e4b3e', text: '#f2e8e0', dim: '#9e8878', accent: '#c09070', accentSoft: 'rgba(192,144,112,.18)' },
    rose: { bg: '#1d1821', surface: '#3a2f3a', fieldBg: '#16111a', border: '#756277', text: '#f6edf3', dim: '#af95a3', accent: '#d28faf', accentSoft: 'rgba(210,143,175,.18)' },
    snow: { bg: '#f4f2ea', surface: '#faf8f2', fieldBg: '#fffdf7', border: '#d4ccbd', text: '#2e2a24', dim: '#73695b', accent: '#786a56', accentSoft: 'rgba(120,106,86,.14)' },
    frost: { bg: '#d8e6ef', surface: '#e5f0f6', fieldBg: '#f2faff', border: '#a8c0cf', text: '#1f3341', dim: '#617b8d', accent: '#5d9fd6', accentSoft: 'rgba(93,159,214,.16)' },
});

let backendReady = false;
let statusCache = null;
let snapshotTimer = null;
let saveTimer = null;
let draftTimer = null;
let scheduledSnapshotRequest = null;
let isSnapshotting = false;
let pendingSnapshotRequest = null;
let pendingSwipeSnapshot = null;
let lastDraftSignature = '';
let lastRecoveryToastKey = '';
let renameBridgeInstalled = false;
let activeScopeOverride = null;
let recoveryScopeCache = [];
let cloudConfigCache = null;
let cloudManifestCache = null;
let activeCloudScopeId = '';
let currentThemeId = 'auto';
let cloudToolbarBusy = false;
let cloudRepositoryDialog = null;
let cloudRepositoryEditor = null;
let cloudRepositoryDialogBusy = false;
let cloudHelpDialog = null;
let csrfOverrideToken = '';
let csrfRefreshPromise = null;

function buildThemeButtons() {
    return Object.keys(THEMES).map((themeId) => {
        const palette = THEMES[themeId];
        const swatchStyle = `background:linear-gradient(135deg,${palette.surface},${palette.bg});border:1px solid ${palette.border};`;
        return `<button type="button" class="cvt-theme-btn${currentThemeId === themeId ? ' active' : ''}" data-theme="${themeId}"><span class="cvt-theme-swatch" style="${swatchStyle}"></span><span class="cvt-theme-label">${t(`theme.${themeId}`)}</span></button>`;
    }).join('');
}

function getAppTitle() {
    return t('app.title');
}

function buildEmptyCloudManifest() {
    return {
        scopeCount: 0,
        snapshotCount: 0,
        deviceCount: 0,
        updatedAt: 0,
        scopes: [],
    };
}

function getTriggerDisplayLabel(trigger) {
    const key = String(trigger || '').trim();
    const supported = {
        manual: true,
        message_sent: true,
        message_received: true,
        message_updated: true,
        message_deleted: true,
        message_swiped: true,
        generation_ended: true,
        chat_changed: true,
    };
    if (supported[key]) {
        return t(`triggers.${key}`);
    }
    return key || t('tags.chatBackup');
}

function isSectionCollapsed(sectionKey) {
    const collapsedSections = ensureSettings().collapsedSections;
    return Boolean(collapsedSections && typeof collapsedSections === 'object' && collapsedSections[sectionKey]);
}

function buildSectionToggle(sectionKey) {
    const collapsed = isSectionCollapsed(sectionKey);
    const label = collapsed ? t('common.expand') : t('common.collapse');
    const icon = collapsed ? '&#9656;' : '&#9662;';
    return `<button type="button" class="cvt-section-toggle" data-cvt-toggle-section="${sectionKey}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${label}" title="${label}"><span class="cvt-section-toggle-icon" aria-hidden="true">${icon}</span></button>`;
}

function getCardBodyClass(sectionKey, { scroll = false } = {}) {
    return [
        'cvt-card-body',
        scroll ? 'cvt-card-body-scroll' : '',
        isSectionCollapsed(sectionKey) ? 'is-collapsed' : '',
    ].filter(Boolean).join(' ');
}

function buildPanelHtml() {
    return `
        <div id="${PANEL_IDS.modal}" class="cvt-modal">
            <div class="cvt-header">
                <div class="cvt-title">
                    <strong>${t('app.title')}</strong>
                    <span>${t('panel.subtitle')}</span>
                </div>
                <button id="${PANEL_IDS.close}" type="button" class="cvt-close-btn">×</button>
            </div>
            <nav class="cvt-tabs">
                <button type="button" class="cvt-tab active" data-cvt-tab="chat">${t('tabs.chat')}</button>
                <button type="button" class="cvt-tab" data-cvt-tab="recovery">${t('tabs.recovery')}</button>
                <button type="button" class="cvt-tab" data-cvt-tab="cloud">${t('tabs.cloud')}</button>
                <button type="button" class="cvt-tab" data-cvt-tab="character-merge">${t('tabs.characterMerge')}</button>
                <button type="button" class="cvt-tab" data-cvt-tab="settings">${t('tabs.settings')}</button>
            </nav>
            <div class="cvt-body">
                <section class="cvt-page active" data-cvt-page="chat">
                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('chat.section.status')}</strong>
                            <div class="cvt-section-head-actions">
                                <span id="cvt_current_summary" class="cvt-summary">${t('common.loading')}</span>
                                ${buildSectionToggle('chat_status')}
                            </div>
                        </div>
                        <div class="${getCardBodyClass('chat_status')}" data-cvt-section="chat_status">
                            <div class="cvt-status-row">
                                <span id="cvt_backend_status" class="cvt-badge" data-kind="idle">${t('status.checking')}</span>
                            </div>
                            <div class="cvt-toolbar" style="margin-top:10px;">
                                <button id="cvt_refresh" type="button" class="menu_button">${t('common.refresh')}</button>
                                <button id="cvt_snapshot_now" type="button" class="menu_button">${t('chat.toolbar.backupNow')}</button>
                                <button id="cvt_open_recovery" type="button" class="menu_button">${t('chat.toolbar.recovery')}</button>
                            </div>
                            <div class="cvt-note">${t('chat.toolbarHint')}</div>
                        </div>
                    </div>

                    <div id="cvt_draft_card" class="cvt-card cvt-card-soft" hidden>
                        <div class="cvt-section-head">
                            <strong class="cvt-draft-title">${t('draft.detected')}</strong>
                            <div class="cvt-section-head-actions">
                                ${buildSectionToggle('chat_draft')}
                            </div>
                        </div>
                        <div class="${getCardBodyClass('chat_draft')}" data-cvt-section="chat_draft">
                            <div id="cvt_draft_meta" class="cvt-draft-meta"></div>
                            <div id="cvt_draft_preview" class="cvt-draft-preview"></div>
                            <div class="cvt-toolbar">
                                <button id="cvt_restore_draft" type="button" class="menu_button">${t('draft.restore')}</button>
                                <button id="cvt_clear_draft" type="button" class="menu_button">${t('draft.clear')}</button>
                            </div>
                            <div class="cvt-note">${t('draft.note')}</div>
                        </div>
                    </div>

                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('chat.section.backups')}</strong>
                            <div class="cvt-section-head-actions">
                                <span class="cvt-hint">${t('chat.section.backupsHint')}</span>
                                ${buildSectionToggle('chat_backups')}
                            </div>
                        </div>
                        <div class="${getCardBodyClass('chat_backups', { scroll: true })}" data-cvt-section="chat_backups">
                            <label class="cvt-field cvt-field-tight">
                                <span>${t('chat.searchLabel')}</span>
                                <input id="cvt_checkpoint_search" class="text_pole" type="text" placeholder="${t('chat.searchPlaceholder')}">
                            </label>
                            <div id="cvt_checkpoint_list" class="cvt-list">
                                <div class="cvt-empty">${t('common.loading')}</div>
                            </div>
                            <div class="cvt-note">${t('chat.backupsNote')}</div>
                        </div>
                    </div>
                </section>

                <section class="cvt-page" data-cvt-page="recovery">
                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('recovery.section.title')}</strong>
                            <div class="cvt-section-head-actions">
                                <span id="cvt_recovery_summary" class="cvt-summary">${t('status.recoveryIdle')}</span>
                                ${buildSectionToggle('recovery_overview')}
                            </div>
                        </div>
                        <div class="${getCardBodyClass('recovery_overview')}" data-cvt-section="recovery_overview">
                            <div class="cvt-toolbar">
                                <button id="cvt_scope_refresh" type="button" class="menu_button">${t('recovery.refreshList')}</button>
                                <button id="cvt_scope_cleanup_empty" type="button" class="menu_button">${t('recovery.cleanupEmpty')}</button>
                                <button id="cvt_back_to_chat" type="button" class="menu_button" hidden>${t('recovery.backToChat')}</button>
                            </div>
                            <div class="cvt-field" style="margin-top:10px;">
                                <span>${t('recovery.searchLabel')}</span>
                                <input id="cvt_scope_search" class="text_pole" type="text" placeholder="${t('recovery.searchPlaceholder')}">
                            </div>
                            <div class="cvt-note cvt-note-strong">${t('recovery.useCase')}</div>
                            <div class="cvt-note">${t('recovery.capability')}</div>
                        </div>
                    </div>

                    <div class="cvt-recovery-grid">
                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('recovery.section.scope')}</strong>
                                <div class="cvt-section-head-actions">
                                    <span class="cvt-hint">${t('recovery.section.scopeHint')}</span>
                                    ${buildSectionToggle('recovery_scope_list')}
                                </div>
                            </div>
                            <div class="${getCardBodyClass('recovery_scope_list', { scroll: true })}" data-cvt-section="recovery_scope_list">
                                <div id="cvt_scope_list" class="cvt-list">
                                    <div class="cvt-empty">${t('common.loading')}</div>
                                </div>
                            </div>
                        </div>

                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('recovery.section.selected')}</strong>
                                <div class="cvt-section-head-actions">
                                    <span class="cvt-hint">${t('recovery.section.selectedHint')}</span>
                                    ${buildSectionToggle('recovery_backup_list')}
                                </div>
                            </div>
                            <div class="${getCardBodyClass('recovery_backup_list', { scroll: true })}" data-cvt-section="recovery_backup_list">
                                <label class="cvt-field cvt-field-tight">
                                    <span>${t('recovery.backupSearchLabel')}</span>
                                    <input id="cvt_recovery_checkpoint_search" class="text_pole" type="text" placeholder="${t('recovery.backupSearchPlaceholder')}">
                                </label>
                                <div id="cvt_recovery_checkpoint_list" class="cvt-list">
                                    <div class="cvt-empty">${t('recovery.emptySelectFirst')}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="cvt-page" data-cvt-page="cloud">
                    <div class="cvt-card cvt-cloud-overview">
                        <div class="cvt-section-head">
                            <strong>${t('cloud.section.title')}</strong>
                            <div class="cvt-section-head-actions">
                                <span id="cvt_cloud_summary" class="cvt-summary">${t('cloud.status.idle')}</span>
                            </div>
                        </div>
                        <div class="cvt-card-body">
                            <div class="cvt-cloud-actions">
                                <button id="cvt_cloud_sync" type="button" class="menu_button cvt-cloud-primary"><i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i><span>${t('cloud.actions.syncNow')}</span></button>
                                <button id="cvt_cloud_refresh" type="button" class="menu_button" title="${t('cloud.actions.refreshRemote')}" aria-label="${t('cloud.actions.refreshRemote')}"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span>${t('cloud.actions.refreshRemote')}</span></button>
                                <button id="cvt_cloud_manage" type="button" class="menu_button"><i class="fa-solid fa-gear" aria-hidden="true"></i><span>${t('cloud.actions.manageRepositories')}</span></button>
                                <button id="cvt_cloud_help" type="button" class="menu_button" title="${t('cloud.actions.help')}" aria-label="${t('cloud.actions.help')}"><i class="fa-solid fa-circle-question" aria-hidden="true"></i><span>${t('cloud.actions.help')}</span></button>
                            </div>
                            <div id="cvt_cloud_action_hint" class="cvt-hint">${t('cloud.actionHint.idle')}</div>
                        </div>
                    </div>

                    <div class="cvt-cloud-grid">
                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('cloud.section.scope')}</strong>
                                <div class="cvt-section-head-actions">
                                    <span class="cvt-hint">${t('cloud.section.scopeHint')}</span>
                                    ${buildSectionToggle('cloud_scope_list')}
                                </div>
                            </div>
                            <div class="${getCardBodyClass('cloud_scope_list', { scroll: true })}" data-cvt-section="cloud_scope_list">
                                <label class="cvt-field cvt-field-tight">
                                    <span>${t('cloud.scopeSearchLabel')}</span>
                                    <input id="cvt_cloud_scope_search" class="text_pole" type="text" placeholder="${t('cloud.scopeSearchPlaceholder')}">
                                </label>
                                <div id="cvt_cloud_scope_list" class="cvt-list">
                                    <div class="cvt-empty">${t('cloud.emptyNoConfig')}</div>
                                </div>
                            </div>
                        </div>

                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('cloud.section.selected')}</strong>
                                <div class="cvt-section-head-actions">
                                    <span class="cvt-hint">${t('cloud.section.selectedHint')}</span>
                                    ${buildSectionToggle('cloud_backup_list')}
                                </div>
                            </div>
                            <div class="${getCardBodyClass('cloud_backup_list', { scroll: true })}" data-cvt-section="cloud_backup_list">
                                <label class="cvt-field cvt-field-tight">
                                    <span>${t('cloud.backupSearchLabel')}</span>
                                    <input id="cvt_cloud_checkpoint_search" class="text_pole" type="text" placeholder="${t('cloud.backupSearchPlaceholder')}">
                                </label>
                                <div id="cvt_cloud_checkpoint_list" class="cvt-list">
                                    <div class="cvt-empty">${t('cloud.emptySelectFirst')}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="cvt-page" data-cvt-page="character-merge">
                    <div id="cvm_pending_banner" class="cvt-card cvm-pending-banner" hidden>
                        <div class="cvt-section-head">
                            <strong>${t('characterMerge.pending.heading')}</strong>
                        </div>
                        <div class="cvt-card-body">
                            <p id="cvm_pending_detail" class="cvt-note"></p>
                            <div class="cvt-toolbar">
                                <button id="cvm_pending_rollback" type="button" class="menu_button">${t('characterMerge.pending.rollback')}</button>
                                <button id="cvm_pending_acknowledge" type="button" class="menu_button">${t('characterMerge.pending.acknowledge')}</button>
                            </div>
                            <div class="cvt-note">${t('characterMerge.pending.note')}</div>
                        </div>
                    </div>

                    <div id="cvm_scan_view" class="cvm-view">
                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('characterMerge.explainer.heading')}</strong>
                                <div class="cvt-section-head-actions">${buildSectionToggle('cm_explainer')}</div>
                            </div>
                            <div class="${getCardBodyClass('cm_explainer')}" data-cvt-section="cm_explainer">
                                <p class="cvt-note">${t('characterMerge.explainer.intro')}</p>
                                <ul class="cvt-bullets">
                                    <li>${t('characterMerge.explainer.cause1')}</li>
                                    <li>${t('characterMerge.explainer.cause2')}</li>
                                    <li>${t('characterMerge.explainer.cause3')}</li>
                                </ul>
                                <p class="cvt-note">${t('characterMerge.explainer.purpose')}</p>
                            </div>
                        </div>

                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('characterMerge.scan.heading')}</strong>
                                <div class="cvt-section-head-actions">
                                    <button id="cvm_refresh" type="button" class="menu_button">${t('common.refresh')}</button>
                                </div>
                            </div>
                            <div class="cvt-card-body" data-cvt-section="cm_groups">
                                <div id="cvm_groups_list" class="cvt-list">
                                    <div class="cvt-empty">${t('common.loading')}</div>
                                </div>
                            </div>
                        </div>

                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('characterMerge.archives.heading')}</strong>
                                <div class="cvt-section-head-actions">${buildSectionToggle('cm_archives')}</div>
                            </div>
                            <div class="${getCardBodyClass('cm_archives')}" data-cvt-section="cm_archives">
                                <p class="cvt-note">${t('characterMerge.archives.intro')}</p>
                                <div id="cvm_archives_list" class="cvt-list">
                                    <div class="cvt-empty">${t('common.loading')}</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div id="cvm_wizard_view" class="cvm-view" hidden>
                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong id="cvm_wizard_step_title">${t('characterMerge.wizard.step1.title')}</strong>
                                <div class="cvt-section-head-actions">
                                    <span id="cvm_wizard_progress" class="cvt-summary">1 / 5</span>
                                </div>
                            </div>
                            <div class="cvt-card-body">
                                <div id="cvm_wizard_content" class="cvm-wizard-content"></div>
                                <div class="cvt-toolbar cvm-wizard-actions">
                                    <button id="cvm_wizard_back" type="button" class="menu_button" hidden>${t('characterMerge.wizard.back')}</button>
                                    <button id="cvm_wizard_cancel" type="button" class="menu_button">${t('characterMerge.wizard.cancel')}</button>
                                    <button id="cvm_wizard_next" type="button" class="menu_button">${t('characterMerge.wizard.next')}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="cvt-page" data-cvt-page="settings">
                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('settings.theme')}</strong>
                            <div class="cvt-section-head-actions">
                                <span class="cvt-hint">${t('settings.themeHint')}</span>
                                ${buildSectionToggle('settings_theme')}
                            </div>
                        </div>
                        <div class="${getCardBodyClass('settings_theme')}" data-cvt-section="settings_theme">
                            <div class="cvt-theme-grid">${buildThemeButtons()}</div>
                            <div class="cvt-note">${t('settings.themeNote')}</div>
                        </div>
                    </div>

                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('settings.behaviorTitle')}</strong>
                            <div class="cvt-section-head-actions">
                                ${buildSectionToggle('settings_behavior')}
                            </div>
                        </div>
                        <div class="${getCardBodyClass('settings_behavior')}" data-cvt-section="settings_behavior">
                            <label class="cvt-check-row">
                                <input type="checkbox" id="cvt_enabled">
                                <span>${t('settings.autoBackup')}</span>
                            </label>
                            <label class="cvt-check-row">
                                <input type="checkbox" id="cvt_show_recovery_toast">
                                <span>${t('settings.showRecoveryToast')}</span>
                            </label>
                            <div class="cvt-note">${t('settings.triggerNote')}</div>
                            <div class="cvt-note">${t('settings.behaviorNote')}</div>
                        </div>
                    </div>

                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('settings.advancedTitle')}</strong>
                            <div class="cvt-section-head-actions">
                                ${buildSectionToggle('settings_advanced')}
                            </div>
                        </div>
                        <div class="${getCardBodyClass('settings_advanced', { scroll: true })}" data-cvt-section="settings_advanced">
                            <div class="cvt-grid-2">
                                <label class="cvt-field">
                                    <span>${t('settings.autoBackupCount')}</span>
                                    <input id="cvt_auto_slots" class="text_pole" inputmode="numeric" type="number" min="1" max="100">
                                    <small>${t('settings.autoBackupCountHint')}</small>
                                </label>

                                <label class="cvt-field">
                                    <span>${t('settings.saveDelay')}</span>
                                    <input id="cvt_save_delay" class="text_pole" inputmode="numeric" type="number" min="50" max="3000">
                                    <small>${t('settings.saveDelayHint')}</small>
                                </label>

                                <label class="cvt-field">
                                    <span>${t('settings.draftDelay')}</span>
                                    <input id="cvt_draft_delay" class="text_pole" inputmode="numeric" type="number" min="50" max="3000">
                                    <small>${t('settings.draftDelayHint')}</small>
                                </label>

                                <label class="cvt-field">
                                    <span>${t('settings.restoreTemplate')}</span>
                                    <input id="cvt_restore_name_template" class="text_pole" type="text">
                                    <small>${t('settings.restoreTemplateHint')}</small>
                                </label>
                            </div>

                            <label class="cvt-field" style="margin-top:10px;">
                                <span>${t('settings.snapshotTemplate')}</span>
                                <input id="cvt_snapshot_file_template" class="text_pole" type="text">
                                <small>${t('settings.snapshotTemplateHint')}</small>
                            </label>
                            <div class="cvt-note">${t('settings.namingNote')}</div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    `;
}

function setActivePanelTab(tabName = 'chat') {
    document.querySelectorAll('.cvt-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.cvtTab === tabName);
    });
    document.querySelectorAll('.cvt-page').forEach((page) => {
        page.classList.toggle('active', page.dataset.cvtPage === tabName);
    });

    if (tabName === 'cloud') {
        const body = document.getElementById(PANEL_IDS.modal)?.querySelector('.cvt-body');
        if (body) {
            body.scrollTop = 0;
        }
    }
}

function openPanel(tabName = 'chat') {
    const overlay = document.getElementById(PANEL_IDS.overlay);
    if (!overlay) {
        return;
    }

    if (tabName === 'chat' && activeScopeOverride) {
        activeScopeOverride = null;
        updateScopeToolbarState();
        void refreshStatus({ quiet: true });
    }

    setActivePanelTab(tabName);
    if (!overlay.open) {
        if (typeof overlay.showModal === 'function') {
            try {
                overlay.showModal();
            } catch (error) {
                console.warn('[chat-vault] Failed to open main panel dialog:', error);
                overlay.setAttribute('open', '');
            }
        } else {
            overlay.setAttribute('open', '');
        }
    }

    if (tabName === 'recovery') {
        void refreshRecoveryScopes({ quiet: true });
    } else if (tabName === 'cloud') {
        void (async () => {
            await refreshCloudStatus({ quiet: true });
            await refreshCloudScopes({ quiet: true });
        })();
    }
}

function closePanel() {
    const overlay = document.getElementById(PANEL_IDS.overlay);
    if (overlay?.open && typeof overlay.close === 'function') {
        overlay.close();
        return;
    }
    if (overlay) {
        overlay.removeAttribute('open');
    }
}

function applyTheme(themeId = 'auto') {
    const modal = document.getElementById(PANEL_IDS.modal);
    const trigger = document.getElementById(PANEL_IDS.trigger);
    currentThemeId = Object.hasOwn(THEMES, themeId) ? themeId : 'auto';
    const palette = THEMES[currentThemeId];
    const vars = {
        '--cvt-bg': palette.bg,
        '--cvt-surface': palette.surface,
        '--cvt-field': palette.fieldBg,
        '--cvt-border': palette.border,
        '--cvt-text': palette.text,
        '--cvt-dim': palette.dim,
        '--cvt-accent': palette.accent,
        '--cvt-accent-soft': palette.accentSoft,
    };

    if (modal) {
        Object.entries(vars).forEach(([key, value]) => {
            modal.style.setProperty(key, value);
        });
    }

    if (trigger) {
        trigger.style.background = palette.bg;
        trigger.style.borderColor = palette.border;
        trigger.style.color = palette.text;
        trigger.style.boxShadow = '0 6px 20px rgba(0,0,0,.35)';
    }

    if (cloudRepositoryDialog) {
        copyCloudThemeToDialog(cloudRepositoryDialog);
    }

    document.querySelectorAll('.cvt-theme-btn').forEach((button) => {
        button.classList.toggle('active', button.dataset.theme === currentThemeId);
    });
}

function setTriggerVisible(visible) {
    const trigger = document.getElementById(PANEL_IDS.trigger);
    if (trigger) {
        trigger.style.display = visible ? 'flex' : 'none';
    }
}

function makeTriggerDraggable(element, onClick) {
    let dragged = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    element.addEventListener('pointerdown', (event) => {
        dragged = false;
        startX = event.clientX;
        startY = event.clientY;
        const rect = element.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        element.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    element.addEventListener('pointermove', (event) => {
        if (!element.hasPointerCapture(event.pointerId)) {
            return;
        }

        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
            dragged = true;
        }

        if (!dragged) {
            return;
        }

        element.dataset.cvtDragged = '1';
        element.style.transform = 'none';
        element.style.left = `${startLeft + deltaX}px`;
        element.style.top = `${startTop + deltaY}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
    });

    element.addEventListener('pointerup', (event) => {
        element.releasePointerCapture(event.pointerId);
        if (!dragged && onClick) {
            onClick();
        }
    });
}

function resolveMobileTriggerTop() {
    const topBar = document.querySelector('.top-settings-holder') || document.querySelector('#top-bar');
    if (topBar && typeof topBar.getBoundingClientRect === 'function') {
        return `${Math.max(78, Math.round(topBar.getBoundingClientRect().bottom) + 12)}px`;
    }

    return '88px';
}

function positionTrigger(trigger, { force = false } = {}) {
    if (!trigger) {
        return;
    }

    if (!force && trigger.dataset.cvtDragged === '1') {
        return;
    }

    const isMobile = globalThis.matchMedia?.('(max-width: 720px)')?.matches || globalThis.innerWidth <= 720;
    trigger.style.left = 'auto';
    trigger.style.transform = 'none';

    if (isMobile) {
        trigger.style.top = resolveMobileTriggerTop();
        trigger.style.right = 'max(12px, env(safe-area-inset-right, 0px))';
        trigger.style.bottom = 'auto';
        return;
    }

    trigger.style.top = 'auto';
    trigger.style.right = '18px';
    trigger.style.bottom = '84px';
}

function buildAndMountFloatingUi() {
    if (document.getElementById(PANEL_IDS.overlay)) {
        return;
    }

    currentThemeId = getSettings().themeId || 'auto';
    const trigger = document.createElement('div');
    trigger.id = PANEL_IDS.trigger;
    trigger.className = 'cvt-trigger';
    trigger.innerHTML = '<div class="cvt-trigger-core"><i class="fa-solid fa-clock-rotate-left"></i></div>';
    document.body.appendChild(trigger);
    positionTrigger(trigger, { force: true });
    makeTriggerDraggable(trigger, () => openPanel('chat'));

    const overlay = document.createElement('dialog');
    overlay.id = PANEL_IDS.overlay;
    overlay.className = 'cvt-overlay';
    overlay.innerHTML = buildPanelHtml();
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            // Don't close mid-wizard — accidental clicks outside the card area
            // would otherwise discard the merge picks.
            if (cvmState.primary !== null && cvmState.step < 5) {
                return;
            }
            closePanel();
        }
    });
    overlay.addEventListener('cancel', (event) => {
        if (cvmState.primary !== null && cvmState.step < 5) {
            event.preventDefault();
        }
    });

    document.getElementById(PANEL_IDS.close)?.addEventListener('click', closePanel);

    const reposition = () => positionTrigger(trigger);
    globalThis.addEventListener?.('resize', reposition);
    globalThis.addEventListener?.('orientationchange', reposition);
    applyTheme(getSettings().themeId || 'auto');
}

function hashText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function createSeriesKey(prefix = 'auto') {
    const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    return `${prefix}-${Date.now()}-${random}`;
}

function buildTurnAnchor(message, index) {
    if (!message || typeof message !== 'object' || !message.is_user) {
        return null;
    }

    return {
        index,
        sendDate: String(message.send_date || ''),
        name: String(message.name || ''),
        textHash: hashText(message.mes || ''),
    };
}

function getLatestUserTurnAnchor({ preferredIndex = null, searchFrom = null } = {}) {
    const messages = Array.isArray(getContext()?.chat) ? getContext().chat : [];
    if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < messages.length) {
        const preferredAnchor = buildTurnAnchor(messages[preferredIndex], preferredIndex);
        if (preferredAnchor) {
            return preferredAnchor;
        }
    }

    const startIndex = Number.isInteger(searchFrom)
        ? Math.min(Math.max(searchFrom, 0), messages.length - 1)
        : (messages.length - 1);
    for (let index = startIndex; index >= 0; index -= 1) {
        const anchor = buildTurnAnchor(messages[index], index);
        if (anchor) {
            return anchor;
        }
    }

    return null;
}

function buildTurnSeriesKey(trigger, messageId = null) {
    if (trigger !== 'message_sent' && trigger !== 'message_received' && trigger !== 'message_swiped') {
        return '';
    }

    const source = buildSource();
    const numericMessageId = Number.isInteger(messageId) ? messageId : Number(messageId);
    const anchor = trigger === 'message_sent'
        ? getLatestUserTurnAnchor({ preferredIndex: numericMessageId })
        : getLatestUserTurnAnchor({ searchFrom: Number.isFinite(numericMessageId) ? numericMessageId - 1 : null });
    if (!source || !anchor) {
        return '';
    }

    const stableSeed = JSON.stringify({
        kind: source.kind,
        chatId: source.chatId,
        groupId: source.groupId,
        anchor,
    });
    return `turn-${hashText(stableSeed)}`;
}

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

function ensureSettings() {
    const stored = extension_settings[SETTINGS_KEY];
    const autoSlotCount = Number.isFinite(Number(stored?.autoSlotCount))
        ? Number(stored.autoSlotCount)
        : (Number.isFinite(Number(stored?.maxAutoSnapshots)) ? Number(stored.maxAutoSnapshots) : 1);
    extension_settings[SETTINGS_KEY] = {
        ...DEFAULT_SETTINGS,
        ...(stored && typeof stored === 'object' ? stored : {}),
        autoSlotCount,
        collapsedSections: stored?.collapsedSections && typeof stored.collapsedSections === 'object'
            ? stored.collapsedSections
            : {},
    };
    // Sections that should be collapsed by default on first visit. The user
    // can still expand them; once expanded, the saved value (false) wins.
    const settings = extension_settings[SETTINGS_KEY];
    if (settings.collapsedSections.cm_archives === undefined) {
        settings.collapsedSections.cm_archives = true;
    }
    return settings;
}

function getSettings() {
    return ensureSettings();
}

function cloneJson(value, fallback = {}) {
    try {
        return JSON.parse(JSON.stringify(value ?? fallback));
    } catch {
        return fallback;
    }
}

function truncate(text, maxLength = 140) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatDateTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) {
        return t('common.unknownTime');
    }

    try {
        return new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(new Date(timestamp));
    } catch {
        return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
    }
}

function formatDateSlug(value) {
    const date = new Date(Number(value) || Date.now());
    const pad = (number) => String(number).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join('-') + ' ' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function sanitizeNamePart(value) {
    return String(value ?? '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
}

function applyRestoreNameTemplate(template, source, entry) {
    const rawTemplate = String(template || DEFAULT_SETTINGS.restoreNameTemplate);
    const replacements = {
        chat: source?.chatId || '',
        character: source?.characterName || '',
        group: source?.groupName || '',
        name: source?.currentName || source?.characterName || source?.groupName || source?.chatId || '',
        trigger: getTriggerDisplayLabel(entry?.trigger || entry?.triggerLabel),
        time: formatDateSlug(entry?.createdAt || Date.now()),
    };

    return rawTemplate.replace(/{{\s*([a-z_]+)\s*}}/gi, (match, key) => {
        return Object.hasOwn(replacements, key) ? replacements[key] : match;
    });
}

function buildSource() {
    const context = getContext();
    if (!context?.chatId) {
        return null;
    }

    const isGroup = Boolean(context.groupId);
    const character = !isGroup && context.characterId !== undefined
        ? context.characters?.[context.characterId]
        : null;
    const group = isGroup
        ? context.groups?.find((item) => String(item.id) === String(context.groupId))
        : null;

    return {
        kind: isGroup ? 'group' : 'character',
        chatId: String(context.chatId),
        groupId: isGroup ? String(context.groupId) : '',
        avatarUrl: character?.avatar || '',
        characterName: character?.name || context.name2 || '',
        groupName: group?.name || '',
        userName: context.name1 || 'unused',
        currentName: isGroup
            ? (group?.name || String(context.chatId))
            : (character?.name || context.name2 || String(context.chatId)),
    };
}

function areSourcesEquivalent(left, right) {
    if (!left || !right) {
        return false;
    }

    const leftScopeKey = String(left.scopeKey || '').trim();
    const rightScopeKey = String(right.scopeKey || '').trim();
    if (leftScopeKey || rightScopeKey) {
        return Boolean(leftScopeKey && rightScopeKey && leftScopeKey === rightScopeKey);
    }

    return String(left.kind || '') === String(right.kind || '')
        && String(left.chatId || '') === String(right.chatId || '')
        && String(left.groupId || '') === String(right.groupId || '')
        && String(left.avatarUrl || '') === String(right.avatarUrl || '');
}

function getStatusSource() {
    return activeScopeOverride || buildSource();
}

function getActionSource() {
    return statusCache?.source || activeScopeOverride || buildSource();
}

function encodeDataJson(value) {
    try {
        return encodeURIComponent(JSON.stringify(value || {}));
    } catch {
        return '';
    }
}

function decodeDataJson(value) {
    try {
        return JSON.parse(decodeURIComponent(String(value || '')));
    } catch {
        return null;
    }
}

function getScopeDisplayLabel(source) {
    if (!source) {
        return t('common.unknownChat');
    }

    return source.kind === 'group'
        ? (source.groupName || source.currentName || source.chatId || t('common.unnamedGroup'))
        : (source.characterName || source.currentName || source.chatId || t('common.unnamedChat'));
}

function updateScopeToolbarState() {
    const backButton = document.getElementById('cvt_back_to_chat');
    if (backButton) {
        backButton.hidden = !activeScopeOverride;
    }
}

function findCharacterIdBySource(source) {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    if (!characters.length || source?.kind !== 'character') {
        return -1;
    }

    let index = characters.findIndex((character) => {
        return character && String(character.avatar || '') === String(source.avatarUrl || '');
    });
    if (index >= 0) {
        return index;
    }

    index = characters.findIndex((character) => {
        return character && String(character.name || '') === String(source.characterName || '');
    });
    return index;
}

function findGroupIdBySource(source) {
    const context = getContext();
    const groups = Array.isArray(context?.groups) ? context.groups : [];
    if (!groups.length || source?.kind !== 'group') {
        return '';
    }

    let match = groups.find((group) => {
        return group && String(group.id || '') === String(source.groupId || '');
    });
    if (!match) {
        match = groups.find((group) => {
            return group && String(group.name || '') === String(source.groupName || '');
        });
    }

    return match ? String(match.id || '') : '';
}

function stripJsonlExtension(value) {
    return String(value ?? '').replace(/\.jsonl$/i, '').trim();
}

function buildRenameBridgeSource(chatId, requestInfo = {}) {
    const context = getContext();
    const currentSource = buildSource();
    const isGroup = Boolean(requestInfo.isGroup);
    const currentChatId = String(chatId || '').trim();
    const group = isGroup
        ? context?.groups?.find((item) => String(item.id) === String(currentSource?.groupId || context?.groupId || ''))
        : null;
    const character = !isGroup && context?.characterId !== undefined
        ? context.characters?.[context.characterId]
        : null;

    return {
        kind: isGroup ? 'group' : 'character',
        chatId: currentChatId,
        groupId: isGroup ? String(currentSource?.groupId || context?.groupId || '') : '',
        avatarUrl: String(requestInfo.avatarUrl || currentSource?.avatarUrl || character?.avatar || ''),
        characterName: isGroup ? '' : String(currentSource?.characterName || character?.name || context?.name2 || ''),
        groupName: isGroup ? String(currentSource?.groupName || group?.name || '') : '',
        userName: String(currentSource?.userName || context?.name1 || 'unused'),
        currentName: isGroup
            ? String(currentSource?.groupName || group?.name || currentChatId || 'group')
            : String(currentSource?.characterName || character?.name || context?.name2 || currentChatId || 'character'),
    };
}

function getFetchUrl(input) {
    if (typeof input === 'string') {
        return input;
    }

    if (input instanceof URL) {
        return String(input);
    }

    if (input && typeof input.url === 'string') {
        return input.url;
    }

    return '';
}

function parseRenameRequest(input, init) {
    const url = getFetchUrl(input);
    if (!url.includes('/api/chats/rename')) {
        return null;
    }

    if (typeof init?.body !== 'string') {
        return null;
    }

    try {
        const body = JSON.parse(init.body);
        const oldChatId = stripJsonlExtension(body?.original_file);
        const requestedNewChatId = stripJsonlExtension(body?.renamed_file);
        if (!oldChatId || !requestedNewChatId) {
            return null;
        }

        return {
            isGroup: Boolean(body?.is_group),
            avatarUrl: String(body?.avatar_url || ''),
            oldChatId,
            requestedNewChatId,
        };
    } catch {
        return null;
    }
}

async function syncRenamedChatScope(renameRequest, response) {
    let nextChatId = renameRequest.requestedNewChatId;
    try {
        const data = await response.clone().json();
        nextChatId = stripJsonlExtension(data?.sanitizedFileName || nextChatId);
    } catch {
        nextChatId = renameRequest.requestedNewChatId;
    }

    if (!nextChatId || nextChatId === renameRequest.oldChatId) {
        return;
    }

    const oldSource = buildRenameBridgeSource(renameRequest.oldChatId, renameRequest);
    const newSource = buildRenameBridgeSource(nextChatId, renameRequest);
    if (!oldSource.chatId || !newSource.chatId) {
        return;
    }

    await callApi('/scope/rebind-chat', {
        oldSource,
        newSource,
    });
}

function installRenameBridge() {
    if (renameBridgeInstalled) {
        return;
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const renameRequest = parseRenameRequest(input, init);
        const response = await nativeFetch(input, init);

        if (renameRequest && response.ok) {
            try {
                await syncRenamedChatScope(renameRequest, response);
            } catch (error) {
                console.error('[chat-vault] Failed to sync renamed chat scope:', error);
            }
        }

        return response;
    };

    renameBridgeInstalled = true;
}

function getHeaders({ json = true, headers = {} } = {}) {
    const context = getContext();
    const mergedHeaders = {
        ...(context?.getRequestHeaders ? context.getRequestHeaders() : {}),
        ...(headers && typeof headers === 'object' ? headers : {}),
    };
    if (json) {
        mergedHeaders['Content-Type'] = 'application/json';
    }
    if (csrfOverrideToken) {
        mergedHeaders['X-CSRF-Token'] = csrfOverrideToken;
    }
    return mergedHeaders;
}

function isInvalidCsrfError(status, text = '') {
    return Number(status) === 403 && /invalid csrf token/i.test(String(text || ''));
}

async function refreshCsrfToken() {
    if (csrfRefreshPromise) {
        return csrfRefreshPromise;
    }

    csrfRefreshPromise = (async () => {
        const response = await fetch('/csrf-token', {
            method: 'GET',
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(response.statusText || 'failed_to_refresh_csrf_token');
        }

        const data = await response.json();
        const token = String(data?.token || '').trim();
        if (!token) {
            throw new Error('failed_to_refresh_csrf_token');
        }

        csrfOverrideToken = token;
        return token;
    })().finally(() => {
        csrfRefreshPromise = null;
    });

    return csrfRefreshPromise;
}

async function fetchWithCsrfRetry(url, init = {}, { expectJson = false } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(url, {
            cache: 'no-cache',
            ...init,
            headers: getHeaders({
                json: Boolean(init.body),
                headers: init.headers || {},
            }),
        });

        if (response.ok) {
            if (!expectJson) {
                return response;
            }

            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                return response.json();
            }
            return {};
        }

        const text = await response.text();
        lastError = new Error(text || response.statusText || 'Request failed');
        lastError.status = response.status;

        if (attempt === 0 && isInvalidCsrfError(response.status, text)) {
            await refreshCsrfToken();
            continue;
        }

        throw lastError;
    }

    throw lastError || new Error('Request failed');
}

async function callApi(path, body = {}) {
    return fetchWithCsrfRetry(`${API_ROOT}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
    }, { expectJson: true });
}

function setBackendStatus(text, kind = 'idle') {
    const badges = [
        document.getElementById('cvt_backend_status'),
        document.getElementById('cvt_sidebar_backend_status'),
    ].filter(Boolean);

    for (const badge of badges) {
        badge.textContent = text;
        badge.dataset.kind = kind;
    }
}

function renderDraftCard(draft) {
    const card = document.getElementById('cvt_draft_card');
    const meta = document.getElementById('cvt_draft_meta');
    const preview = document.getElementById('cvt_draft_preview');
    if (!card || !meta || !preview) {
        return;
    }

    if (!draft?.text?.trim()) {
        card.hidden = true;
        preview.textContent = '';
        return;
    }

    const kindLabel = draft.kind === 'reasoning' ? t('draft.reasoning') : t('draft.message');
    meta.textContent = t('draft.meta', {
        kind: kindLabel,
        messageId: draft.messageId,
        time: formatDateTime(draft.updatedAt),
    });
    preview.textContent = truncate(draft.text, 220);
    card.hidden = false;
}

function buildCheckpointItem(entry, { allowOverwrite = true, actionList = null } = {}) {
    const item = document.createElement('div');
    item.className = 'cvt-item';
    item.dataset.snapshotId = entry.id;

    const title = document.createElement('div');
    title.className = 'cvt-item-title';
    title.textContent = String(entry.customName || '').trim() || formatDateTime(entry.createdAt);

    const tags = document.createElement('div');
    tags.className = 'cvt-item-tags';

    const triggerTag = document.createElement('span');
    triggerTag.className = 'cvt-tag';
    triggerTag.textContent = entry.mode === 'auto'
        ? t('tags.autoBackup')
        : getTriggerDisplayLabel(entry.trigger || entry.triggerLabel);
    tags.appendChild(triggerTag);

    if (entry.pinned) {
        const pinnedTag = document.createElement('span');
        pinnedTag.className = 'cvt-tag cvt-tag-pinned';
        pinnedTag.textContent = t('tags.keep');
        tags.appendChild(pinnedTag);
    }

    const resourceSummary = entry.resourceSummary && typeof entry.resourceSummary === 'object' ? entry.resourceSummary : null;
    if (resourceSummary?.characterCardCount > 0) {
        const tag = document.createElement('span');
        tag.className = 'cvt-tag cvt-tag-cloud-resource';
        tag.textContent = t('cloud.tags.characterCards', { count: resourceSummary.characterCardCount });
        tags.appendChild(tag);
    }
    if (resourceSummary?.personaAvatarCount > 0 || resourceSummary?.personaProfileCount > 0) {
        const tag = document.createElement('span');
        tag.className = 'cvt-tag cvt-tag-cloud-resource';
        tag.textContent = t('cloud.tags.personas', { count: Math.max(resourceSummary.personaAvatarCount || 0, resourceSummary.personaProfileCount || 0) });
        tags.appendChild(tag);
    }
    if (resourceSummary?.worldInfoCount > 0) {
        const tag = document.createElement('span');
        tag.className = 'cvt-tag cvt-tag-cloud-resource';
        tag.textContent = t('cloud.tags.worlds', { count: resourceSummary.worldInfoCount });
        tags.appendChild(tag);
    }
    if (resourceSummary?.groupDefinitionCount > 0) {
        const tag = document.createElement('span');
        tag.className = 'cvt-tag cvt-tag-cloud-resource';
        tag.textContent = t('cloud.tags.groups', { count: resourceSummary.groupDefinitionCount });
        tags.appendChild(tag);
    }
    if (Array.isArray(entry.sourceDeviceNames) && entry.sourceDeviceNames.length > 0) {
        const tag = document.createElement('span');
        tag.className = 'cvt-tag cvt-tag-cloud-device';
        tag.textContent = t('cloud.tags.sourceDevice', {
            names: entry.sourceDeviceNames.join(' / '),
        });
        tags.appendChild(tag);
    }
    if (entry.repositoryName) {
        const tag = document.createElement('span');
        tag.className = 'cvt-tag cvt-tag-cloud-device';
        tag.textContent = t('cloud.tags.repository', { name: entry.repositoryName });
        tags.appendChild(tag);
    }

    const meta = document.createElement('div');
    meta.className = 'cvt-item-meta';
    const metaParts = [];
    if (entry.customName) {
        metaParts.push(formatDateTime(entry.createdAt));
    }
    if (entry.lastMessageName) {
        metaParts.push(entry.lastMessageName);
    }
    metaParts.push(t('labels.messageCount', { count: entry.messageCount }));
    if (resourceSummary?.totalCount > 0) {
        metaParts.push(t('cloud.labels.resourceCount', { count: resourceSummary.totalCount }));
    }
    meta.textContent = metaParts.join(' · ');

    const preview = document.createElement('div');
    preview.className = 'cvt-item-preview';
    preview.textContent = entry.lastMessagePreview || t('chat.emptyNoPreview');

    const actions = document.createElement('div');
    actions.className = 'cvt-item-actions';

    const defaultActionList = [
        { action: 'preview', text: t('common.preview') },
        { action: 'rename', text: t('common.rename') },
        { action: 'restore-new', text: t('actions.restoreNew') },
        { action: 'pin', text: entry.pinned ? t('actions.keepOff') : t('actions.keepOn') },
        { action: 'delete', text: t('common.delete'), danger: true },
    ];

    if (allowOverwrite) {
        defaultActionList.splice(3, 0, { action: 'overwrite', text: t('actions.overwriteCurrent'), danger: true });
    }

    for (const action of (actionList || defaultActionList)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = action.danger ? 'menu_button cvt-danger' : 'menu_button';
        button.dataset.action = action.action;
        button.dataset.snapshotId = entry.id;
        if (entry.repositoryId) {
            button.dataset.repositoryId = entry.repositoryId;
        }
        button.dataset.source = encodeDataJson(entry.source || statusCache?.source || activeScopeOverride || buildSource());
        button.textContent = action.text;
        actions.appendChild(button);
    }

    item.appendChild(title);
    item.appendChild(tags);
    item.appendChild(meta);
    item.appendChild(preview);
    item.appendChild(actions);
    return item;
}

function filterCheckpointEntries(entries, keyword = '') {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) {
        return Array.isArray(entries) ? entries : [];
    }

    return (Array.isArray(entries) ? entries : []).filter((entry) => {
        const haystack = [
            entry?.customName,
            entry?.lastMessagePreview,
            entry?.lastMessageName,
            entry?.trigger,
            entry?.triggerLabel,
            entry?.label,
            entry?.source?.chatId,
            entry?.source?.characterName,
            entry?.source?.groupName,
            ...(Array.isArray(entry?.sourceDeviceNames) ? entry.sourceDeviceNames : []),
        ].join('\n').toLowerCase();
        return haystack.includes(normalizedKeyword);
    });
}

function setSectionCollapsed(sectionKey, collapsed) {
    const settings = ensureSettings();
    settings.collapsedSections = settings.collapsedSections && typeof settings.collapsedSections === 'object'
        ? settings.collapsedSections
        : {};
    settings.collapsedSections[sectionKey] = Boolean(collapsed);
    getContext()?.saveSettingsDebounced?.();

    const body = document.querySelector(`.cvt-card-body[data-cvt-section="${sectionKey}"]`);
    const toggle = document.querySelector(`.cvt-section-toggle[data-cvt-toggle-section="${sectionKey}"]`);
    if (body) {
        body.classList.toggle('is-collapsed', Boolean(collapsed));
    }
    if (toggle) {
        const label = collapsed ? t('common.expand') : t('common.collapse');
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute('aria-label', label);
        toggle.setAttribute('title', label);
        toggle.innerHTML = `<span class="cvt-section-toggle-icon" aria-hidden="true">${collapsed ? '&#9656;' : '&#9662;'}</span>`;
    }
}

function setCloudToolbarBusyState(isBusy) {
    cloudToolbarBusy = Boolean(isBusy);
    const buttonIds = [
        'cvt_cloud_sync',
        'cvt_cloud_refresh',
        'cvt_cloud_manage',
    ];

    for (const id of buttonIds) {
        const button = document.getElementById(id);
        if (!button) {
            continue;
        }
        button.disabled = cloudToolbarBusy;
        button.classList.toggle('cvt-button-busy', cloudToolbarBusy);
    }
}

function renderCheckpointListInto(containerId, entries, { allowOverwrite = true, emptyText = t('status.currentEmpty'), actionList = null } = {}) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    container.innerHTML = '';
    if (!entries?.length) {
        const empty = document.createElement('div');
        empty.className = 'cvt-empty';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
    }

    for (const entry of entries) {
        container.appendChild(buildCheckpointItem(entry, { allowOverwrite, actionList }));
    }
}

function renderCurrentStatus(status) {
    const summary = document.getElementById('cvt_current_summary');
    const searchKeyword = String(document.getElementById('cvt_checkpoint_search')?.value || '').trim();
    const filteredEntries = filterCheckpointEntries(status?.entries || [], searchKeyword);
    if (summary) {
        if (status?.unavailable) {
            summary.textContent = t('status.currentUnavailable');
        } else if (!status?.source?.chatId) {
            summary.textContent = t('status.currentNoChat');
        } else if (!filteredEntries.length) {
            summary.textContent = searchKeyword ? t('chat.searchEmpty') : t('status.currentEmpty');
        } else {
            const latest = filteredEntries[0];
            summary.textContent = t('status.currentLatest', {
                time: formatDateTime(latest.createdAt),
                trigger: getTriggerDisplayLabel(latest.trigger || latest.triggerLabel),
                count: latest.messageCount,
            });
        }
    }

    renderDraftCard(status?.draft || null);

    if (status?.unavailable) {
        const container = document.getElementById('cvt_checkpoint_list');
        if (container) {
            container.innerHTML = `<div class="cvt-empty">${t('status.currentUnavailable')}</div>`;
        }
        return;
    }

    if (!status?.source?.chatId) {
        renderCheckpointListInto('cvt_checkpoint_list', [], {
            emptyText: t('status.currentNoChat'),
            allowOverwrite: false,
        });
        return;
    }

    renderCheckpointListInto('cvt_checkpoint_list', filteredEntries, {
        allowOverwrite: true,
        emptyText: searchKeyword ? t('chat.searchEmpty') : t('status.currentEmpty'),
    });
}

function renderRecoveryStatus(status) {
    const summary = document.getElementById('cvt_recovery_summary');
    const selectedSource = status?.source || activeScopeOverride;
    const searchKeyword = String(document.getElementById('cvt_recovery_checkpoint_search')?.value || '').trim();
    const filteredEntries = filterCheckpointEntries(status?.entries || [], searchKeyword);

    if (summary) {
        if (!activeScopeOverride) {
            summary.textContent = t('status.recoveryIdle');
        } else if (status?.unavailable) {
            summary.textContent = t('status.recoveryUnavailable');
        } else if (!filteredEntries.length) {
            summary.textContent = t('status.recoveryEmpty', {
                label: getScopeDisplayLabel(selectedSource),
            });
        } else {
            const latest = filteredEntries[0];
            summary.textContent = t('status.recoveryLatest', {
                label: getScopeDisplayLabel(selectedSource),
                time: formatDateTime(latest.createdAt),
                trigger: getTriggerDisplayLabel(latest.trigger || latest.triggerLabel),
                count: latest.messageCount,
            });
        }
    }

    if (!activeScopeOverride) {
        renderCheckpointListInto('cvt_recovery_checkpoint_list', [], {
            allowOverwrite: false,
            emptyText: t('recovery.emptySelectFirst'),
        });
        return;
    }

    if (status?.unavailable) {
        const container = document.getElementById('cvt_recovery_checkpoint_list');
        if (container) {
            container.innerHTML = `<div class="cvt-empty">${t('status.recoveryUnavailable')}</div>`;
        }
        return;
    }

    renderCheckpointListInto('cvt_recovery_checkpoint_list', filteredEntries, {
        allowOverwrite: false,
        emptyText: searchKeyword ? t('recovery.backupSearchEmpty') : t('status.recoveryEmpty', {
            label: getScopeDisplayLabel(selectedSource),
        }),
    });
}

function renderStatus(status) {
    updateScopeToolbarState();
    if (activeScopeOverride) {
        renderRecoveryStatus(status);
        return;
    }

    renderCurrentStatus(status);
    renderRecoveryStatus(null);
}

function buildRecoveryScopeItem(scope) {
    const item = document.createElement('div');
    item.className = `cvt-scope-item${areSourcesEquivalent(activeScopeOverride, scope.source) ? ' is-active' : ''}`;
    item.dataset.scopeId = scope.scopeId;

    const title = document.createElement('div');
    title.className = 'cvt-scope-title';
    title.textContent = scope.label || getScopeDisplayLabel(scope.source);

    const meta = document.createElement('div');
    meta.className = 'cvt-scope-meta';
    const metaParts = [
        t('labels.chatBackupCount', { count: scope.entryCount || 0 }),
        t('labels.manualCount', { count: scope.manualCount || 0 }),
        t('labels.autoCount', { count: scope.autoCount || 0 }),
    ];
    if (Array.isArray(scope.chatIds) && scope.chatIds.length > 0) {
        metaParts.push(t('labels.chatAliasCount', { count: scope.chatIds.length }));
    }
    if (scope.updatedAt) {
        metaParts.push(t('labels.recentAt', { time: formatDateTime(scope.updatedAt) }));
    }
    meta.textContent = metaParts.join(' · ');

    const preview = document.createElement('div');
    preview.className = 'cvt-scope-preview';
    preview.textContent = scope.latestEntry?.lastMessagePreview
        || (Array.isArray(scope.chatIds) && scope.chatIds.length > 0 ? scope.chatIds.join('\n') : t('chat.emptyNoPreview'));

    const actions = document.createElement('div');
    actions.className = 'cvt-item-actions';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'menu_button';
    openButton.dataset.action = 'open-scope';
    openButton.dataset.scopeId = scope.scopeId;
    openButton.textContent = t('recovery.openScope');
    actions.appendChild(openButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'menu_button cvt-danger';
    deleteButton.dataset.action = 'delete-scope';
    deleteButton.dataset.scopeId = scope.scopeId;
    deleteButton.textContent = t('recovery.deleteScope');
    actions.appendChild(deleteButton);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(preview);
    item.appendChild(actions);
    return item;
}

function renderRecoveryScopeList() {
    const container = document.getElementById('cvt_scope_list');
    const searchInput = document.getElementById('cvt_scope_search');
    if (!container) {
        return;
    }

    const keyword = String(searchInput?.value || '').trim().toLowerCase();
    const scopes = recoveryScopeCache.filter((scope) => {
        if (!keyword) {
            return true;
        }

        const haystack = [
            scope.label,
            scope.source?.chatId,
            scope.source?.characterName,
            scope.source?.groupName,
            ...(Array.isArray(scope.chatIds) ? scope.chatIds : []),
        ].join('\n').toLowerCase();
        return haystack.includes(keyword);
    });

    container.innerHTML = '';
    if (!scopes.length) {
        const empty = document.createElement('div');
        empty.className = 'cvt-empty';
        empty.textContent = keyword ? t('recovery.emptyNoMatch') : t('recovery.emptyNoData');
        container.appendChild(empty);
        return;
    }

    for (const scope of scopes) {
        container.appendChild(buildRecoveryScopeItem(scope));
    }
}

async function refreshRecoveryScopes({ quiet = false } = {}) {
    const list = document.getElementById('cvt_scope_list');
    if (list) {
        list.innerHTML = `<div class="cvt-empty">${t('recovery.loadingList')}</div>`;
    }

    try {
        const result = await callApi('/scope/list', {});
        recoveryScopeCache = Array.isArray(result.scopes) ? result.scopes : [];
        renderRecoveryScopeList();
        renderRecoveryStatus(activeScopeOverride ? statusCache : null);
    } catch (error) {
        if (!quiet) {
            toastr.error(t('recovery.loadFailedToast'), getAppTitle());
        }
        console.error('[chat-vault] Failed to refresh recovery scopes:', error);
        if (list) {
            list.innerHTML = `<div class="cvt-empty">${t('recovery.loadFailed')}</div>`;
        }
    }
}

async function cleanupEmptyRecoveryScopes() {
    const result = await callApi('/scope/cleanup-empty', {});
    recoveryScopeCache = Array.isArray(result.scopes) ? result.scopes : [];
    if (activeScopeOverride) {
        const stillExists = recoveryScopeCache.some((scope) => areSourcesEquivalent(scope.source, activeScopeOverride));
        if (!stillExists) {
            activeScopeOverride = null;
        }
    }
    renderRecoveryScopeList();
    renderRecoveryStatus(activeScopeOverride ? statusCache : null);
    toastr.success(t('recovery.cleanupEmptyDone', { count: result.removedScopes || 0 }), getAppTitle());
}

async function deleteRecoveryScope(scopeId) {
    const scope = recoveryScopeCache.find((item) => String(item.scopeId || '') === String(scopeId || ''));
    if (!scope) {
        toastr.error(t('recovery.scopeNotFound'), getAppTitle());
        return;
    }

    const confirm = await Popup.show.confirm(
        t('popup.deleteScope.title'),
        t('popup.deleteScope.body', {
            label: scope.label || getScopeDisplayLabel(scope.source),
            count: scope.entryCount || 0,
        }),
    );
    if (!confirm) {
        return;
    }

    const result = await callApi('/scope/delete', { scopeId });
    recoveryScopeCache = Array.isArray(result.scopes) ? result.scopes : recoveryScopeCache.filter((item) => item.scopeId !== scopeId);
    if (activeScopeOverride && areSourcesEquivalent(activeScopeOverride, scope.source)) {
        activeScopeOverride = null;
        statusCache = null;
        renderRecoveryStatus(null);
    }
    renderRecoveryScopeList();
    toastr.success(t('recovery.deleteScopeDone'), getAppTitle());
}

async function openRecoveryScope(scopeId) {
    const scope = recoveryScopeCache.find((item) => item.scopeId === scopeId);
    if (!scope?.source) {
        toastr.error(t('recovery.scopeNotFound'), getAppTitle());
        return;
    }

    activeScopeOverride = scope.source;
    setActivePanelTab('recovery');
    renderRecoveryScopeList();
    await refreshStatus({ quiet: true });
}

function getActiveCloudScope() {
    return cloudManifestCache?.scopes?.find((scope) => String(scope.scopeId || '') === String(activeCloudScopeId || '')) || null;
}

function renderCloudStatus(config = null, manifest = null) {
    const summary = document.getElementById('cvt_cloud_summary');
    const repositories = Array.isArray(config?.repositories) ? config.repositories : [];
    if (!repositories.length || !config?.repoUrl) {
        if (summary) summary.textContent = t('cloud.status.missingConfig');
        renderCloudActionState(config, manifest);
        return;
    }

    if (!repositories.some((repository) => repository?.hasToken) && !config?.hasToken) {
        if (summary) summary.textContent = t('cloud.status.missingToken');
        renderCloudActionState(config, manifest);
        return;
    }

    const scopeCount = Number(manifest?.scopeCount || manifest?.scopes?.length || 0);
    const snapshotCount = Number(manifest?.snapshotCount || 0);
    const updatedAt = Number(manifest?.updatedAt || 0);
    const memberCount = repositories.length;
    const availableMemberCount = Number(manifest?.availableMemberCount || memberCount);

    if (!scopeCount) {
        if (summary) {
            summary.textContent = t('cloud.status.emptyRemote', {
                members: availableMemberCount,
                total: memberCount,
            });
        }
        renderCloudActionState(config, manifest);
        return;
    }

    if (Number(manifest?.failedMemberCount || 0) > 0) {
        if (summary) {
            summary.textContent = t('cloud.status.partial', {
                scopes: scopeCount,
                snapshots: snapshotCount,
                members: availableMemberCount,
                total: memberCount,
            });
        }
        renderCloudActionState(config, manifest);
        return;
    }

    if (summary) {
        summary.textContent = t('cloud.status.ready', {
            scopes: scopeCount,
            snapshots: snapshotCount,
            members: availableMemberCount,
            total: memberCount,
            time: updatedAt ? formatDateTime(updatedAt) : t('common.unknownTime'),
        });
    }
    renderCloudActionState(config, manifest);
}

function hasCloudConnectionConfig(config = null) {
    const repositories = Array.isArray(config?.repositories) ? config.repositories : [];
    return Boolean(
        repositories.length
        && config?.repoUrl
        && (config?.hasToken || repositories.some((repository) => repository?.hasToken)),
    );
}

function renderCloudActionState(config = null, manifest = null) {
    const hint = document.getElementById('cvt_cloud_action_hint');
    if (!hint) {
        return;
    }

    if (!hasCloudConnectionConfig(config)) {
        hint.textContent = t('cloud.actionHint.setup');
        return;
    }

    if (Number(manifest?.failedMemberCount || 0) > 0) {
        hint.textContent = t('cloud.actionHint.partial');
        return;
    }

    hint.textContent = t('cloud.actionHint.ready');
}

function getCloudCatalogRepository(config = null) {
    const repositories = Array.isArray(config?.repositories) ? config.repositories : [];
    return repositories.find((repository) => String(repository?.repositoryId || '') === String(config?.catalogRepositoryId || ''))
        || repositories[0]
        || null;
}

function getCloudMemberStatusLabel(member, status = null) {
    const state = String(status?.status || '').trim();
    if (state === 'failed') {
        return t('cloud.member.failed');
    }
    if (state === 'missing_token') {
        return t('cloud.member.missingToken');
    }
    if (member?.hasToken) {
        return t('cloud.member.ready');
    }
    return t('cloud.member.needsToken');
}

function getCloudMemberStatusMap() {
    return new Map((Array.isArray(cloudManifestCache?.members) ? cloudManifestCache.members : []).map((status) => [
        String(status?.repositoryId || ''),
        status,
    ]));
}

function getCloudMemberStatusKind(member, status = null) {
    const state = String(status?.status || '').trim();
    if (state === 'failed' || state === 'missing_token') {
        return 'error';
    }
    if (state === 'ready' || member?.hasToken) {
        return 'ok';
    }
    return 'idle';
}

function copyCloudThemeToDialog(dialog) {
    const modal = document.getElementById(PANEL_IDS.modal);
    if (!dialog || !modal) {
        return;
    }

    const styles = globalThis.getComputedStyle?.(modal);
    for (const property of ['--cvt-bg', '--cvt-surface', '--cvt-field', '--cvt-border', '--cvt-text', '--cvt-dim', '--cvt-accent', '--cvt-accent-soft']) {
        const value = styles?.getPropertyValue(property).trim();
        if (value) {
            dialog.style.setProperty(property, value);
        }
    }
}

function buildCloudManagerField({ id, label, value = '', type = 'text', placeholder = '', hint = '', disabled = cloudRepositoryDialogBusy }) {
    const field = document.createElement('label');
    field.className = 'cvt-field';

    const labelElement = document.createElement('span');
    labelElement.textContent = label;
    field.appendChild(labelElement);

    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.className = 'text_pole';
    input.value = String(value || '');
    input.placeholder = placeholder;
    input.disabled = disabled;
    field.appendChild(input);

    if (hint) {
        const hintElement = document.createElement('small');
        hintElement.textContent = hint;
        field.appendChild(hintElement);
    }

    return { field, input };
}

function buildCloudRepositoryRow(repository, { catalog = false, status = null } = {}) {
    const row = document.createElement('div');
    row.className = 'cvt-cloud-repository-row';

    const main = document.createElement('div');
    main.className = 'cvt-cloud-repository-main';

    const title = document.createElement('strong');
    title.textContent = catalog ? t('cloud.manager.catalog') : t('cloud.manager.member');
    const url = document.createElement('span');
    url.className = 'cvt-cloud-repository-url';
    url.textContent = repository.repositoryName || repository.repoUrl || t('cloud.member.new');
    const meta = document.createElement('span');
    meta.className = 'cvt-cloud-repository-meta';
    meta.textContent = t('cloud.manager.branchMeta', { branch: repository.branch || 'main' });
    main.append(title, url, meta);

    const actions = document.createElement('div');
    actions.className = 'cvt-cloud-repository-actions';
    const badge = document.createElement('span');
    badge.className = 'cvt-badge';
    badge.dataset.kind = getCloudMemberStatusKind(repository, status);
    badge.textContent = getCloudMemberStatusLabel(repository, status);
    actions.appendChild(badge);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'menu_button cvt-icon-button';
    edit.title = t('cloud.actions.editRepository');
    edit.setAttribute('aria-label', t('cloud.actions.editRepository'));
    edit.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>';
    edit.disabled = cloudRepositoryDialogBusy;
    edit.addEventListener('click', () => {
        cloudRepositoryEditor = {
            mode: 'edit',
            repositoryId: String(repository.repositoryId || ''),
            repoUrl: String(repository.repoUrl || ''),
            branch: String(repository.branch || 'main'),
            isCatalog: catalog,
            hasTokenOverride: Boolean(repository.hasTokenOverride),
            error: '',
        };
        renderCloudRepositoryDialog();
    });
    actions.appendChild(edit);

    row.append(main, actions);
    return row;
}

function getCloudRepositoryEditorTitle(editor) {
    if (editor.mode === 'create-catalog') {
        return t('cloud.manager.setupTitle');
    }
    if (editor.mode === 'create-member') {
        return t('cloud.manager.addTitle');
    }
    return editor.isCatalog ? t('cloud.manager.editCatalogTitle') : t('cloud.manager.editMemberTitle');
}

function getCloudRepositoryEditorAction(editor) {
    return editor.mode === 'create-member'
        ? t('cloud.actions.addAndConnect')
        : t('cloud.actions.saveAndConnect');
}

function captureCloudRepositoryEditor() {
    if (!cloudRepositoryEditor || !cloudRepositoryDialog) {
        return cloudRepositoryEditor;
    }

    const repoUrl = cloudRepositoryDialog.querySelector('#cvt_cloud_manager_repo_url');
    const branch = cloudRepositoryDialog.querySelector('#cvt_cloud_manager_branch');
    const token = cloudRepositoryDialog.querySelector('#cvt_cloud_manager_access_token');
    cloudRepositoryEditor = {
        ...cloudRepositoryEditor,
        repoUrl: String(repoUrl?.value || '').trim(),
        branch: String(branch?.value || '').trim() || 'main',
        githubToken: String(token?.value || '').trim(),
    };
    return cloudRepositoryEditor;
}

function getCloudConfigPayloadFromManager() {
    const config = cloudConfigCache && typeof cloudConfigCache === 'object' ? cloudConfigCache : {};
    const editor = captureCloudRepositoryEditor();
    const repositories = (Array.isArray(config.repositories) ? config.repositories : []).map((repository) => ({
        repositoryId: String(repository?.repositoryId || ''),
        repoUrl: String(repository?.repoUrl || '').trim(),
        branch: String(repository?.branch || '').trim() || 'main',
    }));
    const catalog = getCloudCatalogRepository(config);
    const editorRepository = editor ? {
        repositoryId: editor.mode === 'create-catalog' || editor.mode === 'create-member' ? '' : editor.repositoryId,
        repoUrl: String(editor.repoUrl || '').trim(),
        branch: String(editor.branch || '').trim() || 'main',
        ...(!editor.isCatalog && editor.githubToken ? { githubTokenOverride: editor.githubToken } : {}),
    } : null;

    if (editorRepository) {
        if (editor.mode === 'create-catalog' || editor.mode === 'create-member') {
            repositories.push(editorRepository);
        } else {
            const index = repositories.findIndex((repository) => repository.repositoryId === editor.repositoryId);
            if (index >= 0) {
                repositories[index] = editorRepository;
            }
        }
    }

    const deviceName = cloudRepositoryDialog?.querySelector('#cvt_cloud_manager_device_name');
    const syncPinned = cloudRepositoryDialog?.querySelector('#cvt_cloud_manager_sync_pinned');
    const syncLatest = cloudRepositoryDialog?.querySelector('#cvt_cloud_manager_sync_latest');
    const catalogToken = editor && (editor.mode === 'create-catalog' || editor.isCatalog)
        ? editor.githubToken
        : '';

    return {
        repositories,
        githubToken: catalogToken,
        deviceName: deviceName ? String(deviceName.value || '').trim() : String(config.deviceName || ''),
        syncPinned: syncPinned ? Boolean(syncPinned.checked) : config.syncPinned !== false,
        syncLatestStable: syncLatest ? Boolean(syncLatest.checked) : config.syncLatestStable !== false,
        catalogRepositoryId: catalog?.repositoryId || config.catalogRepositoryId || '',
    };
}

function buildCloudManagerEditor() {
    const editor = cloudRepositoryEditor;
    if (!editor) {
        return null;
    }

    const section = document.createElement('section');
    section.className = 'cvt-cloud-manager-editor';
    const heading = document.createElement('strong');
    heading.textContent = getCloudRepositoryEditorTitle(editor);
    section.appendChild(heading);

    const fields = document.createElement('div');
    fields.className = 'cvt-cloud-manager-fields';
    const url = buildCloudManagerField({
        id: 'cvt_cloud_manager_repo_url',
        label: t('cloud.fields.repoUrl'),
        value: editor.repoUrl,
        type: 'url',
        placeholder: 'https://github.com/owner/repo.git',
        hint: t('cloud.fields.repoUrlHint'),
    });
    fields.appendChild(url.field);

    const tokenIsCatalog = editor.mode === 'create-catalog' || editor.isCatalog;
    const token = buildCloudManagerField({
        id: 'cvt_cloud_manager_access_token',
        label: tokenIsCatalog ? t('cloud.fields.token') : t('cloud.fields.memberToken'),
        type: 'password',
        value: editor.githubToken,
        placeholder: tokenIsCatalog
            ? (cloudConfigCache?.hasDefaultToken || cloudConfigCache?.hasToken ? t('cloud.fields.tokenSaved') : t('cloud.fields.tokenPlaceholder'))
            : (editor.hasTokenOverride ? t('cloud.fields.memberTokenSaved') : t('cloud.fields.memberTokenPlaceholder')),
        hint: tokenIsCatalog
            ? (cloudConfigCache?.hasDefaultToken || cloudConfigCache?.hasToken ? t('cloud.fields.tokenHintSaved') : t('cloud.fields.tokenHint'))
            : t('cloud.fields.memberTokenHint'),
    });
    fields.appendChild(token.field);
    const branch = buildCloudManagerField({
        id: 'cvt_cloud_manager_branch',
        label: t('cloud.fields.branch'),
        value: editor.branch || 'main',
        placeholder: 'main',
        hint: t('cloud.fields.branchHint'),
    });
    fields.appendChild(branch.field);
    section.appendChild(fields);

    if (editor.error) {
        const error = document.createElement('div');
        error.className = 'cvt-cloud-manager-error';
        error.textContent = editor.error;
        section.appendChild(error);
    }

    const actions = document.createElement('div');
    actions.className = 'cvt-toolbar';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'menu_button cvt-cloud-primary';
    submit.textContent = getCloudRepositoryEditorAction(editor);
    submit.disabled = cloudRepositoryDialogBusy;
    submit.addEventListener('click', () => {
        void submitCloudRepositoryEditor();
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'menu_button';
    cancel.textContent = t('common.cancel');
    cancel.disabled = cloudRepositoryDialogBusy;
    cancel.addEventListener('click', () => {
        cloudRepositoryEditor = null;
        renderCloudRepositoryDialog();
    });
    actions.append(submit, cancel);
    section.appendChild(actions);
    return { section, urlInput: url.input };
}

function buildCloudManagerSettings() {
    const config = cloudConfigCache && typeof cloudConfigCache === 'object' ? cloudConfigCache : {};
    const section = document.createElement('section');
    section.className = 'cvt-cloud-manager-settings';
    const title = document.createElement('strong');
    title.textContent = t('cloud.manager.syncSettings');
    section.appendChild(title);

    const fields = document.createElement('div');
    fields.className = 'cvt-cloud-manager-fields';
    const device = buildCloudManagerField({
        id: 'cvt_cloud_manager_device_name',
        label: t('cloud.fields.deviceName'),
        value: config.deviceName,
        placeholder: t('cloud.fields.deviceNamePlaceholder'),
        hint: t('cloud.fields.deviceNameHint'),
    });
    fields.appendChild(device.field);

    const checks = document.createElement('div');
    checks.className = 'cvt-cloud-checks';
    for (const [id, label, checked] of [
        ['cvt_cloud_manager_sync_pinned', t('cloud.fields.syncPinned'), config.syncPinned !== false],
        ['cvt_cloud_manager_sync_latest', t('cloud.fields.syncLatest'), config.syncLatestStable !== false],
    ]) {
        const row = document.createElement('label');
        row.className = 'cvt-check-row';
        const input = document.createElement('input');
        input.id = id;
        input.type = 'checkbox';
        input.checked = checked;
        input.disabled = cloudRepositoryDialogBusy;
        const text = document.createElement('span');
        text.textContent = label;
        row.append(input, text);
        checks.appendChild(row);
    }
    fields.appendChild(checks);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'menu_button';
    save.textContent = t('cloud.actions.saveSettings');
    save.disabled = cloudRepositoryDialogBusy || Boolean(cloudRepositoryEditor);
    save.addEventListener('click', () => {
        void saveCloudManagerSettings();
    });
    fields.appendChild(save);
    section.appendChild(fields);
    return section;
}

function buildCloudHelpContent() {
    const content = document.createElement('div');
    content.className = 'cvt-cloud-help-content';
    for (const key of ['cloud.useCase', 'cloud.capability', 'cloud.retentionExplain', 'cloud.importExplain', 'cloud.restoreExplain']) {
        const paragraph = document.createElement('p');
        paragraph.className = 'cvt-note';
        paragraph.textContent = t(key);
        content.appendChild(paragraph);
    }
    return content;
}

function renderCloudRepositoryDialog({ focusEditor = false } = {}) {
    const dialog = cloudRepositoryDialog;
    if (!dialog) {
        return;
    }

    copyCloudThemeToDialog(dialog);
    dialog.replaceChildren();
    const header = document.createElement('div');
    header.className = 'cvt-cloud-manager-header';
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = t('cloud.manager.title');
    const description = document.createElement('span');
    description.textContent = t('cloud.manager.description');
    heading.append(title, description);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cvt-close-btn';
    close.innerHTML = '&times;';
    close.title = t('common.close');
    close.setAttribute('aria-label', t('common.close'));
    close.disabled = cloudRepositoryDialogBusy;
    close.addEventListener('click', closeCloudRepositoryDialog);
    header.append(heading, close);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cvt-cloud-manager-body';
    const config = cloudConfigCache && typeof cloudConfigCache === 'object' ? cloudConfigCache : {};
    const catalog = getCloudCatalogRepository(config);
    const repositories = Array.isArray(config.repositories) ? config.repositories : [];
    const statusMap = getCloudMemberStatusMap();

    const listTitle = document.createElement('strong');
    listTitle.textContent = t('cloud.manager.repositories');
    const list = document.createElement('div');
    list.className = 'cvt-cloud-repository-list';
    if (catalog) {
        list.appendChild(buildCloudRepositoryRow(catalog, {
            catalog: true,
            status: statusMap.get(String(catalog.repositoryId || '')),
        }));
    } else {
        const empty = document.createElement('div');
        empty.className = 'cvt-empty';
        empty.textContent = t('cloud.manager.noRepository');
        list.appendChild(empty);
    }
    for (const repository of repositories.filter((item) => item?.repositoryId !== catalog?.repositoryId)) {
        list.appendChild(buildCloudRepositoryRow(repository, {
            status: statusMap.get(String(repository.repositoryId || '')),
        }));
    }
    let add = null;
    if (!cloudRepositoryEditor && catalog) {
        add = document.createElement('button');
        add.type = 'button';
        add.className = 'menu_button';
        add.innerHTML = `<i class="fa-solid fa-plus" aria-hidden="true"></i><span>${t('cloud.actions.addRepository')}</span>`;
        add.disabled = cloudRepositoryDialogBusy;
        add.addEventListener('click', () => {
            cloudRepositoryEditor = {
                mode: 'create-member',
                repositoryId: '',
                repoUrl: '',
                branch: 'main',
                isCatalog: false,
                error: '',
            };
            renderCloudRepositoryDialog({ focusEditor: true });
        });
    }

    const editor = buildCloudManagerEditor();
    body.appendChild(buildCloudManagerSettings());
    body.appendChild(listTitle);
    body.appendChild(list);
    if (add) {
        body.appendChild(add);
    }
    if (editor) {
        body.appendChild(editor.section);
    }
    dialog.appendChild(body);

    if (focusEditor && editor?.urlInput) {
        globalThis.setTimeout(() => editor.urlInput.focus(), 0);
    }
}

function cleanupCloudHelpDialog(dialog) {
    if (cloudHelpDialog === dialog) {
        cloudHelpDialog = null;
    }
    dialog?.remove();
}

function closeCloudHelpDialog() {
    const dialog = cloudHelpDialog;
    if (!dialog) {
        return;
    }
    if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
        return;
    }
    cleanupCloudHelpDialog(dialog);
}

function openCloudHelpDialog() {
    if (cloudHelpDialog) {
        return;
    }

    const dialog = document.createElement('dialog');
    dialog.className = 'cvt-cloud-manager cvt-cloud-help';
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) {
            closeCloudHelpDialog();
        }
    });
    dialog.addEventListener('close', () => cleanupCloudHelpDialog(dialog));

    const header = document.createElement('div');
    header.className = 'cvt-cloud-manager-header';
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = t('cloud.actions.help');
    const description = document.createElement('span');
    description.textContent = t('cloud.help.description');
    heading.append(title, description);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cvt-close-btn';
    close.innerHTML = '&times;';
    close.title = t('common.close');
    close.setAttribute('aria-label', t('common.close'));
    close.addEventListener('click', closeCloudHelpDialog);
    header.append(heading, close);

    const body = document.createElement('div');
    body.className = 'cvt-cloud-manager-body';
    body.appendChild(buildCloudHelpContent());
    dialog.append(header, body);
    document.body.appendChild(dialog);
    cloudHelpDialog = dialog;
    copyCloudThemeToDialog(dialog);

    if (typeof dialog.showModal === 'function') {
        try {
            dialog.showModal();
            return;
        } catch (error) {
            console.warn('[chat-vault] Failed to open cloud help dialog:', error);
        }
    }
    dialog.setAttribute('open', '');
}

function cleanupCloudRepositoryDialog(dialog) {
    if (cloudRepositoryDialog === dialog) {
        cloudRepositoryDialog = null;
        cloudRepositoryEditor = null;
        cloudRepositoryDialogBusy = false;
    }
    dialog?.remove();
}

function closeCloudRepositoryDialog() {
    const dialog = cloudRepositoryDialog;
    if (!dialog) {
        return;
    }
    if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
        return;
    }
    cleanupCloudRepositoryDialog(dialog);
}

function openCloudRepositoryDialog() {
    if (cloudRepositoryDialog) {
        return;
    }

    const dialog = document.createElement('dialog');
    dialog.className = 'cvt-cloud-manager';
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog && !cloudRepositoryDialogBusy) {
            closeCloudRepositoryDialog();
        }
    });
    dialog.addEventListener('cancel', (event) => {
        if (cloudRepositoryDialogBusy) {
            event.preventDefault();
        }
    });
    dialog.addEventListener('close', () => cleanupCloudRepositoryDialog(dialog));
    document.body.appendChild(dialog);
    cloudRepositoryDialog = dialog;

    const catalog = getCloudCatalogRepository(cloudConfigCache);
    cloudRepositoryEditor = catalog ? null : {
        mode: 'create-catalog',
        repositoryId: '',
        repoUrl: '',
        branch: 'main',
        isCatalog: true,
        error: '',
    };
    renderCloudRepositoryDialog({ focusEditor: Boolean(cloudRepositoryEditor) });

    if (typeof dialog.showModal === 'function') {
        try {
            dialog.showModal();
            return;
        } catch (error) {
            console.warn('[chat-vault] Failed to open cloud repository dialog:', error);
        }
    }
    dialog.setAttribute('open', '');
}

async function saveCloudConfig(payload, { quiet = false } = {}) {
    const result = await callApi('/cloud/config/save', payload);
    cloudConfigCache = result.config || {};
    applyCloudConfigToDom(cloudConfigCache);
    renderCloudStatus(cloudConfigCache, cloudManifestCache || buildEmptyCloudManifest());
    if (!quiet) {
        toastr.success(t('cloud.toasts.configSaved'), getAppTitle());
    }
    return result;
}

async function saveCloudManagerSettings() {
    const payload = getCloudConfigPayloadFromManager();
    cloudRepositoryDialogBusy = true;
    renderCloudRepositoryDialog();
    try {
        await saveCloudConfig(payload);
    } catch (error) {
        console.error('[chat-vault] Failed to save cloud manager settings:', error);
        toastr.error(t('cloud.toasts.configSaveFailed'), getAppTitle());
    } finally {
        cloudRepositoryDialogBusy = false;
        renderCloudRepositoryDialog();
    }
}

function getCloudOperationErrorDetail(error) {
    const raw = String(error?.message || '').trim();
    if (!raw) {
        return t('common.operationFailed');
    }
    try {
        const parsed = JSON.parse(raw);
        const detail = String(parsed?.detail || parsed?.error || '').trim();
        if (detail) {
            return truncate(detail, 240);
        }
    } catch (parseError) {
        // Non-JSON backend errors are already suitable for a short inline message.
    }
    return truncate(raw, 240);
}

function reconcileCloudRepositoryEditorAfterConnectFailure(editor, error) {
    const config = cloudConfigCache && typeof cloudConfigCache === 'object' ? cloudConfigCache : {};
    const repositories = Array.isArray(config.repositories) ? config.repositories : [];
    const matchingRepositories = repositories
        .filter((repository) => String(repository?.repoUrl || '').trim() === editor.repoUrl
            && (String(repository?.branch || '').trim() || 'main') === (editor.branch || 'main'));
    const matchingRepository = matchingRepositories[matchingRepositories.length - 1] || null;
    const catalog = getCloudCatalogRepository(config);
    return {
        ...editor,
        ...(matchingRepository ? {
            mode: 'edit',
            repositoryId: String(matchingRepository.repositoryId || ''),
            isCatalog: String(matchingRepository.repositoryId || '') === String(catalog?.repositoryId || ''),
            hasTokenOverride: Boolean(matchingRepository.hasTokenOverride),
        } : {}),
        error: t('cloud.manager.connectionError', { detail: getCloudOperationErrorDetail(error) }),
    };
}

async function submitCloudRepositoryEditor() {
    const editor = captureCloudRepositoryEditor();
    if (!editor) {
        return;
    }
    if (!editor.repoUrl) {
        cloudRepositoryEditor = { ...editor, error: t('cloud.manager.repoRequired') };
        renderCloudRepositoryDialog({ focusEditor: true });
        return;
    }
    const urlInput = cloudRepositoryDialog?.querySelector('#cvt_cloud_manager_repo_url');
    if (urlInput && !urlInput.checkValidity()) {
        cloudRepositoryEditor = { ...editor, error: t('cloud.manager.repoInvalid') };
        urlInput.reportValidity?.();
        return;
    }

    const payload = getCloudConfigPayloadFromManager();
    cloudRepositoryDialogBusy = true;
    cloudRepositoryEditor = { ...editor, error: '' };
    renderCloudRepositoryDialog();
    try {
        await connectCloudPanel(payload);
        cloudRepositoryEditor = null;
    } catch (error) {
        console.error('[chat-vault] Failed to save and connect cloud repository:', error);
        cloudRepositoryEditor = reconcileCloudRepositoryEditorAfterConnectFailure(editor, error);
        toastr.error(t('cloud.toasts.connectFailed'), getAppTitle());
    } finally {
        cloudRepositoryDialogBusy = false;
        renderCloudRepositoryDialog({ focusEditor: Boolean(cloudRepositoryEditor?.error) });
    }
}

function applyCloudConfigToDom(config = null) {
    if (cloudRepositoryDialog && !cloudRepositoryDialogBusy) {
        renderCloudRepositoryDialog();
    }
    renderCloudActionState(config, cloudManifestCache || buildEmptyCloudManifest());
}

function buildCloudScopeItem(scope) {
    const item = document.createElement('div');
    item.className = `cvt-scope-item${String(activeCloudScopeId || '') === String(scope.scopeId || '') ? ' is-active' : ''}`;
    item.dataset.scopeId = scope.scopeId;

    const title = document.createElement('div');
    title.className = 'cvt-scope-title';
    title.textContent = scope.label || getScopeDisplayLabel(scope.source);

    const meta = document.createElement('div');
    meta.className = 'cvt-scope-meta';
    meta.textContent = [
        t('labels.chatBackupCount', { count: scope.entryCount || 0 }),
        t('cloud.labels.deviceCount', { count: scope.deviceCount || 0 }),
        scope.updatedAt ? t('labels.recentAt', { time: formatDateTime(scope.updatedAt) }) : '',
    ].filter(Boolean).join(' · ');

    const preview = document.createElement('div');
    preview.className = 'cvt-scope-preview';
    preview.textContent = scope.latestEntry?.lastMessagePreview || t('chat.emptyNoPreview');

    const actions = document.createElement('div');
    actions.className = 'cvt-item-actions';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'menu_button';
    openButton.dataset.action = 'open-cloud-scope';
    openButton.dataset.scopeId = scope.scopeId;
    openButton.textContent = t('cloud.actions.openScope');
    actions.appendChild(openButton);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(preview);
    item.appendChild(actions);
    return item;
}

function renderCloudScopeList() {
    const container = document.getElementById('cvt_cloud_scope_list');
    if (!container) {
        return;
    }

    const keyword = String(document.getElementById('cvt_cloud_scope_search')?.value || '').trim().toLowerCase();
    const scopes = (Array.isArray(cloudManifestCache?.scopes) ? cloudManifestCache.scopes : []).filter((scope) => {
        if (!keyword) {
            return true;
        }

        const haystack = [
            scope?.label,
            scope?.source?.chatId,
            scope?.source?.characterName,
            scope?.source?.groupName,
            ...(Array.isArray(scope?.devices) ? scope.devices.map((device) => device?.deviceName || device?.deviceId || '') : []),
        ].join('\n').toLowerCase();
        return haystack.includes(keyword);
    });
    container.innerHTML = '';
    if (!scopes.length) {
        const empty = document.createElement('div');
        empty.className = 'cvt-empty';
        empty.textContent = keyword ? t('cloud.scopeSearchEmpty') : t('cloud.emptyNoData');
        container.appendChild(empty);
        return;
    }

    for (const scope of scopes) {
        container.appendChild(buildCloudScopeItem(scope));
    }
}

function renderCloudCheckpointList() {
    const activeScope = getActiveCloudScope();
    const entries = Array.isArray(activeScope?.entries) ? activeScope.entries : [];
    const keyword = String(document.getElementById('cvt_cloud_checkpoint_search')?.value || '').trim();
    const deviceNameMap = new Map(
        (Array.isArray(activeScope?.devices) ? activeScope.devices : []).map((device) => [
            String(device?.deviceId || ''),
            String(device?.deviceName || device?.deviceId || ''),
        ]),
    );
    const normalizedEntries = entries.map((entry) => ({
        ...entry,
        id: entry.snapshotId,
        sourceDeviceNames: (Array.isArray(entry?.publishedByDevices) ? entry.publishedByDevices : [])
            .map((deviceId) => deviceNameMap.get(String(deviceId || '')) || String(deviceId || ''))
            .filter(Boolean),
    }));
    renderCheckpointListInto('cvt_cloud_checkpoint_list', filterCheckpointEntries(normalizedEntries, keyword), {
        allowOverwrite: false,
        emptyText: activeScope
            ? (keyword ? t('cloud.backupSearchEmpty') : t('cloud.emptyNoBackups'))
            : t('cloud.emptySelectFirst'),
        actionList: [
            { action: 'cloud-preview', text: t('common.preview') },
            { action: 'cloud-import', text: t('cloud.actions.importLocal') },
            { action: 'cloud-restore-new', text: t('actions.restoreNew') },
            { action: 'cloud-delete', text: t('common.delete'), danger: true },
        ],
    });
}

function applyImportedExtraWorldBindings(bindings = []) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
        return false;
    }

    if (!Array.isArray(world_info.charLore)) {
        world_info.charLore = [];
    }

    let changed = false;
    for (const binding of bindings) {
        const avatarUrl = String(binding?.avatarUrl || '').trim();
        const worldNames = Array.from(new Set(
            (Array.isArray(binding?.worldNames) ? binding.worldNames : [])
                .map((item) => String(item || '').trim())
                .filter(Boolean),
        ));
        const avatarBase = avatarUrl.replace(/\.[^/.]+$/, '');
        if (!avatarBase || !worldNames.length) {
            continue;
        }

        const existing = world_info.charLore.find((entry) => String(entry?.name || '').trim() === avatarBase);
        if (!existing) {
            world_info.charLore.push({
                name: avatarBase,
                extraBooks: worldNames,
            });
            changed = true;
            continue;
        }

        const nextBooks = Array.from(new Set(
            (Array.isArray(existing.extraBooks) ? existing.extraBooks : [])
                .map((item) => String(item || '').trim())
                .filter(Boolean)
                .concat(worldNames),
        ));
        if (JSON.stringify(nextBooks) !== JSON.stringify(existing.extraBooks || [])) {
            existing.extraBooks = nextBooks;
            changed = true;
        }
    }

    return changed;
}

function applyImportedPersonas(personas = []) {
    if (!Array.isArray(personas) || personas.length === 0) {
        return false;
    }

    if (!power_user.personas || typeof power_user.personas !== 'object') {
        power_user.personas = {};
    }
    if (!power_user.persona_descriptions || typeof power_user.persona_descriptions !== 'object') {
        power_user.persona_descriptions = {};
    }

    let changed = false;
    for (const persona of personas) {
        const avatarId = String(persona?.avatarId || '').trim();
        if (!avatarId) {
            continue;
        }

        const personaName = String(persona?.personaName || '').trim() || avatarId;
        const descriptor = persona?.descriptor && typeof persona.descriptor === 'object'
            ? persona.descriptor
            : { description: '', position: 0, depth: 2, role: 0, lorebook: '', connections: [] };

        if (power_user.personas[avatarId] !== personaName) {
            power_user.personas[avatarId] = personaName;
            changed = true;
        }

        const previousDescriptor = power_user.persona_descriptions[avatarId] || {};
        if (JSON.stringify(previousDescriptor) !== JSON.stringify(descriptor)) {
            power_user.persona_descriptions[avatarId] = descriptor;
            changed = true;
        }
    }

    return changed;
}

async function refreshImportedCloudResources(resourceImport = null) {
    const context = getContext();
    if (!context || !resourceImport || typeof resourceImport !== 'object') {
        return;
    }

    if (
        Number(resourceImport.importedWorldCount || 0) > 0
        || (Array.isArray(resourceImport.worldMappings) && resourceImport.worldMappings.length > 0)
    ) {
        await context.updateWorldInfoList?.();
    }

    if (applyImportedExtraWorldBindings(resourceImport.extraWorldBindings || [])) {
        context.saveSettingsDebounced?.();
    }

    const personaChanged = applyImportedPersonas(resourceImport.personas || []);
    if (personaChanged) {
        context.saveSettingsDebounced?.();
        await getUserAvatars(true);
    }

    if (
        Number(resourceImport.importedCharacterCount || 0) > 0
        || Number(resourceImport.importedGroupCount || 0) > 0
        || (Array.isArray(resourceImport.characterMappings) && resourceImport.characterMappings.length > 0)
        || (Array.isArray(resourceImport.groupMappings) && resourceImport.groupMappings.length > 0)
    ) {
        await context.getCharacters?.();
    }
}

async function refreshCloudStatus({ quiet = false } = {}) {
    if (!backendReady) {
        return;
    }

    try {
        const result = await callApi('/cloud/status', {});
        cloudConfigCache = result.config || {};
        cloudManifestCache = result.manifest || buildEmptyCloudManifest();
        applyCloudConfigToDom(cloudConfigCache);
        renderCloudStatus(cloudConfigCache, result.manifest || buildEmptyCloudManifest());
        renderCloudScopeList();
        renderCloudCheckpointList();
    } catch (error) {
        if (!quiet) {
            toastr.error(t('cloud.toasts.statusFailed'), getAppTitle());
        }
        console.error('[chat-vault] Failed to refresh cloud status:', error);
    }
}

async function refreshCloudScopes({ quiet = false } = {}) {
    if (!backendReady) {
        return;
    }

    const repositories = Array.isArray(cloudConfigCache?.repositories) ? cloudConfigCache.repositories : [];
    if (!repositories.length || !repositories.some((repository) => repository?.hasToken) || !cloudConfigCache?.repoUrl) {
        renderCloudStatus(cloudConfigCache || {}, cloudManifestCache || buildEmptyCloudManifest());
        const container = document.getElementById('cvt_cloud_scope_list');
        if (container) {
            container.innerHTML = `<div class="cvt-empty">${t('cloud.emptyNoConfig')}</div>`;
        }
        renderCloudCheckpointList();
        return;
    }

    try {
        const result = await callApi('/cloud/list', {});
        cloudConfigCache = result.config || cloudConfigCache || {};
        cloudManifestCache = result.manifest || buildEmptyCloudManifest();
        applyCloudConfigToDom(cloudConfigCache);
        if (activeCloudScopeId && !getActiveCloudScope()) {
            activeCloudScopeId = '';
        }
        renderCloudStatus(cloudConfigCache, result.manifest || buildEmptyCloudManifest());
        renderCloudScopeList();
        renderCloudCheckpointList();
    } catch (error) {
        if (!quiet) {
            toastr.error(t('cloud.toasts.listFailed'), getAppTitle());
        }
        console.error('[chat-vault] Failed to refresh cloud scopes:', error);
        const container = document.getElementById('cvt_cloud_scope_list');
        if (container) {
            container.innerHTML = `<div class="cvt-empty">${t('cloud.emptyLoadFailed')}</div>`;
        }
    }
}

function openCloudScope(scopeId) {
    activeCloudScopeId = scopeId;
    renderCloudScopeList();
    renderCloudCheckpointList();
}

function getCloudConfigPayloadFromCache() {
    const config = cloudConfigCache && typeof cloudConfigCache === 'object' ? cloudConfigCache : {};
    return {
        repositories: (Array.isArray(config.repositories) ? config.repositories : []).map((repository) => ({
            repositoryId: String(repository?.repositoryId || ''),
            repoUrl: String(repository?.repoUrl || '').trim(),
            branch: String(repository?.branch || '').trim() || 'main',
        })),
        deviceName: String(config.deviceName || ''),
        syncPinned: config.syncPinned !== false,
        syncLatestStable: config.syncLatestStable !== false,
        catalogRepositoryId: String(config.catalogRepositoryId || ''),
    };
}

async function connectCloudPanel(payload = getCloudConfigPayloadFromCache()) {
    const saved = await saveCloudConfig(payload, { quiet: true });
    const result = await callApi('/cloud/connect', {});
    cloudConfigCache = result.config || saved.config || {};
    cloudManifestCache = result.manifest || buildEmptyCloudManifest();
    applyCloudConfigToDom(cloudConfigCache);
    renderCloudStatus(cloudConfigCache, cloudManifestCache);
    renderCloudScopeList();
    renderCloudCheckpointList();
    const failedMembers = Number(result.manifest?.failedMemberCount || 0);
    if (failedMembers > 0) {
        toastr.warning(t('cloud.toasts.connectedPartial', { members: failedMembers }), getAppTitle());
    } else {
        toastr.success(t('cloud.toasts.connected'), getAppTitle());
    }
}

async function syncCloudNow() {
    if (!cloudConfigCache) {
        await refreshCloudStatus({ quiet: true });
    }
    if (!hasCloudConnectionConfig(cloudConfigCache)) {
        openCloudRepositoryDialog();
        return;
    }

    setCloudToolbarBusyState(true);
    try {
        const result = await callApi('/cloud/sync/push', {});
        cloudConfigCache = result.config || cloudConfigCache || {};
        cloudManifestCache = result.manifest || buildEmptyCloudManifest();
        applyCloudConfigToDom(cloudConfigCache);
        renderCloudStatus(cloudConfigCache, cloudManifestCache);
        renderCloudScopeList();
        renderCloudCheckpointList();
        const failedMembers = Array.isArray(result.failedRepositoryIds) ? result.failedRepositoryIds.length : 0;
        const toastKey = Number(result.skippedCount || 0) > 0 || failedMembers > 0
            ? 'cloud.toasts.syncedPartial'
            : 'cloud.toasts.synced';
        const toastArgs = {
            scopes: result.scopeCount || 0,
            snapshots: result.snapshotCount || 0,
            resources: result.resourceCount || 0,
            skipped: result.skippedCount || 0,
            members: failedMembers,
        };
        if (toastKey === 'cloud.toasts.syncedPartial') {
            toastr.warning(t(toastKey, toastArgs), getAppTitle());
        } else {
            toastr.success(t(toastKey, toastArgs), getAppTitle());
        }
    } finally {
        setCloudToolbarBusyState(false);
    }
}

async function fetchCloudSnapshot(scopeId, snapshotId, repositoryId) {
    return callApi('/cloud/snapshot/get', {
        scopeId,
        snapshotId,
        repositoryId,
    });
}

async function previewCloudSnapshot(scopeId, snapshotId, repositoryId) {
    const result = await fetchCloudSnapshot(scopeId, snapshotId, repositoryId);
    const messages = (Array.isArray(result.messages) ? result.messages : []).slice(-Math.max(1, Number(getSettings().previewMessages || 12)));
    const previewMessages = messages.map((message) => ({
        name: message?.name || '',
        sendDate: message?.send_date || '',
        text: message?.mes || '',
    }));
    await showPreviewPopup(previewMessages);
}

async function restoreCloudSnapshotAsNew(scopeId, snapshotId, repositoryId) {
    toastr.info(t('cloud.toasts.restoreStarting'), getAppTitle(), { timeOut: 1200 });
    const result = await callApi('/cloud/snapshot/prepare-restore', {
        scopeId,
        snapshotId,
        repositoryId,
    });
    await refreshImportedCloudResources(result.resourceImport || null);
    await restoreMessagesAsNew(
        result.source || result.meta?.source || result.scope?.source || null,
        {
            ...(result.entry || {}),
            id: snapshotId,
        },
        result.header || {},
        Array.isArray(result.messages) ? result.messages : [],
    );
}

async function importCloudSnapshot(scopeId, snapshotId, repositoryId) {
    toastr.info(t('cloud.toasts.importStarting'), getAppTitle(), { timeOut: 1200 });
    const result = await callApi('/cloud/snapshot/import', {
        scopeId,
        snapshotId,
        repositoryId,
    });
    await refreshImportedCloudResources(result.resourceImport || null);
    await refreshStatus({ quiet: true });
    toastr.success(
        result.created ? t('cloud.toasts.imported') : t('cloud.toasts.importSkipped'),
        getAppTitle(),
    );
}

async function deleteCloudSnapshot(scopeId, snapshotId, repositoryId) {
    const confirm = await Popup.show.confirm(
        t('cloud.deleteConfirmTitle'),
        t('cloud.deleteConfirmBody'),
    );
    if (!confirm) {
        return;
    }

    toastr.info(t('cloud.toasts.deleteStarting'), getAppTitle(), { timeOut: 1200 });
    setCloudToolbarBusyState(true);
    try {
        const result = await callApi('/cloud/snapshot/delete', {
            scopeId,
            snapshotId,
            repositoryId,
        });
        cloudConfigCache = result.config || cloudConfigCache || {};
        cloudManifestCache = result.manifest || buildEmptyCloudManifest();
        applyCloudConfigToDom(cloudConfigCache);
        if (activeCloudScopeId && !getActiveCloudScope()) {
            activeCloudScopeId = '';
        }
        renderCloudStatus(cloudConfigCache, cloudManifestCache);
        renderCloudScopeList();
        renderCloudCheckpointList();
        toastr.success(t('cloud.toasts.deleted'), getAppTitle());
    } finally {
        setCloudToolbarBusyState(false);
    }
}

function applySettingsToDom() {
    const settings = getSettings();
    const showTrigger = document.getElementById('cvt_show_trigger');
    const enabled = document.getElementById('cvt_enabled');
    const showRecoveryToast = document.getElementById('cvt_show_recovery_toast');
    const autoSlots = document.getElementById('cvt_auto_slots');
    const saveDelay = document.getElementById('cvt_save_delay');
    const draftDelay = document.getElementById('cvt_draft_delay');
    const restoreNameTemplate = document.getElementById('cvt_restore_name_template');
    const snapshotFileTemplate = document.getElementById('cvt_snapshot_file_template');

    if (showTrigger) showTrigger.checked = Boolean(settings.showTrigger);
    if (enabled) enabled.checked = Boolean(settings.enabled);
    if (showRecoveryToast) showRecoveryToast.checked = Boolean(settings.showRecoveryToast);
    if (autoSlots) autoSlots.value = String(settings.autoSlotCount);
    if (saveDelay) saveDelay.value = String(settings.saveDelayMs);
    if (draftDelay) draftDelay.value = String(settings.draftMirrorMs);
    if (restoreNameTemplate) restoreNameTemplate.value = String(settings.restoreNameTemplate || DEFAULT_SETTINGS.restoreNameTemplate);
    if (snapshotFileTemplate) snapshotFileTemplate.value = String(settings.snapshotFileTemplate || DEFAULT_SETTINGS.snapshotFileTemplate);
    applyTheme(settings.themeId || 'auto');
    setTriggerVisible(Boolean(settings.showTrigger));
}

function saveSettingsFromDom() {
    const settings = ensureSettings();
    const showTrigger = document.getElementById('cvt_show_trigger');
    const enabled = document.getElementById('cvt_enabled');
    const showRecoveryToast = document.getElementById('cvt_show_recovery_toast');
    const autoSlots = document.getElementById('cvt_auto_slots');
    const saveDelay = document.getElementById('cvt_save_delay');
    const draftDelay = document.getElementById('cvt_draft_delay');
    const restoreNameTemplate = document.getElementById('cvt_restore_name_template');
    const snapshotFileTemplate = document.getElementById('cvt_snapshot_file_template');

    settings.showTrigger = Boolean(showTrigger?.checked);
    settings.enabled = Boolean(enabled?.checked);
    settings.showRecoveryToast = Boolean(showRecoveryToast?.checked);
    settings.autoSlotCount = Math.min(Math.max(Number(autoSlots?.value || DEFAULT_SETTINGS.autoSlotCount), 1), 100);
    settings.saveDelayMs = Math.min(Math.max(Number(saveDelay?.value || DEFAULT_SETTINGS.saveDelayMs), 50), 3000);
    settings.draftMirrorMs = Math.min(Math.max(Number(draftDelay?.value || DEFAULT_SETTINGS.draftMirrorMs), 50), 3000);
    settings.restoreNameTemplate = String(restoreNameTemplate?.value || DEFAULT_SETTINGS.restoreNameTemplate).trim() || DEFAULT_SETTINGS.restoreNameTemplate;
    settings.snapshotFileTemplate = String(snapshotFileTemplate?.value || DEFAULT_SETTINGS.snapshotFileTemplate).trim() || DEFAULT_SETTINGS.snapshotFileTemplate;

    const context = getContext();
    context?.saveSettingsDebounced?.();
    applySettingsToDom();
}

async function probeBackend() {
    try {
        await callApi('/probe', {});
        backendReady = true;
        setBackendStatus(t('status.backendReady'), 'ok');
    } catch (error) {
        backendReady = false;
        setBackendStatus(t('status.backendMissing'), 'error');
        console.warn('[chat-vault] Backend probe failed:', error);
    }
}

async function refreshStatus({ quiet = false } = {}) {
    const source = getStatusSource();
    if (!source) {
        statusCache = null;
        renderStatus({ source: null, draft: null, entries: [] });
        return;
    }

    if (!backendReady) {
        renderStatus({ source, draft: null, entries: [], unavailable: true });
        return;
    }

    try {
        const status = await callApi('/snapshot/list', { source });
        statusCache = status;
        renderStatus(status);
        maybeShowRecoveryToast(status);
    } catch (error) {
        if (!quiet) {
            toastr.error(t('toasts.statusLoadFailed'), getAppTitle());
        }
        console.error('[chat-vault] Failed to refresh status:', error);
    }
}

function maybeShowRecoveryToast(status) {
    if (activeScopeOverride) {
        return;
    }

    const settings = getSettings();
    if (!settings.showRecoveryToast) {
        return;
    }

    const source = buildSource();
    if (!source) {
        return;
    }

    const currentMessageCount = Array.isArray(getContext()?.chat) ? getContext().chat.length : 0;
    const latest = status?.entries?.[0];
    const hasDraft = Boolean(status?.draft?.text?.trim());
    const shouldNotify = hasDraft || (currentMessageCount === 0 && latest?.messageCount > 0);
    if (!shouldNotify) {
        return;
    }

    const key = [
        source.chatId,
        latest?.id || '',
        status?.draft?.updatedAt || '',
        currentMessageCount,
    ].join(':');

    if (key === lastRecoveryToastKey) {
        return;
    }

    lastRecoveryToastKey = key;

    const message = hasDraft
        ? t('toasts.detectDraft')
        : t('toasts.detectBackup');
    toastr.info(message, getAppTitle(), { timeOut: 6000 });
}

function buildSnapshotPayload(trigger, { forceNew = false, seriesKey = '' } = {}) {
    const context = getContext();
    const source = buildSource();
    if (!context || !source || !Array.isArray(context.chat)) {
        return null;
    }

    const header = {
        chat_metadata: cloneJson(context.chatMetadata, {}),
        user_name: source.kind === 'group' ? 'unused' : (source.userName || 'unused'),
        character_name: source.kind === 'group' ? 'unused' : (source.characterName || 'unused'),
    };

    const messages = cloneJson(context.chat, []);
    const autoSlotCount = Math.min(Math.max(Number(getSettings().autoSlotCount || 1), 1), 100);
    return {
        source,
        snapshot: [header, ...messages],
        trigger,
        createdAt: Date.now(),
        maxAutoSnapshots: autoSlotCount,
        forceNew,
        replaceLatest: !forceNew && autoSlotCount <= 1,
        mode: forceNew ? 'manual' : 'auto',
        seriesKey: forceNew ? '' : String(seriesKey || ''),
        snapshotFileTemplate: getSettings().snapshotFileTemplate,
    };
}

function scheduleFastSave() {
    if (!getSettings().enabled) {
        return;
    }

    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const context = getContext();
        if (!context?.chatId) {
            return;
        }

        try {
            await context.saveChat();
        } catch (error) {
            console.error('[chat-vault] Fast save failed:', error);
        }
    }, getSettings().saveDelayMs);
}

function queueSnapshot(trigger, options = {}) {
    if (!backendReady || !getSettings().enabled) {
        return;
    }

    scheduledSnapshotRequest = {
        trigger,
        forceNew: Boolean(options.forceNew),
        seriesKey: String(options.seriesKey || ''),
    };

    clearTimeout(snapshotTimer);
    const delay = Number.isFinite(SNAPSHOT_DELAYS[trigger]) ? SNAPSHOT_DELAYS[trigger] : 400;
    snapshotTimer = setTimeout(() => {
        const request = scheduledSnapshotRequest;
        scheduledSnapshotRequest = null;
        if (request) {
            void flushSnapshot(request.trigger, { forceNew: request.forceNew, seriesKey: request.seriesKey });
        }
    }, delay);
}

function clearPendingSwipeSnapshot() {
    if (pendingSwipeSnapshot?.timer) {
        clearTimeout(pendingSwipeSnapshot.timer);
    }
    pendingSwipeSnapshot = null;
}

function scheduleSwipeSnapshot(messageId = null) {
    clearPendingSwipeSnapshot();
    const numericMessageId = Number.isInteger(messageId) ? messageId : Number(messageId);
    pendingSwipeSnapshot = {
        messageId: Number.isFinite(numericMessageId) ? numericMessageId : null,
        timer: setTimeout(() => {
            const pending = pendingSwipeSnapshot;
            pendingSwipeSnapshot = null;
            const turnSeriesKey = buildTurnSeriesKey('message_swiped', pending?.messageId);
            queueSnapshot('message_swiped', {
                seriesKey: turnSeriesKey || createSeriesKey('turn'),
            });
        }, SNAPSHOT_DELAYS.message_swiped),
    };
}

async function flushSnapshot(trigger, options = {}) {
    if (isSnapshotting) {
        pendingSnapshotRequest = {
            trigger,
            forceNew: pendingSnapshotRequest?.forceNew || Boolean(options.forceNew),
            seriesKey: String(options.seriesKey || pendingSnapshotRequest?.seriesKey || ''),
        };
        return;
    }

    const payload = buildSnapshotPayload(trigger, options);
    if (!payload) {
        return;
    }

    isSnapshotting = true;
    try {
        await callApi('/snapshot/create', payload);
        await refreshStatus({ quiet: true });
    } catch (error) {
        console.error('[chat-vault] Snapshot creation failed:', error);
    } finally {
        isSnapshotting = false;
        if (pendingSnapshotRequest) {
            const next = pendingSnapshotRequest;
            pendingSnapshotRequest = null;
            void flushSnapshot(next.trigger, { forceNew: next.forceNew, seriesKey: next.seriesKey });
        }
    }
}

function getLiveDraftFromDom() {
    const candidates = Array.from(document.querySelectorAll('.edit_textarea, .reasoning_edit_textarea'));
    if (candidates.length === 0) {
        return null;
    }

    const activeTextarea = candidates.find((node) => node === document.activeElement) || candidates[0];
    if (!(activeTextarea instanceof HTMLTextAreaElement)) {
        return null;
    }

    const messageElement = activeTextarea.closest('.mes');
    if (!messageElement) {
        return null;
    }

    const messageId = Number(messageElement.getAttribute('mesid'));
    if (!Number.isFinite(messageId)) {
        return null;
    }

    const context = getContext();
    const currentMessage = Array.isArray(context?.chat) ? context.chat[messageId] : null;

    return {
        kind: activeTextarea.classList.contains('reasoning_edit_textarea') ? 'reasoning' : 'message',
        messageId,
        text: activeTextarea.value,
        updatedAt: Date.now(),
        anchor: {
            messageId,
            sendDate: currentMessage?.send_date || '',
            name: currentMessage?.name || '',
            textHash: hashText(currentMessage?.mes || ''),
        },
    };
}

function syncDraftIntoStatus(draft) {
    if (!statusCache) {
        statusCache = {
            source: buildSource(),
            entries: [],
            draft,
        };
    } else {
        statusCache.draft = draft;
    }

    renderDraftCard(draft);
}

async function flushDraftMirror({ allowClear = false } = {}) {
    const source = buildSource();
    if (!backendReady || !source) {
        return;
    }

    const draft = getLiveDraftFromDom();
    const signature = JSON.stringify({
        chatId: source.chatId,
        kind: draft?.kind || '',
        messageId: draft?.messageId ?? '',
        text: draft?.text || '',
    });

    if (signature === lastDraftSignature) {
        return;
    }

    lastDraftSignature = signature;

    try {
        if (draft?.text?.trim()) {
            const result = await callApi('/draft/save', { source, draft });
            syncDraftIntoStatus(result.draft || draft);
            return;
        }

        if (!allowClear) {
            return;
        }

        await callApi('/draft/clear', { source });
        lastDraftSignature = '';
        syncDraftIntoStatus(null);
    } catch (error) {
        console.error('[chat-vault] Draft mirror failed:', error);
    }
}

function scheduleDraftMirror(delay = getSettings().draftMirrorMs, options = {}) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        void flushDraftMirror(options);
    }, delay);
}

function buildRestoreName(entry, sourceOverride = null) {
    const source = sourceOverride || getActionSource();
    const settings = getSettings();
    const rendered = applyRestoreNameTemplate(settings.restoreNameTemplate, source, entry);
    return sanitizeNamePart(rendered) || `${t('app.title')} ${formatDateSlug(entry?.createdAt || Date.now())}`;
}

async function fetchSnapshot(snapshotId, sourceOverride = null) {
    const source = sourceOverride || getActionSource();
    if (!source) {
        throw new Error('No active chat');
    }

    return callApi('/snapshot/get', {
        source,
        snapshotId,
    });
}

function buildPreviewText(messages = []) {
    return messages
        .map((message) => {
            const stamp = message.sendDate ? ` [${message.sendDate}]` : '';
            return `${message.name || t('common.unknownSpeaker')}${stamp}\n${message.text || ''}`;
        })
        .join('\n\n');
}

async function showPreviewPopup(messages = []) {
    const textArea = document.createElement('textarea');
    textArea.className = 'text_pole monospace textarea_compact margin0 height100p';
    textArea.readOnly = true;
    textArea.value = buildPreviewText(messages);
    await callGenericPopup(textArea, POPUP_TYPE.TEXT, '', {
        allowVerticalScrolling: true,
        large: true,
        wide: true,
    });
}

async function previewSnapshot(snapshotId, sourceOverride = null) {
    const source = sourceOverride || getActionSource();
    if (!source) {
        return;
    }

    const result = await callApi('/snapshot/preview', {
        source,
        snapshotId,
        limit: getSettings().previewMessages,
    });
    await showPreviewPopup(result.previewMessages || []);
}

async function saveCharacterChatSnapshot(context, targetCharacterId, chatName, header, messages) {
    const character = Array.isArray(context.characters) ? context.characters[targetCharacterId] : null;
    if (!character?.avatar || !character?.name) {
        throw new Error('target_character_not_found');
    }

    const payload = [
        {
            user_name: header?.user_name || context.name1 || '',
            character_name: header?.character_name || character.name || '',
            create_date: header?.create_date || header?.send_date || new Date().toISOString(),
            chat_metadata: cloneJson(header?.chat_metadata, {}),
        },
        ...cloneJson(messages, []),
    ];

    const response = await fetchWithCsrfRetry('/api/chats/save', {
        method: 'POST',
        body: JSON.stringify({
            ch_name: character.name,
            file_name: chatName,
            chat: payload,
            avatar_url: character.avatar,
            force: false,
        }),
    });

    if (!response.ok) {
        throw new Error(`failed_to_save_character_chat:${response.status}`);
    }
}

async function saveGroupChatSnapshot(context, targetGroupId, chatName, header, messages) {
    const group = Array.isArray(context.groups)
        ? context.groups.find((item) => String(item?.id || '') === String(targetGroupId || ''))
        : null;
    if (!group) {
        throw new Error('target_group_not_found');
    }

    if (!Array.isArray(group.chats)) {
        group.chats = [];
    }
    if (!group.chats.includes(chatName)) {
        group.chats.push(chatName);
    }
    if (!group.past_metadata || typeof group.past_metadata !== 'object') {
        group.past_metadata = {};
    }
    group.past_metadata[chatName] = cloneJson(header?.chat_metadata, {});

    const saveGroupResponse = await fetchWithCsrfRetry('/api/groups/edit', {
        method: 'POST',
        body: JSON.stringify(group),
    });
    if (!saveGroupResponse.ok) {
        throw new Error(`failed_to_save_group_meta:${saveGroupResponse.status}`);
    }

    const saveChatResponse = await fetchWithCsrfRetry('/api/chats/group/save', {
        method: 'POST',
        body: JSON.stringify({
            id: chatName,
            chat: cloneJson(messages, []),
        }),
    });
    if (!saveChatResponse.ok) {
        throw new Error(`failed_to_save_group_chat:${saveChatResponse.status}`);
    }
}

async function restoreMessagesAsNew(source, entry, header, messages) {
    const context = getContext();
    if (!context || !source) {
        return;
    }
    const suggestedName = buildRestoreName(entry, source);
    const requestedName = await Popup.show.input(
        t('popup.restoreNew.title'),
        t('popup.restoreNew.body'),
        suggestedName,
        { rows: 1 },
    );
    if (requestedName === null) {
        return;
    }
    const chatName = sanitizeNamePart(requestedName) || suggestedName;

    if (source.kind === 'group') {
        const targetGroupId = findGroupIdBySource(source);
        if (!targetGroupId) {
            toastr.error(t('toasts.missingGroup'), getAppTitle());
            return;
        }
        await saveGroupChatSnapshot(context, targetGroupId, chatName, header, messages);
        await context.openGroupChat(targetGroupId, chatName);
    } else {
        const targetCharacterId = findCharacterIdBySource(source);
        if (targetCharacterId < 0) {
            toastr.error(t('toasts.missingCharacter'), getAppTitle());
            return;
        }
        await saveCharacterChatSnapshot(context, targetCharacterId, chatName, header, messages);
        if (String(context.characterId ?? '') !== String(targetCharacterId)) {
            await context.selectCharacterById(targetCharacterId, { switchMenu: false });
        }
        await context.openCharacterChat(chatName);
    }

    toastr.success(t('toasts.restoredNewChat'), getAppTitle());
}

async function restoreSnapshotAsNew(snapshotId, sourceOverride = null) {
    const result = await fetchSnapshot(snapshotId, sourceOverride);
    await restoreMessagesAsNew(
        sourceOverride || getActionSource(),
        result.entry || {},
        result.header || {},
        Array.isArray(result.messages) ? result.messages : [],
    );
}

async function overwriteCurrentChat(snapshotId) {
    const context = getContext();
    const source = buildSource();
    if (activeScopeOverride) {
        toastr.info(t('recovery.restoreNewOnly'), getAppTitle());
        return;
    }

    if (!context || !source) {
        return;
    }

    const confirm = await Popup.show.confirm(
        t('popup.overwrite.title'),
        t('popup.overwrite.body')
    );
    if (!confirm) {
        return;
    }

    const result = await fetchSnapshot(snapshotId);
    const snapshot = Array.isArray(result.snapshot) ? result.snapshot : [];
    if (!snapshot.length) {
        toastr.error(t('toasts.emptyBackup'), getAppTitle());
        return;
    }

    const endpoint = source.kind === 'group' ? '/api/chats/group/save' : '/api/chats/save';
    const body = source.kind === 'group'
        ? {
            id: source.chatId,
            chat: snapshot,
            force: true,
        }
        : {
            ch_name: source.characterName,
            file_name: source.chatId,
            avatar_url: source.avatarUrl,
            chat: snapshot,
            force: true,
        };

    const response = await fetchWithCsrfRetry(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        toastr.error(t('toasts.overwriteFailed'), getAppTitle());
        return;
    }

    await context.reloadCurrentChat();
    await refreshStatus({ quiet: true });
    toastr.success(t('toasts.overwriteDone'), getAppTitle());
}

async function togglePinSnapshot(snapshotId, sourceOverride = null) {
    const source = sourceOverride || getActionSource();
    if (!source) {
        return;
    }

    await callApi('/snapshot/pin', {
        source,
        snapshotId,
    });

    await refreshStatus({ quiet: true });
}

async function deleteSnapshot(snapshotId, sourceOverride = null) {
    const source = sourceOverride || getActionSource();
    if (!source) {
        return;
    }

    const confirm = await Popup.show.confirm(t('popup.deleteBackup.title'), t('popup.deleteBackup.body'));
    if (!confirm) {
        return;
    }

    const result = await callApi('/snapshot/delete', {
        source,
        snapshotId,
    });

    await refreshRecoveryScopes({ quiet: true });
    if (result?.cleanup?.removed && activeScopeOverride && areSourcesEquivalent(source, activeScopeOverride)) {
        activeScopeOverride = null;
        statusCache = null;
        renderRecoveryStatus(null);
        return;
    }

    await refreshStatus({ quiet: true });
}

async function renameSnapshot(snapshotId, sourceOverride = null) {
    const source = sourceOverride || getActionSource();
    if (!source) {
        return;
    }

    const entry = statusCache?.entries?.find((item) => item.id === snapshotId && (!sourceOverride || areSourcesEquivalent(item.source, sourceOverride)))
        || statusCache?.entries?.find((item) => item.id === snapshotId);
    const currentName = String(entry?.customName || '').trim() || formatDateTime(entry?.createdAt || Date.now());
    const requestedName = await Popup.show.input(
        t('popup.renameBackup.title'),
        t('popup.renameBackup.body'),
        currentName,
        { rows: 1 },
    );
    if (requestedName === null) {
        return;
    }

    const finalName = sanitizeNamePart(requestedName);
    if (!finalName) {
        toastr.error(t('toasts.backupNameEmpty'), getAppTitle());
        return;
    }

    await callApi('/snapshot/rename', {
        source,
        snapshotId,
        name: finalName,
    });

    await refreshStatus({ quiet: true });
}

async function fallbackShowDraft(draft) {
    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole monospace textarea_compact margin0 height100p';
    textarea.readOnly = true;
    textarea.value = draft.text || '';
    await callGenericPopup(textarea, POPUP_TYPE.TEXT, '', {
        allowVerticalScrolling: true,
        large: true,
        wide: true,
    });
}

function findDraftMessageElement(draft) {
    let messageElement = document.querySelector(`#chat .mes[mesid="${draft.messageId}"]`);
    if (messageElement instanceof HTMLElement) {
        return messageElement;
    }

    const context = getContext();
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const anchor = draft?.anchor;
    if (!anchor || (!anchor.sendDate && !anchor.name && !anchor.textHash)) {
        return null;
    }

    const matchIndex = messages.findIndex((message) => {
        if (!message || typeof message !== 'object') {
            return false;
        }

        const sendDateMatches = anchor.sendDate ? String(message.send_date || '') === String(anchor.sendDate) : true;
        const nameMatches = anchor.name ? String(message.name || '') === String(anchor.name) : true;
        const textMatches = anchor.textHash ? hashText(message.mes || '') === String(anchor.textHash) : true;
        return sendDateMatches && nameMatches && textMatches;
    });

    if (matchIndex < 0) {
        return null;
    }

    messageElement = document.querySelector(`#chat .mes[mesid="${matchIndex}"]`);
    return messageElement instanceof HTMLElement ? messageElement : null;
}

async function resolveDraftTextarea(draft) {
    const messageElement = findDraftMessageElement(draft);
    if (!(messageElement instanceof HTMLElement)) {
        return null;
    }

    if (draft.kind === 'reasoning') {
        let textarea = messageElement.querySelector('.reasoning_edit_textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) {
            const button = messageElement.querySelector('.mes_reasoning_edit, .mes_edit_add_reasoning');
            if (!(button instanceof HTMLElement)) {
                return null;
            }

            button.click();
            await waitUntilCondition(
                () => messageElement.querySelector('.reasoning_edit_textarea') instanceof HTMLTextAreaElement,
                2000,
                50,
            );
            textarea = messageElement.querySelector('.reasoning_edit_textarea');
        }

        return textarea instanceof HTMLTextAreaElement ? textarea : null;
    }

    let textarea = messageElement.querySelector('.edit_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
        const button = messageElement.querySelector('.mes_edit');
        if (!(button instanceof HTMLElement)) {
            return null;
        }

        button.click();
        await waitUntilCondition(
            () => messageElement.querySelector('.edit_textarea') instanceof HTMLTextAreaElement,
            2000,
            50,
        );
        textarea = messageElement.querySelector('.edit_textarea');
    }

    return textarea instanceof HTMLTextAreaElement ? textarea : null;
}

async function restoreDraftIntoEditor() {
    const draft = statusCache?.draft;
    if (!draft?.text?.trim()) {
        return;
    }

    try {
        const textarea = await resolveDraftTextarea(draft);
        if (!(textarea instanceof HTMLTextAreaElement)) {
            await fallbackShowDraft(draft);
            return;
        }

        textarea.value = draft.text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        textarea.setSelectionRange(draft.text.length, draft.text.length);
        toastr.success(t('draft.restoreSuccess'), getAppTitle());
    } catch (error) {
        console.error('[chat-vault] Draft restore failed:', error);
        await fallbackShowDraft(draft);
    }
}

async function clearDraft() {
    const source = buildSource();
    if (!source) {
        return;
    }

    await callApi('/draft/clear', { source });
    lastDraftSignature = '';
    syncDraftIntoStatus(null);
}

function onCommitEvent(trigger, messageId = null, commitType = '') {
    if (trigger === 'message_swiped') {
        scheduleSwipeSnapshot(messageId);
        scheduleFastSave();
        scheduleDraftMirror(30, { allowClear: true });
        return;
    }

    if (trigger === 'message_received' && commitType === 'swipe') {
        clearPendingSwipeSnapshot();
    }

    const turnSeriesKey = buildTurnSeriesKey(trigger, Number.isInteger(messageId) ? messageId : Number(messageId));
    queueSnapshot(trigger, {
        seriesKey: turnSeriesKey || createSeriesKey(
            trigger === 'message_received' || trigger === 'message_swiped' ? 'turn' : 'auto',
        ),
    });
    scheduleFastSave();
    scheduleDraftMirror(30, { allowClear: true });
}

// === Character merge (0.3.0+) ===

const cvmState = {
    primary: null,
    secondary: null,
    preview: null,
    diff: null,
    executeResult: null,
    step: 1,
    busy: false,
    confirmed: false,
    showAllDiffFields: false,
};

function cvmEscapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function cvmFormatTimestamp(ms) {
    const value = Number(ms);
    if (!value || Number.isNaN(value)) return t('common.unknownTime');
    return new Date(value).toLocaleString();
}

function cvmFormatBytes(bytes) {
    const n = Number(bytes);
    if (!n || Number.isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function cvmTruncate(value, limit = 160) {
    const text = String(value ?? '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}…`;
}

async function refreshCharacterMergeTab() {
    await refreshCharacterMergePending();
    await refreshCharacterMergeGroups();
}

async function refreshCharacterMergePending() {
    const banner = document.getElementById('cvm_pending_banner');
    const detail = document.getElementById('cvm_pending_detail');
    if (!banner || !detail) return;
    try {
        const result = await callApi('/character-merge/pending');
        if (result?.ok) {
            if (result.pending) {
                const p = result.pending;
                detail.textContent = t('characterMerge.pending.summary', {
                    start: cvmFormatTimestamp(p.startedAt),
                    mergeId: p.mergeId || '?',
                    completed: (p.completedSteps || []).join(', ') || '—',
                });
                banner.hidden = false;
            } else {
                banner.hidden = true;
            }
            renderArchivesList(result.recentBackups || []);
            return;
        }
    } catch (error) {
        console.warn('[chat-vault] pending merge check failed', error);
    }
    banner.hidden = true;
    renderArchivesList([]);
}

function renderArchivesList(backups) {
    const list = document.getElementById('cvm_archives_list');
    if (!list) return;
    const visible = (backups || []).filter((b) => {
        if (!b.info || typeof b.info !== 'object') return false;
        const outcome = String(b.info.outcome || '').trim();
        return outcome === 'completed';
    });
    if (!visible.length) {
        list.innerHTML = `<div class="cvt-empty">${cvmEscapeHtml(t('characterMerge.archives.empty'))}</div>`;
        return;
    }
    list.innerHTML = visible.map((backup) => {
        const i = backup.info;
        const completedAt = cvmFormatTimestamp(i.completedAt);
        const primary = String(i.primary?.avatar || '');
        const secondary = String(i.secondary?.avatar || '');
        const final = String(i.final?.avatar || '');
        return `
            <div class="cvm-archive-row">
                <div class="cvm-archive-meta">
                    <div class="cvm-archive-time">${cvmEscapeHtml(t('characterMerge.archives.mergedAt', { time: completedAt }))}</div>
                    <div class="cvt-note">
                        <div>${cvmEscapeHtml(t('characterMerge.archives.kept'))}: <code>${cvmEscapeHtml(primary)}</code></div>
                        <div>${cvmEscapeHtml(t('characterMerge.archives.removed'))}: <code>${cvmEscapeHtml(secondary)}</code></div>
                        <div>${cvmEscapeHtml(t('characterMerge.archives.finalName'))}: <code>${cvmEscapeHtml(final)}</code></div>
                    </div>
                </div>
                <div class="cvt-toolbar cvm-archive-actions">
                    <button type="button" class="menu_button cvm-rollback-archive" data-merge-id="${cvmEscapeHtml(backup.mergeId)}">${cvmEscapeHtml(t('characterMerge.archives.rollback'))}</button>
                </div>
            </div>
        `;
    }).join('');
}

async function rollbackCompletedMergeArchive(mergeId) {
    if (!window.confirm(t('characterMerge.archives.rollbackConfirm'))) return;
    try {
        const result = await callApi('/character-merge/rollback-archive', { mergeId });
        if (result?.ok) {
            toastr.success(t('characterMerge.archives.rollbackOk'));
        } else {
            toastr.error(result?.error || 'rollback_archive_failed');
        }
    } catch (error) {
        toastr.error(String(error?.message || 'rollback_archive_failed'));
    }
    await refreshCharacterMergeTab();
}

async function refreshCharacterMergeGroups() {
    const list = document.getElementById('cvm_groups_list');
    if (!list) return;
    list.innerHTML = `<div class="cvt-empty">${cvmEscapeHtml(t('common.loading'))}</div>`;
    try {
        const result = await callApi('/character-merge/duplicates');
        if (!result?.ok) {
            list.innerHTML = `<div class="cvt-empty">${cvmEscapeHtml(t('characterMerge.scan.error'))}</div>`;
            return;
        }
        renderDuplicateGroups(result.groups || []);
    } catch (error) {
        console.warn('[chat-vault] duplicate scan failed', error);
        list.innerHTML = `<div class="cvt-empty">${cvmEscapeHtml(t('characterMerge.scan.error'))}</div>`;
    }
}

function renderDuplicateGroups(groups) {
    const list = document.getElementById('cvm_groups_list');
    if (!list) return;
    if (!groups.length) {
        list.innerHTML = `<div class="cvt-empty">${cvmEscapeHtml(t('characterMerge.scan.empty'))}</div>`;
        return;
    }
    const html = groups.map((group) => {
        const cards = group.cards.map((card) => `
            <div class="cvm-card-row">
                <div class="cvm-card-name"><code>${cvmEscapeHtml(card.avatarFileName)}</code>${card.isVaultImported ? ` <span class="cvt-badge" data-kind="info">${cvmEscapeHtml(t('characterMerge.card.vaultImported'))}</span>` : ''}</div>
                <div class="cvm-card-meta cvt-note">${cvmFormatBytes(card.fileSizeBytes)} · ${cvmEscapeHtml(cvmFormatTimestamp(card.modifiedAtMs))}${card.characterVersion ? ` · v${cvmEscapeHtml(card.characterVersion)}` : ''}</div>
            </div>
        `).join('');
        return `
            <div class="cvm-group cvt-card cvt-card-soft">
                <div class="cvt-section-head">
                    <strong>${cvmEscapeHtml(group.characterName)}</strong>
                    <span class="cvt-summary">${cvmEscapeHtml(t('characterMerge.group.cardCount', { count: group.cards.length }))}</span>
                </div>
                <div class="cvt-card-body">
                    ${cards}
                    <div class="cvt-toolbar">
                        <button type="button" class="menu_button cvm-start-merge" data-character-name="${cvmEscapeHtml(group.characterName)}">${cvmEscapeHtml(t('characterMerge.group.startMerge'))}</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    list.innerHTML = html;
}

async function startMergeForGroup(characterName) {
    const result = await callApi('/character-merge/duplicates');
    if (!result?.ok) return;
    const group = (result.groups || []).find((g) => g.characterName === characterName);
    if (!group || group.cards.length < 2) {
        toastr.info(t('characterMerge.scan.empty'));
        return;
    }
    await enterMergeWizard(group.cards[0], group.cards[1]);
}

async function enterMergeWizard(primary, secondary) {
    cvmState.primary = primary;
    cvmState.secondary = secondary;
    cvmState.preview = null;
    cvmState.diff = null;
    cvmState.executeResult = null;
    cvmState.step = 1;
    cvmState.confirmed = false;
    cvmState.showAllDiffFields = false;
    document.getElementById('cvm_scan_view').hidden = true;
    document.getElementById('cvm_wizard_view').hidden = false;
    await loadMergePreview();
    renderWizardStep();
}

async function loadMergePreview() {
    if (!cvmState.primary || !cvmState.secondary) return;
    try {
        const result = await callApi('/character-merge/preview', {
            primaryAvatar: cvmState.primary.avatarFileName,
            secondaryAvatar: cvmState.secondary.avatarFileName,
        });
        if (!result?.ok) {
            toastr.error(result?.error || t('characterMerge.scan.error'));
            return;
        }
        cvmState.preview = result.preview;
        cvmState.diff = result.diff;
    } catch (error) {
        toastr.error(String(error?.message || 'preview_failed'));
    }
}

function exitMergeWizard() {
    cvmState.primary = null;
    cvmState.secondary = null;
    cvmState.preview = null;
    cvmState.diff = null;
    cvmState.executeResult = null;
    cvmState.step = 1;
    cvmState.confirmed = false;
    cvmState.showAllDiffFields = false;
    document.getElementById('cvm_scan_view').hidden = false;
    document.getElementById('cvm_wizard_view').hidden = true;
    refreshCharacterMergeGroups();
}

function renderWizardStep() {
    const titleEl = document.getElementById('cvm_wizard_step_title');
    const progressEl = document.getElementById('cvm_wizard_progress');
    const contentEl = document.getElementById('cvm_wizard_content');
    const backBtn = document.getElementById('cvm_wizard_back');
    const nextBtn = document.getElementById('cvm_wizard_next');
    const cancelBtn = document.getElementById('cvm_wizard_cancel');
    const actionsEl = document.querySelector('.cvm-wizard-actions');
    if (!titleEl || !contentEl || !nextBtn || !backBtn || !cancelBtn || !actionsEl) return;

    const step = cvmState.step;
    titleEl.textContent = t(`characterMerge.wizard.step${step}.title`);
    progressEl.textContent = `${step} / 5`;

    if (step >= 4) {
        actionsEl.hidden = true;
    } else {
        actionsEl.hidden = false;
        backBtn.hidden = (step <= 1);
        cancelBtn.hidden = false;
        nextBtn.hidden = false;
        nextBtn.disabled = (step === 3 && !cvmState.confirmed);
        nextBtn.textContent = step === 3
            ? t('characterMerge.wizard.startMerge')
            : t('characterMerge.wizard.next');
    }

    if (step === 1) contentEl.innerHTML = renderWizardStep1();
    else if (step === 2) contentEl.innerHTML = renderWizardStep2();
    else if (step === 3) contentEl.innerHTML = renderWizardStep3();
    else if (step === 4) contentEl.innerHTML = renderWizardStep4();
    else if (step === 5) contentEl.innerHTML = renderWizardStep5();
}

function cvmRenderDiffValue(label, value) {
    if (value === undefined || value === null || value === '') {
        return `<span class="cvm-diff-empty">${cvmEscapeHtml(label)}: —</span>`;
    }
    const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    if (text.length <= 200) {
        return `<span class="cvm-diff-text">${cvmEscapeHtml(label)}: ${cvmEscapeHtml(text)}</span>`;
    }
    const preview = text.slice(0, 200);
    return `
        <details class="cvm-diff-expand">
            <summary>${cvmEscapeHtml(label)}: ${cvmEscapeHtml(preview)}… <em class="cvt-note">${cvmEscapeHtml(t('characterMerge.diff.expand'))}</em></summary>
            <pre class="cvm-diff-full">${cvmEscapeHtml(text)}</pre>
        </details>
    `;
}

function renderCandidateCardBlock(card, label) {
    return `
        <div class="cvm-candidate-card">
            <div class="cvm-candidate-label">${cvmEscapeHtml(label)}</div>
            <div class="cvm-candidate-filename"><code>${cvmEscapeHtml(card.avatarFileName)}</code>${card.isVaultImported ? ` <span class="cvt-badge" data-kind="info">${cvmEscapeHtml(t('characterMerge.card.vaultImported'))}</span>` : ''}</div>
            <div class="cvm-candidate-row"><span>${cvmEscapeHtml(t('characterMerge.card.size'))}</span><span>${cvmFormatBytes(card.fileSizeBytes)}</span></div>
            <div class="cvm-candidate-row"><span>${cvmEscapeHtml(t('characterMerge.card.modified'))}</span><span>${cvmEscapeHtml(cvmFormatTimestamp(card.modifiedAtMs))}</span></div>
            <div class="cvm-candidate-row"><span>${cvmEscapeHtml(t('characterMerge.card.versionLabel'))}</span><span>${cvmEscapeHtml(card.characterVersion || '—')}</span></div>
            <div class="cvm-candidate-row"><span>${cvmEscapeHtml(t('characterMerge.card.chatCountLabel'))}</span><span>${card.chatCount ?? 0}</span></div>
            <div class="cvm-candidate-row"><span>${cvmEscapeHtml(t('characterMerge.card.backupCountLabel'))}</span><span>${card.vaultBackupCount ?? 0}</span></div>
            <div class="cvm-candidate-row"><span>${cvmEscapeHtml(t('characterMerge.card.sourceLabel'))}</span><span>${cvmEscapeHtml(card.isVaultImported ? t('characterMerge.card.sourceCloud') : t('characterMerge.card.sourceLocal'))}</span></div>
        </div>
    `;
}

function renderWizardStep1() {
    const p = cvmState.preview?.primary || cvmState.primary;
    const s = cvmState.preview?.secondary || cvmState.secondary;
    return `
        <p class="cvt-note">${cvmEscapeHtml(t('characterMerge.wizard.step1.intro'))}</p>
        <div class="cvm-card-pair">
            ${renderCandidateCardBlock(p, 'A')}
            ${renderCandidateCardBlock(s, 'B')}
        </div>
    `;
}

function renderWizardStep2() {
    const diff = cvmState.diff;
    if (!diff) return `<p class="cvt-note">${cvmEscapeHtml(t('common.loading'))}</p>`;

    const allFields = diff.fields.map((f) => ({ ...f, isBook: false }));
    if (diff.characterBook.entryCountA > 0 || diff.characterBook.entryCountB > 0) {
        allFields.push({
            field: 'character_book',
            same: diff.characterBook.same,
            entryCountA: diff.characterBook.entryCountA,
            entryCountB: diff.characterBook.entryCountB,
            isBook: true,
        });
    }
    const sameCount = allFields.filter((f) => f.same).length;
    const diffCount = allFields.length - sameCount;
    const showAll = cvmState.showAllDiffFields === true;
    const visibleFields = showAll ? allFields : allFields.filter((f) => !f.same);

    const rows = visibleFields.map((row) => {
        const status = row.same ? t('characterMerge.diff.same') : t('characterMerge.diff.different');
        if (row.isBook) {
            return `
                <div class="cvm-diff-row ${row.same ? 'cvm-diff-same' : 'cvm-diff-different'}">
                    <div class="cvm-diff-field"><code>${cvmEscapeHtml(row.field)}</code> <span class="cvt-badge" data-kind="${row.same ? 'idle' : 'info'}">${cvmEscapeHtml(status)}</span></div>
                    ${!row.same ? `<div class="cvm-diff-cell">${cvmEscapeHtml(t('characterMerge.diff.bookEntries', { count: row.entryCountA }))} (A) / ${cvmEscapeHtml(t('characterMerge.diff.bookEntries', { count: row.entryCountB }))} (B)</div>` : ''}
                </div>
            `;
        }
        return `
            <div class="cvm-diff-row ${row.same ? 'cvm-diff-same' : 'cvm-diff-different'}">
                <div class="cvm-diff-field"><code>${cvmEscapeHtml(row.field)}</code> <span class="cvt-badge" data-kind="${row.same ? 'idle' : 'info'}">${cvmEscapeHtml(status)}</span></div>
                ${!row.same ? `<div class="cvm-diff-cell">${cvmRenderDiffValue('A', row.valueA)}</div><div class="cvm-diff-cell">${cvmRenderDiffValue('B', row.valueB)}</div>` : ''}
            </div>
        `;
    }).join('');

    const emptyDiffNote = (diffCount === 0 && !showAll)
        ? `<p class="cvt-note cvt-note-strong">${cvmEscapeHtml(t('characterMerge.diff.allSame'))}</p>`
        : '';
    const primary = cvmState.preview?.primary || cvmState.primary;
    const secondary = cvmState.preview?.secondary || cvmState.secondary;

    return `
        <p class="cvt-note">${cvmEscapeHtml(t('characterMerge.wizard.step2.intro'))}</p>
        <div class="cvm-diff-summary">
            <span class="cvt-summary">${cvmEscapeHtml(t('characterMerge.diff.summary', { diff: diffCount, same: sameCount }))}</span>
            <label class="cvm-diff-toggle">
                <input type="checkbox" id="cvm_diff_show_all" ${showAll ? 'checked' : ''}>
                <span>${cvmEscapeHtml(t('characterMerge.diff.showAll'))}</span>
            </label>
        </div>
        ${emptyDiffNote}
        <div class="cvm-diff-list">${rows}</div>
        <div class="cvm-pick-keep cvt-card cvt-card-soft" style="margin-top:14px;">
            <strong>${cvmEscapeHtml(t('characterMerge.wizard.step2.pickHeading'))}</strong>
            <label class="cvm-pick-option"><input type="radio" name="cvm_pick" value="A" checked> ${cvmEscapeHtml(t('characterMerge.wizard.step2.pickA', { name: primary.avatarFileName }))}</label>
            <label class="cvm-pick-option"><input type="radio" name="cvm_pick" value="B"> ${cvmEscapeHtml(t('characterMerge.wizard.step2.pickB', { name: secondary.avatarFileName }))}</label>
            <p class="cvt-note">${cvmEscapeHtml(t('characterMerge.wizard.step2.note'))}</p>
        </div>
    `;
}

function renderWizardStep3() {
    const preview = cvmState.preview;
    if (!preview) return `<p class="cvt-note">${cvmEscapeHtml(t('common.loading'))}</p>`;
    return `
        <p class="cvt-note">${cvmEscapeHtml(t('characterMerge.wizard.step3.intro'))}</p>
        <div class="cvm-preview-summary">
            <div><strong>${cvmEscapeHtml(t('characterMerge.preview.finalAvatar'))}:</strong> <code>${cvmEscapeHtml(preview.finalAvatar)}</code></div>
            <ul class="cvt-bullets">
                <li>${cvmEscapeHtml(t('characterMerge.preview.chatsToMove', { count: preview.chatsToMove }))}</li>
                <li>${cvmEscapeHtml(t('characterMerge.preview.vaultScopesToMerge', { count: preview.vaultScopesToMerge }))}</li>
                <li>${cvmEscapeHtml(t('characterMerge.preview.groupRefsToRewrite', { count: preview.groupRefsToRewrite }))}</li>
                <li>${cvmEscapeHtml(t('characterMerge.preview.personaConnectionRefsToRewrite', { count: preview.personaConnectionRefsToRewrite }))}</li>
            </ul>
            <p class="cvt-note">${cvmEscapeHtml(t('characterMerge.preview.backupNote'))}</p>
            <p class="cvt-note cvt-note-strong">${cvmEscapeHtml(t('characterMerge.preview.refreshHint'))}</p>
            <label class="cvm-confirm">
                <input type="checkbox" id="cvm_confirm_checkbox" ${cvmState.confirmed ? 'checked' : ''}>
                <span>${cvmEscapeHtml(t('characterMerge.preview.confirmLabel'))}</span>
            </label>
        </div>
    `;
}

function renderWizardStep4() {
    return `
        <div class="cvm-execute">
            <p class="cvt-note">${cvmEscapeHtml(t('characterMerge.execute.inProgress'))}</p>
            <p class="cvt-note">${cvmEscapeHtml(t('characterMerge.execute.dontClose'))}</p>
        </div>
    `;
}

function renderWizardStep5() {
    const r = cvmState.executeResult;
    if (!r) return `<p class="cvt-note">${cvmEscapeHtml(t('common.loading'))}</p>`;
    return `
        <div class="cvm-complete">
            <ul class="cvt-bullets">
                <li>${cvmEscapeHtml(t('characterMerge.complete.chatsMoved', { count: r.chatsMoved ?? 0 }))}</li>
                <li>${cvmEscapeHtml(t('characterMerge.complete.finalAvatar', { name: r.finalAvatar || '' }))}</li>
            </ul>
            <p class="cvt-note cvt-note-strong">${cvmEscapeHtml(t('characterMerge.complete.refreshHint'))}</p>
            <div class="cvt-toolbar">
                <button id="cvm_complete_back" type="button" class="menu_button">${cvmEscapeHtml(t('characterMerge.complete.backToList'))}</button>
            </div>
        </div>
    `;
}

async function wizardStepNext() {
    if (cvmState.busy) return;
    const step = cvmState.step;

    if (step === 1) {
        cvmState.step = 2;
        renderWizardStep();
        return;
    }

    if (step === 2) {
        const picked = document.querySelector('input[name="cvm_pick"]:checked')?.value;
        if (picked === 'B') {
            const tmp = cvmState.primary;
            cvmState.primary = cvmState.secondary;
            cvmState.secondary = tmp;
            await loadMergePreview();
        }
        cvmState.step = 3;
        renderWizardStep();
        return;
    }

    if (step === 3) {
        if (!cvmState.confirmed) return;
        cvmState.step = 4;
        renderWizardStep();
        await runMergeExecution();
    }
}

function wizardStepBack() {
    if (cvmState.step > 1 && cvmState.step < 4) {
        cvmState.step -= 1;
        renderWizardStep();
    }
}

async function runMergeExecution() {
    cvmState.busy = true;
    try {
        const result = await callApi('/character-merge/execute', {
            primaryAvatar: cvmState.primary.avatarFileName,
            secondaryAvatar: cvmState.secondary.avatarFileName,
        });
        if (!result?.ok) {
            toastr.error(result?.error || t('characterMerge.execute.failed'));
            cvmState.step = 3;
            renderWizardStep();
            return;
        }
        cvmState.executeResult = result.result;
        cvmState.step = 5;
        renderWizardStep();
    } catch (error) {
        toastr.error(String(error?.message || t('characterMerge.execute.failed')));
        cvmState.step = 3;
        renderWizardStep();
    } finally {
        cvmState.busy = false;
    }
}

async function rollbackPendingMergeAction() {
    if (!window.confirm(t('characterMerge.pending.rollbackConfirm'))) return;
    try {
        const result = await callApi('/character-merge/rollback');
        if (result?.ok) {
            toastr.success(t('characterMerge.pending.rollbackOk'));
        } else {
            toastr.error(result?.error || 'rollback_failed');
        }
    } catch (error) {
        toastr.error(String(error?.message || 'rollback_failed'));
    }
    await refreshCharacterMergeTab();
}

async function acknowledgePendingMergeAction() {
    if (!window.confirm(t('characterMerge.pending.acknowledgeConfirm'))) return;
    try {
        await callApi('/character-merge/acknowledge');
        toastr.success(t('characterMerge.pending.acknowledgeOk'));
    } catch (error) {
        toastr.error(String(error?.message || 'acknowledge_failed'));
    }
    await refreshCharacterMergeTab();
}

function attachDomListeners() {
    $(document).on('click', '#cvt_open_panel_sidebar', () => {
        openPanel('chat');
    });

    $(document).on('click', '.cvt-tab', async function () {
        const tabName = this.dataset.cvtTab;
        if (!tabName) {
            return;
        }

        setActivePanelTab(tabName);
        if (tabName === 'chat' && activeScopeOverride) {
            activeScopeOverride = null;
            updateScopeToolbarState();
            await refreshStatus({ quiet: true });
            return;
        }

        if (tabName === 'recovery') {
            await refreshRecoveryScopes({ quiet: true });
            return;
        }

        if (tabName === 'cloud') {
            await refreshCloudStatus({ quiet: true });
            await refreshCloudScopes({ quiet: true });
        }

        if (tabName === 'character-merge') {
            await refreshCharacterMergeTab();
        }
    });

    $(document).on('click', '#cvm_refresh', async () => {
        await refreshCharacterMergeTab();
    });

    $(document).on('click', '.cvm-start-merge', async function () {
        const name = this.dataset.characterName;
        if (!name) return;
        await startMergeForGroup(name);
    });

    $(document).on('click', '#cvm_wizard_next', () => { wizardStepNext(); });
    $(document).on('click', '#cvm_wizard_back', () => { wizardStepBack(); });
    $(document).on('click', '#cvm_wizard_cancel', () => { exitMergeWizard(); });
    $(document).on('click', '#cvm_complete_back', () => { exitMergeWizard(); });
    $(document).on('click', '#cvm_pending_rollback', () => { rollbackPendingMergeAction(); });
    $(document).on('click', '#cvm_pending_acknowledge', () => { acknowledgePendingMergeAction(); });
    $(document).on('click', '.cvm-rollback-archive', function () {
        const mergeId = this.dataset.mergeId;
        if (mergeId) rollbackCompletedMergeArchive(mergeId);
    });
    $(document).on('change', '#cvm_confirm_checkbox', function () {
        cvmState.confirmed = this.checked;
        const nextBtn = document.getElementById('cvm_wizard_next');
        if (nextBtn) nextBtn.disabled = !cvmState.confirmed;
    });

    $(document).on('change', '#cvm_diff_show_all', function () {
        cvmState.showAllDiffFields = this.checked;
        renderWizardStep();
    });

    $(document).on('click', '.cvt-theme-btn', function () {
        const themeId = this.dataset.theme || 'auto';
        const settings = ensureSettings();
        settings.themeId = Object.hasOwn(THEMES, themeId) ? themeId : 'auto';
        getContext()?.saveSettingsDebounced?.();
        applyTheme(settings.themeId);
    });

    $(document).on('input', '.edit_textarea, .reasoning_edit_textarea', () => {
        scheduleDraftMirror();
    });

    $(document).on('click', '.mes_edit, .mes_reasoning_edit, .mes_edit_add_reasoning', () => {
        scheduleDraftMirror(60);
    });

    $(document).on('click', '.mes_edit_cancel, .mes_reasoning_edit_cancel, .mes_edit_done, .mes_reasoning_edit_done', () => {
        scheduleDraftMirror(60, { allowClear: true });
    });

    $(document).on('click', '#cvt_refresh', async () => {
        await refreshStatus();
    });

    $(document).on('click', '#cvt_snapshot_now', async () => {
        await flushSnapshot('manual', { forceNew: true });
    });

    $(document).on('click', '#cvt_open_recovery', async () => {
        setActivePanelTab('recovery');
        await refreshRecoveryScopes();
    });

    $(document).on('click', '#cvt_scope_refresh', async () => {
        await refreshRecoveryScopes();
    });

    $(document).on('click', '#cvt_scope_cleanup_empty', async () => {
        try {
            await cleanupEmptyRecoveryScopes();
        } catch (error) {
            console.error('[chat-vault] Failed to clean empty recovery scopes:', error);
            toastr.error(t('recovery.cleanupEmptyFailed'), getAppTitle());
        }
    });

    $(document).on('click', '#cvt_cloud_manage', () => {
        openCloudRepositoryDialog();
    });

    $(document).on('click', '#cvt_cloud_help', () => {
        openCloudHelpDialog();
    });

    $(document).on('click', '#cvt_cloud_sync', async () => {
        if (!hasCloudConnectionConfig(cloudConfigCache)) {
            openCloudRepositoryDialog();
            return;
        }
        try {
            toastr.info(t('cloud.toasts.syncStarting'), getAppTitle(), { timeOut: 1400 });
            await syncCloudNow();
        } catch (error) {
            console.error('[chat-vault] Failed to sync cloud:', error);
            toastr.error(t('cloud.toasts.syncFailed'), getAppTitle());
        }
    });

    $(document).on('click', '#cvt_cloud_refresh', async () => {
        if (!hasCloudConnectionConfig(cloudConfigCache)) {
            openCloudRepositoryDialog();
            return;
        }
        try {
            toastr.info(t('cloud.toasts.refreshStarting'), getAppTitle(), { timeOut: 1000 });
            setCloudToolbarBusyState(true);
            await refreshCloudScopes();
        } catch (error) {
            console.error('[chat-vault] Failed to refresh cloud list:', error);
            toastr.error(t('cloud.toasts.listFailed'), getAppTitle());
        } finally {
            setCloudToolbarBusyState(false);
        }
    });

    $(document).on('input', '#cvt_scope_search', () => {
        renderRecoveryScopeList();
    });

    $(document).on('input', '#cvt_checkpoint_search', () => {
        renderCurrentStatus(statusCache || null);
    });

    $(document).on('input', '#cvt_recovery_checkpoint_search', () => {
        renderRecoveryStatus(activeScopeOverride ? statusCache : null);
    });

    $(document).on('input', '#cvt_cloud_scope_search', () => {
        renderCloudScopeList();
    });

    $(document).on('input', '#cvt_cloud_checkpoint_search', () => {
        renderCloudCheckpointList();
    });

    $(document).on('click', '.cvt-section-toggle', function () {
        const sectionKey = this.dataset.cvtToggleSection;
        if (!sectionKey) {
            return;
        }
        setSectionCollapsed(sectionKey, !isSectionCollapsed(sectionKey));
    });

    $(document).on('click', '#cvt_back_to_chat', async () => {
        activeScopeOverride = null;
        setActivePanelTab('chat');
        updateScopeToolbarState();
        await refreshStatus({ quiet: true });
    });

    $(document).on('click', '#cvt_restore_draft', async () => {
        await restoreDraftIntoEditor();
    });

    $(document).on('click', '#cvt_clear_draft', async () => {
        await clearDraft();
    });

    $(document).on('change input', '#cvt_show_trigger, #cvt_enabled, #cvt_show_recovery_toast, #cvt_auto_slots, #cvt_save_delay, #cvt_draft_delay, #cvt_restore_name_template, #cvt_snapshot_file_template', () => {
        saveSettingsFromDom();
    });

    $(document).on('click', '#cvt_checkpoint_list [data-action], #cvt_recovery_checkpoint_list [data-action]', async function () {
        const action = this.dataset.action;
        const snapshotId = this.dataset.snapshotId;
        const sourceOverride = decodeDataJson(this.dataset.source);
        if (!snapshotId) {
            return;
        }

        try {
            if (action === 'preview') {
                await previewSnapshot(snapshotId, sourceOverride);
                return;
            }

            if (action === 'rename') {
                await renameSnapshot(snapshotId, sourceOverride);
                return;
            }

            if (action === 'restore-new') {
                await restoreSnapshotAsNew(snapshotId, sourceOverride);
                return;
            }

            if (action === 'overwrite') {
                await overwriteCurrentChat(snapshotId);
                return;
            }

            if (action === 'pin') {
                await togglePinSnapshot(snapshotId, sourceOverride);
                return;
            }

            if (action === 'delete') {
                await deleteSnapshot(snapshotId, sourceOverride);
            }
        } catch (error) {
            console.error('[chat-vault] Action failed:', action, error);
            toastr.error(t('common.operationFailed'), getAppTitle());
        }
    });

    $(document).on('click', '#cvt_scope_list [data-action="open-scope"]', async function () {
        const scopeId = this.dataset.scopeId;
        if (!scopeId) {
            return;
        }

        try {
            await openRecoveryScope(scopeId);
        } catch (error) {
            console.error('[chat-vault] Failed to open recovery scope:', error);
            toastr.error(t('recovery.openFailed'), getAppTitle());
        }
    });

    $(document).on('click', '#cvt_scope_list [data-action="delete-scope"]', async function () {
        const scopeId = this.dataset.scopeId;
        if (!scopeId) {
            return;
        }

        try {
            await deleteRecoveryScope(scopeId);
        } catch (error) {
            console.error('[chat-vault] Failed to delete recovery scope:', error);
            toastr.error(t('recovery.deleteScopeFailed'), getAppTitle());
        }
    });

    $(document).on('click', '#cvt_cloud_scope_list [data-action="open-cloud-scope"]', function () {
        const scopeId = this.dataset.scopeId;
        if (!scopeId) {
            return;
        }
        openCloudScope(scopeId);
    });

    $(document).on('click', '#cvt_cloud_checkpoint_list [data-action]', async function () {
        const action = this.dataset.action;
        const snapshotId = this.dataset.snapshotId;
        const repositoryId = this.dataset.repositoryId;
        const scopeId = activeCloudScopeId;
        if (!scopeId || !snapshotId || !repositoryId) {
            return;
        }

        try {
            if (action === 'cloud-preview') {
                await previewCloudSnapshot(scopeId, snapshotId, repositoryId);
                return;
            }

            if (action === 'cloud-import') {
                await importCloudSnapshot(scopeId, snapshotId, repositoryId);
                return;
            }

            if (action === 'cloud-restore-new') {
                await restoreCloudSnapshotAsNew(scopeId, snapshotId, repositoryId);
                return;
            }

            if (action === 'cloud-delete') {
                await deleteCloudSnapshot(scopeId, snapshotId, repositoryId);
                return;
            }
        } catch (error) {
            console.error('[chat-vault] Cloud action failed:', action, error);
            toastr.error(t('common.operationFailed'), getAppTitle());
        }
    });
}

function attachChatListeners() {
    const context = getContext();
    if (!context) {
        return;
    }

    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes || context.event_types;
    if (!eventSource || !eventTypes) {
        return;
    }

    const commitEvents = [
        eventTypes.MESSAGE_SENT,
        eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_SWIPED,
    ];

    for (const eventType of commitEvents) {
        eventSource.on(eventType, (...args) => onCommitEvent(eventType, ...args));
    }

    eventSource.on(eventTypes.GENERATION_STARTED, (generationType) => {
        if (generationType === 'swipe') {
            clearPendingSwipeSnapshot();
        }
    });

    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        clearPendingSwipeSnapshot();
        lastDraftSignature = '';
        await refreshStatus({ quiet: true });
    });
}

async function mountUi() {
    if (!document.getElementById('chat_vault_settings')) {
        const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
        $('#extensions_settings').append(settingsHtml);
    }

    applyI18n(document.getElementById('chat_vault_settings'));
    buildAndMountFloatingUi();
    applySettingsToDom();
    setBackendStatus(t('status.checking'), 'idle');
    updateScopeToolbarState();
    renderRecoveryStatus(null);
}

jQuery(async () => {
    ensureSettings();
    await initializeI18n();
    installRenameBridge();
    await mountUi();
    attachDomListeners();
    attachChatListeners();
    await probeBackend();
    await refreshStatus({ quiet: true });
    await refreshCloudStatus({ quiet: true });
});
