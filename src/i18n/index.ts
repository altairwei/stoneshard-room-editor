// The i18n runtime, shared by the renderer (main.ts and friends) and the Node server
// (server/*.ts). The catalog lives in lang/{zh,en,ru}.ts; the server imports `tr`, the
// browser imports `t` (bound to the module's active lang) and `setLang`.
//
// Keys ARE the zh text. Lookup is lang pack -> zh pack overrides -> the key itself, so an
// untranslated or unconverted string always falls back to exactly what the UI showed
// before i18n existed. That single rule is what lets this ship file-at-a-time: zh stays
// byte-identical, and the e2e suite (which asserts zh under the default lang) is green
// at every step of the conversion.
//
// Interpolation uses `{name}` placeholders in the key, e.g.
//   t("撤销：{label}", { label })        // the key IS the zh template
//   tr("en", "撤销：{label}", { label }) // -> "Undo: {label}" with {label} filled
import { zh } from "./lang/zh.ts";
import { en } from "./lang/en.ts";
import { ru } from "./lang/ru.ts";

export type Lang = "zh" | "en" | "ru";
export const LANGS: readonly { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
];

const PACKS: Record<Lang, Record<string, string>> = { zh, en, ru };

// Only meaningfully read in the browser (the server passes an explicit lang to `tr`).
let lang: Lang = "zh";

export function getLang(): Lang {
  return lang;
}

// Persist the choice and re-hydrate any static [data-t] text. Mirrors svre.theme: the
// index.html inline script read svre.lang before first paint (dataset.lang), init() then
// calls initLang() and from here on this owns the state.
export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem("svre.lang", l);
  } catch {
    /* private mode */
  }
  document.documentElement.lang = l === "zh" ? "zh-CN" : l;
}

export function initLang(): Lang {
  let l: Lang = "zh";
  try {
    const stored = localStorage.getItem("svre.lang");
    if (stored === "en" || stored === "ru") l = stored;
  } catch {
    /* private mode */
  }
  if (document.documentElement.dataset.lang === "en" || document.documentElement.dataset.lang === "ru")
    l = document.documentElement.dataset.lang as Lang;
  setLang(l);
  return l;
}

function fill(s: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, n: string) => (n in params! ? String(params![n]) : m));
}

// Browser-side: translate against the module's active lang.
export function t(key: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  return fill(PACKS[lang][key] ?? key, params);
}

// Server-side / explicit-lang: the caller supplies the lang (per-request ?lang=), never
// the module state.
export function tr(l: Lang, key: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  return fill(PACKS[l][key] ?? (l === "zh" ? key : PACKS.zh[key] ?? key), params);
}

// ---------------- game object display names ----------------
// The extract step emits assets/lang/objnames.json: { "<object>": { ru, en, zh } } for the
// ~254 objects whose in-game name comes from global.inv_text (each object hardcodes a row
// in its Create). The asset loader calls setObjNames() once it is in; objName() carries
// the active lang. Objects the game does not name return "" so callers fall back to the
// stripped code name, exactly as the palette always showed.
export type ObjName = { ru: string; en: string; zh: string };
let objNames: Record<string, ObjName> = {};

export function setObjNames(m: Record<string, ObjName>) {
  objNames = m;
}

export function objName(code: string): string {
  const n = objNames[code];
  return n ? n[lang] || n.zh || "" : "";
}

// Re-paint every static [data-t] element in index.html. Element attributes:
//   data-t   -> element textContent
//   data-tt  -> element .title
//   data-tp  -> <input>.placeholder
// Elements that carry structure (an injected <b>/<code>/icon child, e.g. the setup
// wizard's version line) are left for their owning JS to rebuild with t().
export function hydrate() {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-t]"))) {
    if (el.children.length) continue;
    el.textContent = t(el.getAttribute("data-t")!);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-tt]"))) el.title = t(el.getAttribute("data-tt")!);
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-tp]"))) {
    if (el instanceof HTMLInputElement) el.placeholder = t(el.getAttribute("data-tp")!);
  }
}