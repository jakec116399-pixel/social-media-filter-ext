import { ext } from "../shared/ext";
import { getSettings, saveSettings } from "../shared/settings";
import { LABELS, labelName, type Category, type DayStats, type UserExamples } from "../shared/types";

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

  const stats: DayStats = await ext.runtime.sendMessage({ type: "get-stats" });
  const total = Object.values(stats.hidden).reduce((a, b) => a + (b ?? 0), 0);
  $("hidden-count").textContent = String(total);
  $("sub").textContent = `posts hidden today${stats.scanned ? ` · ${stats.scanned} checked by AI` : ""}`;
  $("rows").replaceChildren(
    ...([...LABELS.map((l) => l.id), "offgoal"] as Category[])
      .filter((id) => stats.hidden[id])
      .sort((a, b) => (stats.hidden[b] ?? 0) - (stats.hidden[a] ?? 0))
      .map((id) => ({ id, label: labelName(id) }))
      .map((c) => {
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
  $("settings").addEventListener("click", () => ext.runtime.openOptionsPage());

  const { examples } = (await ext.storage.local.get("examples")) as { examples?: UserExamples };
  const n = (examples?.hide.length ?? 0) + (examples?.keep.length ?? 0);
  if (n) {
    $("taught").textContent =
      `Learned from ${n} post${n === 1 ? "" : "s"} you taught it (right-click a post → Focus Feed).`;
    $("forget").hidden = false;
  }
  $("report").addEventListener("click", async () => {
    const report: string = await ext.runtime.sendMessage({ type: "get-report" });
    await navigator.clipboard.writeText(report);
    $("copied").textContent = "Copied. Paste it to whoever is tuning the filter. It contains recent post text.";
  });
  $("forget").addEventListener("click", async () => {
    if (!confirm("Forget every post you taught Focus Feed?")) return;
    await ext.runtime.sendMessage({ type: "clear-learning" });
    $("forget").hidden = true;
    $("taught").textContent = "Forgotten. Right-click any post → Focus Feed to teach it again.";
  });
}

void init();
