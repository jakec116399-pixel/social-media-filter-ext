import { getSettings, saveSettings } from "../shared/settings";
import { CATEGORIES, type DayStats } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function init() {
  const s = await getSettings();
  const toggle = $<HTMLInputElement>("enabled");
  toggle.checked = s.enabled;
  document.body.classList.toggle("off", !s.enabled);
  toggle.addEventListener("change", async () => {
    s.enabled = toggle.checked;
    document.body.classList.toggle("off", !s.enabled);
    await saveSettings(s);
  });

  const stats: DayStats = await chrome.runtime.sendMessage({ type: "get-stats" });
  const total = Object.values(stats.hidden).reduce((a, b) => a + (b ?? 0), 0);
  $("hidden-count").textContent = String(total);
  $("sub").textContent = `posts hidden today${stats.scanned ? ` · ${stats.scanned} checked by AI` : ""}`;
  $("rows").replaceChildren(
    ...CATEGORIES.filter((c) => s.categories[c.id] || stats.hidden[c.id]).map((c) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "muted";
      name.textContent = c.label;
      const n = document.createElement("span");
      n.textContent = String(stats.hidden[c.id] ?? 0);
      li.append(name, n);
      return li;
    }),
  );
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
}

void init();
