import { ext } from "./ext.ts";
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const cats = { ...raw?.categories } as Record<string, boolean>;
  // v0.2 had a single "clickbait" category; it is now three tones.
  if ("clickbait" in cats) {
    for (const t of ["ragebait", "engagementbait", "vaguepost"]) cats[t] ??= cats.clickbait;
    delete cats.clickbait;
  }
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    categories: { ...DEFAULT_SETTINGS.categories, ...cats },
    goals: raw?.goals ?? [],
    allowAccounts: raw?.allowAccounts ?? [],
  };
}

export async function getSettings(): Promise<Settings> {
  const r = await ext.storage.sync.get("settings");
  return normalizeSettings(r.settings as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await ext.storage.sync.set({ settings: s });
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) cb(normalizeSettings(changes.settings.newValue as Partial<Settings>));
  });
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
