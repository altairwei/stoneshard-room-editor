// Per-request UI language for server-side message construction.
//
// The renderer appends ?lang= to every API call (see api() in main.ts). The server's
// message strings (HttpError texts, diagnostics warnings, diagnostics, log labels) are
// built deep inside async handlers, and requests interleave on awaits (an extract run
// takes minutes while other requests keep answering). A module-level current-lang would
// be a race; AsyncLocalStorage scopes the lang to exactly one request's async flow, so
// any continuation of that handler -- after readJson, runExtract, installUtmt -- still
// reads the language the page asked for.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Lang } from "../src/i18n/index.ts";

const store = new AsyncLocalStorage<Lang>();

/** The lang of the request currently being handled; zh when none (e.g. the `svre` CLI). */
export const reqLang = (): Lang => store.getStore() ?? "zh";

/** Accept only the langs the renderer offers; anything else stays zh. */
export const parseLang = (v: string | null | undefined): Lang => (v === "en" || v === "ru" ? v : "zh");

/** Run `fn` in the context of `lang`, for the whole async flow of one request. */
export const withLang = <T>(lang: Lang, fn: () => Promise<T> | T): Promise<T> | T => store.run(lang, fn);