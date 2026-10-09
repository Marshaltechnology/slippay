import { useEffect, useState } from "react";

// Landing locale. PT is PRIMARY — the audience is Brazilians who earn in
// dollars (freelancers, IT/dev exporters, creators, gig workers), they read
// Portuguese. We default to PT and only switch to EN when the browser is
// explicitly non-pt (the EN mirror is the secondary). Persisted in localStorage
// so a manual toggle sticks.
export type Lang = "pt" | "en";

const KEY = "slippay_lang";

export function detectLang(): Lang {
  if (typeof window === "undefined") return "pt";
  const stored = window.localStorage.getItem(KEY);
  if (stored === "pt" || stored === "en") return stored;
  // Default to PT (primary audience). Only EN for an explicitly English browser.
  return navigator.language?.toLowerCase().startsWith("en") ? "en" : "pt";
}

export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>(() => detectLang());
  useEffect(() => {
    document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
  }, [lang]);
  const setLang = (l: Lang) => {
    try { window.localStorage.setItem(KEY, l); } catch { /* ignore */ }
    setLangState(l);
  };
  return [lang, setLang];
}
