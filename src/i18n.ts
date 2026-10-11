import { useSyncExternalStore } from "react";
import english from "./locales/en.json";
export type Language = "zh" | "en";
export const LANGUAGE_STORAGE_KEY = "blotlens.language";
let language: Language = "zh";
try {
  if (
    typeof window !== "undefined" &&
    window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en"
  )
    language = "en";
} catch {
  /* Optional preference storage. */
}
const listeners = new Set<() => void>();
export function setLanguage(next: Language) {
  language = next;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    /* Switching still works without storage. */
  }
  for (const listener of listeners) listener();
}
export function getLanguage() {
  return language;
}
export function useLanguage() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    getLanguage,
    () => "zh" as Language,
  );
}
const dictionary: Record<string, string> = english;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = Object.entries(dictionary)
  .filter(([key]) => /\{\d+\}/.test(key))
  .map(([key, translated]) => ({
    expression: new RegExp(
      "^" +
        key
          .split(/\{\d+\}/)
          .map(escape)
          .join("([\\s\\S]*?)") +
        "$",
    ),
    translated,
  }));
/** Translates application messages only. Never apply to user/model protein or lane labels. */
export function translate(
  text: string,
  locale: Language,
  values: (string | number)[] = [],
  depth = 0,
): string {
  let result = text;
  if (locale === "en") {
    if (Object.hasOwn(dictionary, text)) result = dictionary[text];
    else if (depth < 3)
      for (const pattern of patterns) {
        const match = text.match(pattern.expression);
        if (match)
          return pattern.translated.replace(/\{(\d+)\}/g, (_, i: string) =>
            translate(match[Number(i) + 1], locale, [], depth + 1),
          );
      }
  }
  return result.replace(/\{(\d+)\}/g, (match, i: string) =>
    values[Number(i)] === undefined ? match : String(values[Number(i)]),
  );
}
export function t(text: string, ...values: (string | number)[]) {
  return translate(text, language, values);
}
/** Keep stored notices canonical so they can be re-rendered in either language. */
export function message(text: string, ...values: (string | number)[]) {
  return translate(text, "zh", values);
}
