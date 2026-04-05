import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveChat } from '../../../../script.js';
import { saveGroupBookmarkChat } from '../../../group-chats.js';
import { callGenericPopup, POPUP_TYPE, Popup } from '../../../popup.js';
import { waitUntilCondition } from '../../../utils.js';
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
const THEMES = Object.freeze({
    auto: null,
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
let currentThemeId = 'auto';

function buildThemeButtons() {
    return Object.keys(THEMES).map((themeId) => {
        const palette = THEMES[themeId];
        const swatchStyle = palette
            ? `background:linear-gradient(135deg,${palette.surface},${palette.bg});border:1px solid ${palette.border};`
            : 'background:transparent;border:1px dashed currentColor;';
        return `<button type="button" class="cvt-theme-btn${currentThemeId === themeId ? ' active' : ''}" data-theme="${themeId}"><span class="cvt-theme-swatch" style="${swatchStyle}"></span><span class="cvt-theme-label">${t(`theme.${themeId}`)}</span></button>`;
    }).join('');
}

function getAppTitle() {
    return t('app.title');
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
                <button type="button" class="cvt-tab" data-cvt-tab="settings">${t('tabs.settings')}</button>
            </nav>
            <div class="cvt-body">
                <section class="cvt-page active" data-cvt-page="chat">
                    <div class="cvt-card">
                        <div class="cvt-status-row">
                            <span id="cvt_backend_status" class="cvt-badge" data-kind="idle">${t('status.checking')}</span>
                            <span id="cvt_current_summary" class="cvt-summary">${t('common.loading')}</span>
                        </div>
                        <div class="cvt-toolbar" style="margin-top:10px;">
                            <button id="cvt_refresh" type="button" class="menu_button">${t('common.refresh')}</button>
                            <button id="cvt_snapshot_now" type="button" class="menu_button">${t('chat.toolbar.backupNow')}</button>
                            <button id="cvt_open_recovery" type="button" class="menu_button">${t('chat.toolbar.recovery')}</button>
                        </div>
                        <div class="cvt-note">${t('chat.toolbarHint')}</div>
                    </div>

                    <div id="cvt_draft_card" class="cvt-card cvt-card-soft" hidden>
                        <div class="cvt-draft-title">${t('draft.detected')}</div>
                        <div id="cvt_draft_meta" class="cvt-draft-meta"></div>
                        <div id="cvt_draft_preview" class="cvt-draft-preview"></div>
                        <div class="cvt-toolbar">
                            <button id="cvt_restore_draft" type="button" class="menu_button">${t('draft.restore')}</button>
                            <button id="cvt_clear_draft" type="button" class="menu_button">${t('draft.clear')}</button>
                        </div>
                        <div class="cvt-note">${t('draft.note')}</div>
                    </div>

                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('chat.section.backups')}</strong>
                            <span class="cvt-hint">${t('chat.section.backupsHint')}</span>
                        </div>
                        <div id="cvt_checkpoint_list" class="cvt-list">
                            <div class="cvt-empty">${t('common.loading')}</div>
                        </div>
                        <div class="cvt-note">${t('chat.backupsNote')}</div>
                    </div>
                </section>

                <section class="cvt-page" data-cvt-page="recovery">
                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('recovery.section.title')}</strong>
                            <span id="cvt_recovery_summary" class="cvt-summary">${t('status.recoveryIdle')}</span>
                        </div>
                        <div class="cvt-toolbar">
                            <button id="cvt_scope_refresh" type="button" class="menu_button">${t('recovery.refreshList')}</button>
                            <button id="cvt_back_to_chat" type="button" class="menu_button" hidden>${t('recovery.backToChat')}</button>
                        </div>
                        <div class="cvt-field" style="margin-top:10px;">
                            <span>${t('recovery.searchLabel')}</span>
                            <input id="cvt_scope_search" class="text_pole" type="text" placeholder="${t('recovery.searchPlaceholder')}">
                        </div>
                        <div class="cvt-note cvt-note-strong">${t('recovery.useCase')}</div>
                        <div class="cvt-note">${t('recovery.capability')}</div>
                    </div>

                    <div class="cvt-recovery-grid">
                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('recovery.section.scope')}</strong>
                                <span class="cvt-hint">${t('recovery.section.scopeHint')}</span>
                            </div>
                            <div id="cvt_scope_list" class="cvt-list">
                                <div class="cvt-empty">${t('common.loading')}</div>
                            </div>
                        </div>

                        <div class="cvt-card">
                            <div class="cvt-section-head">
                                <strong>${t('recovery.section.selected')}</strong>
                                <span class="cvt-hint">${t('recovery.section.selectedHint')}</span>
                            </div>
                            <div id="cvt_recovery_checkpoint_list" class="cvt-list">
                                <div class="cvt-empty">${t('recovery.emptySelectFirst')}</div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="cvt-page" data-cvt-page="settings">
                    <div class="cvt-card">
                        <div class="cvt-section-head">
                            <strong>${t('settings.theme')}</strong>
                            <span class="cvt-hint">${t('settings.themeHint')}</span>
                        </div>
                        <div class="cvt-theme-grid">${buildThemeButtons()}</div>
                        <div class="cvt-note">${t('settings.themeNote')}</div>
                    </div>

                    <div class="cvt-card">
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

                    <div class="cvt-card">
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
    overlay.style.display = 'flex';

    if (tabName === 'recovery') {
        void refreshRecoveryScopes({ quiet: true });
    }
}

