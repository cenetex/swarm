/**
 * i18n configuration — initializes i18next with English (default) and French.
 *
 * Language preference is persisted to localStorage under 'i18n-lang'.
 * Falls back to browser language, then English.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';
import zhCN from './locales/zh-CN.json';

const STORAGE_KEY = 'i18n-lang';

function getInitialLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && ['en', 'fr', 'zh-CN'].includes(stored)) return stored;
    const browser = navigator.language;
    if (browser.startsWith('fr')) return 'fr';
    if (browser.startsWith('zh')) return 'zh-CN';
  } catch {
    // SSR or test environment — fall through to default
  }
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    fr: { translation: fr },
    'zh-CN': { translation: zhCN },
  },
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

// Persist language changes
i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
    document.documentElement.lang = lng;
  } catch {
    // SSR or test environment
  }
});

export default i18n;
