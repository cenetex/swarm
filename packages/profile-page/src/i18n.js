import i18next from 'i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';
import zhCN from './locales/zh-CN.json';

const STORAGE_KEY = 'profile-page-lang';
const SUPPORTED_LANGUAGES = ['en', 'fr', 'zh-CN'];

function detectLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
      return stored;
    }

    const browserLanguage = navigator.language || 'en';
    if (browserLanguage.startsWith('fr')) {
      return 'fr';
    }
    if (browserLanguage.startsWith('zh')) {
      return 'zh-CN';
    }
  } catch {
    // Browser APIs may be unavailable during prerendering or tests.
  }

  return 'en';
}

const i18n = i18next.createInstance();

export const ready = i18n.init({
  resources: {
    en: { translation: en },
    fr: { translation: fr },
    'zh-CN': { translation: zhCN },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
    document.documentElement.lang = lng;
  } catch {
    // Ignore storage/document failures in non-browser contexts.
  }
});

document.documentElement.lang = i18n.language || 'en';

export function t(key, options) {
  return i18n.t(key, options);
}

export function getLanguage() {
  return i18n.resolvedLanguage || i18n.language || 'en';
}

export function getI18n() {
  return i18n;
}
