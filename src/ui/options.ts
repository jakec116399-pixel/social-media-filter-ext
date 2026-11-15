import { ext } from "../shared/ext";
import { getSettings, saveSettings } from "../shared/settings";
import { GOAL_PRESETS } from "../shared/textModel";
import { LABELS, type Category, type LabelGroup, type Settings, type Strictness } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const onboarding = new URLSearchParams(location.search).has("onboarding");
document.body.classList.toggle("onboarding", onboarding);

const STRICT_HINTS: Record<Strictness, string> = {
  relaxed: "Only hides posts that clearly match. Fewer mistakes, more slips through.",
  balanced: "Recommended. A good mix of catching unwanted posts without over-hiding.",
  strict: "Hides anything borderline. Expect some good posts to be hidden too.",
};

let s: Settings;

function checkbox(id: Category, title: string, description: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "cat";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = s.categories[id];
  input.addEventListener("change", () => {
    s.categories[id] = input.checked;
    renderGoals();
  });
  const text = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.className = "muted";
  span.textContent = description;
  text.append(strong, span);
  label.append(input, text);
  return label;
}

function renderCategories() {
  const of = (group: LabelGroup) =>
    LABELS.filter((l) => l.group === group).map((l) => checkbox(l.id, l.label, l.description));
  $("safety").replaceChildren(...of("safety"));
  $("topics").replaceChildren(...of("topic"));
  $("tones").replaceChildren(...of("tone"));
  $("goalmode").replaceChildren(
    checkbox("offgoal", "Off-goal", "Hide anything not related to the goals you set below, whatever its topic"),
  );
}

function renderGoals() {
  $("presets").replaceChildren(
    ...GOAL_PRESETS.map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      const on = s.goals.includes(p.label);
      b.setAttribute("aria-pressed", String(on));
      b.textContent = p.label;
      b.addEventListener("click", () => {
        s.goals = on ? s.goals.filter((g) => g !== p.label) : [...s.goals, p.label];
        renderGoals();
      });
      return b;
    }),
  );
  const custom = s.goals.filter((g) => !GOAL_PRESETS.some((p) => p.label === g));
  $("goal-list").replaceChildren(
    ...custom.map((g) => {
      const li = document.createElement("li");
      li.textContent = g;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", `Remove ${g}`);
      x.addEventListener("click", () => {
        s.goals = s.goals.filter((y) => y !== g);
        renderGoals();
      });
      li.append(x);
      return li;
    }),
  );
  $("goal-warning").classList.toggle("show", s.categories.offgoal && s.goals.length === 0);
}

function renderRadios() {
  for (const name of ["strictness", "hideStyle"] as const) {
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((r) => {
      r.checked = r.value === s[name];
      r.onchange = () => {
        (s as unknown as Record<string, string>)[name] = r.value;
        $("strict-hint").textContent = STRICT_HINTS[s.strictness];
      };
    });
  }
  $("strict-hint").textContent = STRICT_HINTS[s.strictness];
}

$("goal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("goal-input");
  const g = input.value.trim();
  if (g && !s.goals.includes(g)) s.goals = [...s.goals, g];
  input.value = "";
  renderGoals();
});

$("save").addEventListener("click", async () => {
  s.allowAccounts = $<HTMLTextAreaElement>("allow")
    .value.split(/[\s,]+/)
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  s.onboarded = true;
  await saveSettings(s);
  const saved = $("saved");
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 2000);
  $("open-x").hidden = false;
});

getSettings().then((loaded) => {
  s = loaded;
  renderCategories();
  renderGoals();
  renderRadios();
  $<HTMLTextAreaElement>("allow").value = s.allowAccounts.map((h) => `@${h}`).join("\n");
});

// Firefox may not grant site access at install time; ask for it here.
const ORIGINS = { origins: ["https://x.com/*", "https://twitter.com/*", "https://pbs.twimg.com/*"] };
async function checkPermission() {
  $("perm").hidden = await ext.permissions.contains(ORIGINS);
}
$("grant").addEventListener("click", async () => {
  await ext.permissions.request(ORIGINS);
  await checkPermission();
});
void checkPermission();
