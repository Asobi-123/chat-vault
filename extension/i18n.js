let translations = {};

export async function initializeI18n() {
    const locale = detectLocale();
    try {
        const url = new URL(`./i18n/${locale}.json`, import.meta.url);
        const response = await fetch(url);
        if (response.ok) {
            translations = await response.json();
        }
    } catch {
        translations = {};
    }
}

function detectLocale() {
    const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
    if (lang.startsWith('zh')) {
        return 'zh-cn';
    }
    return 'en-us';
}

export function t(key, replacements) {
    const rawText = translations[key] ?? key;
    if (!replacements) {
        return rawText;
    }

    let text = rawText;
    for (const [name, value] of Object.entries(replacements)) {
        text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
}

export function applyI18n(root = document) {
    root.querySelectorAll?.('[data-i18n]').forEach((node) => {
        const key = node.getAttribute('data-i18n');
        if (!key) {
            return;
        }
        node.textContent = t(key);
    });

    root.querySelectorAll?.('[data-i18n-placeholder]').forEach((node) => {
        const key = node.getAttribute('data-i18n-placeholder');
        if (!key) {
            return;
        }
        node.setAttribute('placeholder', t(key));
    });
}
