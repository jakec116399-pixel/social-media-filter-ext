import { DEFAULT_SETTINGS, type Settings } from "./types";

export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    categories: { ...DEFAULT_SETTINGS.categories, ...raw?.categories },
    goals: raw?.goals ?? [],
    allowAccounts: raw?.allowAccounts ?? [],
  };
}

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.sync.get("settings");
  return normalizeSettings(r.settings as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings: s });
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) cb(normalizeSettings(changes.settings.newValue as Partial<Settings>));
  });
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
