import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import es, { type MessageKey } from "./locales/es";
import en from "./locales/en";
import fr from "./locales/fr";
import gl from "./locales/gl";
import ca from "./locales/ca";

export const LOCALES = {
  es: { label: "Español", messages: es },
  en: { label: "English", messages: en },
  fr: { label: "Français", messages: fr },
  gl: { label: "Galego", messages: gl },
  ca: { label: "Català", messages: ca },
} as const;

export type Locale = keyof typeof LOCALES;
export const LOCALE_CODES = Object.keys(LOCALES) as Locale[];

const STORAGE_KEY = "meshtastic-es-configurador:locale";

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in LOCALES) return stored as Locale;
  } catch {
    // localStorage puede no estar disponible (modo privado, etc.): seguimos con el idioma del navegador.
  }
  const navLangs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  for (const lang of navLangs) {
    const short = lang.slice(0, 2).toLowerCase();
    if (short in LOCALES) return short as Locale;
  }
  return "es";
}

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string;

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Sin localStorage disponible, el idioma simplemente no persiste entre sesiones.
    }
  }, []);

  const t = useCallback<TFunction>(
    (key, vars) => interpolate(LOCALES[locale].messages[key], vars),
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n debe usarse dentro de <I18nProvider>");
  return ctx;
}