function closePanel() {
    const overlay = document.getElementById(PANEL_IDS.overlay);
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function applyTheme(themeId = 'auto') {
    const modal = document.getElementById(PANEL_IDS.modal);
    const trigger = document.getElementById(PANEL_IDS.trigger);
    currentThemeId = Object.hasOwn(THEMES, themeId) ? themeId : 'auto';

    if (modal) {
        const palette = THEMES[currentThemeId];
        if (!palette) {
            modal.removeAttribute('style');
        } else {
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
            Object.entries(vars).forEach(([key, value]) => {
                modal.style.setProperty(key, value);
            });
        }
    }

    if (trigger) {
        const palette = THEMES[currentThemeId];
        if (!palette) {
            trigger.style.removeProperty('background');
            trigger.style.removeProperty('border-color');
            trigger.style.removeProperty('color');
            trigger.style.removeProperty('box-shadow');
        } else {
            trigger.style.background = palette.bg;
            trigger.style.borderColor = palette.border;
            trigger.style.color = palette.text;
            trigger.style.boxShadow = '0 6px 20px rgba(0,0,0,.35)';
        }
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

    const overlay = document.createElement('div');
    overlay.id = PANEL_IDS.overlay;
    overlay.className = 'cvt-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = buildPanelHtml();
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closePanel();
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
    };
    return extension_settings[SETTINGS_KEY];
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

function getHeaders() {
    const context = getContext();
    return {
        ...(context?.getRequestHeaders ? context.getRequestHeaders() : {}),
        'Content-Type': 'application/json',
    };
}

async function callApi(path, body = {}) {
    const response = await fetch(`${API_ROOT}${path}`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || response.statusText || 'Request failed');
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }

    return {};
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

function buildCheckpointItem(entry, { allowOverwrite = true } = {}) {
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
    meta.textContent = metaParts.join(' · ');

    const preview = document.createElement('div');
    preview.className = 'cvt-item-preview';
    preview.textContent = entry.lastMessagePreview || t('chat.emptyNoPreview');

    const actions = document.createElement('div');
    actions.className = 'cvt-item-actions';

    const actionList = [
        { action: 'preview', text: t('common.preview') },
        { action: 'rename', text: t('common.rename') },
        { action: 'restore-new', text: t('actions.restoreNew') },
        { action: 'pin', text: entry.pinned ? t('actions.keepOff') : t('actions.keepOn') },
        { action: 'delete', text: t('common.delete'), danger: true },
    ];

    if (allowOverwrite) {
        actionList.splice(3, 0, { action: 'overwrite', text: t('actions.overwriteCurrent'), danger: true });
    }

    for (const action of actionList) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = action.danger ? 'menu_button cvt-danger' : 'menu_button';
        button.dataset.action = action.action;
        button.dataset.snapshotId = entry.id;
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

function renderCheckpointListInto(containerId, entries, { allowOverwrite = true, emptyText = t('status.currentEmpty') } = {}) {
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
        container.appendChild(buildCheckpointItem(entry, { allowOverwrite }));
    }
}

function renderCurrentStatus(status) {
    const summary = document.getElementById('cvt_current_summary');
    if (summary) {
        if (status?.unavailable) {
            summary.textContent = t('status.currentUnavailable');
        } else if (!status?.source?.chatId) {
            summary.textContent = t('status.currentNoChat');
        } else if (!status?.entries?.length) {
            summary.textContent = t('status.currentEmpty');
        } else {
            const latest = status.entries[0];
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

    renderCheckpointListInto('cvt_checkpoint_list', status?.entries || [], {
        allowOverwrite: true,
        emptyText: t('status.currentEmpty'),
    });
}

function renderRecoveryStatus(status) {
    const summary = document.getElementById('cvt_recovery_summary');
    const selectedSource = status?.source || activeScopeOverride;

    if (summary) {
        if (!activeScopeOverride) {
            summary.textContent = t('status.recoveryIdle');
        } else if (status?.unavailable) {
            summary.textContent = t('status.recoveryUnavailable');
        } else if (!status?.entries?.length) {
            summary.textContent = t('status.recoveryEmpty', {
                label: getScopeDisplayLabel(selectedSource),
            });
        } else {
            const latest = status.entries[0];
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

    renderCheckpointListInto('cvt_recovery_checkpoint_list', status?.entries || [], {
        allowOverwrite: false,
        emptyText: t('status.recoveryEmpty', {
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

async function fetchSnapshot(snapshotId) {
    const source = getActionSource();
    if (!source) {
        throw new Error('No active chat');
    }

    return callApi('/snapshot/get', {
        source,
        snapshotId,
    });
}

async function previewSnapshot(snapshotId) {
    const source = getActionSource();
    if (!source) {
        return;
    }

    const result = await callApi('/snapshot/preview', {
        source,
        snapshotId,
        limit: getSettings().previewMessages,
    });

    const textArea = document.createElement('textarea');
    textArea.className = 'text_pole monospace textarea_compact margin0 height100p';
    textArea.readOnly = true;
    textArea.value = (result.previewMessages || [])
        .map((message) => {
            const stamp = message.sendDate ? ` [${message.sendDate}]` : '';
            return `${message.name || t('common.unknownSpeaker')}${stamp}\n${message.text || ''}`;
        })
        .join('\n\n');

    await callGenericPopup(textArea, POPUP_TYPE.TEXT, '', {
        allowVerticalScrolling: true,
        large: true,
        wide: true,
    });
}

async function restoreSnapshotAsNew(snapshotId) {
    const context = getContext();
    const source = getActionSource();
    if (!context || !source) {
        return;
    }

    const result = await fetchSnapshot(snapshotId);
    const entry = result.entry || {};
    const header = result.header || {};
    const messages = Array.isArray(result.messages) ? result.messages : [];
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
        await saveGroupBookmarkChat(source.groupId, chatName, cloneJson(header.chat_metadata, {}), undefined, messages);
        await context.openGroupChat(source.groupId, chatName);
    } else {
        const targetCharacterId = findCharacterIdBySource(source);
        if (targetCharacterId < 0) {
            toastr.error(t('toasts.missingCharacter'), getAppTitle());
            return;
        }
        if (String(context.characterId ?? '') !== String(targetCharacterId)) {
            await context.selectCharacterById(targetCharacterId, { switchMenu: false });
        }
        await saveChat({
            chatName,
            withMetadata: cloneJson(header.chat_metadata, {}),
            chatData: messages,
        });
        await context.openCharacterChat(chatName);
    }

    toastr.success(t('toasts.restoredNewChat'), getAppTitle());
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

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    if (!response.ok) {
        toastr.error(t('toasts.overwriteFailed'), getAppTitle());
        return;
    }

    await context.reloadCurrentChat();
    await refreshStatus({ quiet: true });
    toastr.success(t('toasts.overwriteDone'), getAppTitle());
}

async function togglePinSnapshot(snapshotId) {
    const source = getActionSource();
    if (!source) {
        return;
    }

    await callApi('/snapshot/pin', {
        source,
        snapshotId,
    });

    await refreshStatus({ quiet: true });
}

async function deleteSnapshot(snapshotId) {
    const source = getActionSource();
    if (!source) {
        return;
    }

    const confirm = await Popup.show.confirm(t('popup.deleteBackup.title'), t('popup.deleteBackup.body'));
    if (!confirm) {
        return;
    }

    await callApi('/snapshot/delete', {
        source,
        snapshotId,
    });

    await refreshStatus({ quiet: true });
}

async function renameSnapshot(snapshotId) {
    const source = getActionSource();
    if (!source) {
        return;
    }

    const entry = statusCache?.entries?.find((item) => item.id === snapshotId);
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
        }
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

    $(document).on('input', '#cvt_scope_search', () => {
        renderRecoveryScopeList();
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
        if (!snapshotId) {
            return;
        }

        try {
            if (action === 'preview') {
                await previewSnapshot(snapshotId);
                return;
            }

            if (action === 'rename') {
                await renameSnapshot(snapshotId);
                return;
            }

            if (action === 'restore-new') {
                await restoreSnapshotAsNew(snapshotId);
                return;
            }

            if (action === 'overwrite') {
                await overwriteCurrentChat(snapshotId);
                return;
            }

            if (action === 'pin') {
                await togglePinSnapshot(snapshotId);
                return;
            }

            if (action === 'delete') {
                await deleteSnapshot(snapshotId);
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
});
