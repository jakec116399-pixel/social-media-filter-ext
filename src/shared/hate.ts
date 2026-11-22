// Hate & slurs: detected by a curated word list (high precision).
//
// The list is ROT13-encoded so this source file doesn't read as a page of slurs;
// it is decoded once at startup. Matching tolerates the usual disguises:
// masked letters (n*gga), leetspeak (n1gga, f@ggot) and look-alike letters from
// other alphabets (Cyrillic "а", "е", "о"...). Word boundaries prevent hits
// inside other words ("snigger", "raccoon"). Hate without slurs needs a trained
// classifier and is not covered by this list.

const ENCODED = [
  "avttre",
  "avttref",
  "avttn",
  "avttnf",
  "avttnm",
  "avtthu",
  "avttnu",
  "fnaqavttre",
  "fnaqavttref",
  "puvax",
  "puvaxf",
  "tbbx",
  "tbbxf",
  "fcvp",
  "fcvpf",
  "jrgonpx",
  "jrgonpxf",
  "xvxr",
  "xvxrf",
  "cnxv",
  "cnxvf",
  "enturnq",
  "enturnqf",
  "gbjryurnq",
  "gbjryurnqf",
  "ornare",
  "ornaref",
  "pbba",
  "pbbaf",
  "wvtnobb",
  "wvtnobbf",
  "tbyyvjbt",
  "tbyyvjbtf",
  "mvccreurnq",
  "mvccreurnqf",
  "cbepu zbaxrl",
  "cbepu zbaxrlf",
  "snttbg",
  "snttbgf",
  "sntbg",
  "genaal",
  "genaavrf",
  "furznyr",
  "furznyrf",
  "ergneq",
  "ergneqf",
  "ergneqrq"
];

const rot13 = (s: string) =>
  s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

/** Characters commonly substituted for each letter. */
const LEET: Record<string, string> = {
  a: "a@4*",
  e: "e3*",
  i: "i1!|*",
  o: "o0*",
  u: "u*v",
  s: "s$5",
  g: "g9",
  t: "t7",
  l: "l1",
};
const esc = (c: string) => c.replace(/[\\^$.*+?()[\]{}|\-]/g, "\\$&");

function fuzzy(word: string): string {
  return [...word]
    .map((c, i) => {
      if (c === " ") return "[\\s_-]*";
      const alts = new Set(LEET[c] ?? c);
      // Letters after the first may also be masked with * or _ (n*gga, f_ggot).
      if (i > 0) {
        alts.add("*");
        alts.add("_");
      }
      return `[${[...alts].map(esc).join("")}]`;
    })
    .join("");
}

const HATE_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${ENCODED.map(rot13).map(fuzzy).join("|")})(?=$|[^\\p{L}\\p{N}])`,
  "iu",
);

/** Cyrillic / Greek letters that look like Latin ones, used to dodge filters. */
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
  "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "Т": "T", "Н": "H", "К": "K", "М": "M", "В": "B",
  "α": "a", "ο": "o", "ε": "e", "ι": "i", "ν": "v",
};

/** Replace look-alike letters from other alphabets with their Latin twins. */
export function normalizeHomoglyphs(text: string): string {
  return text.replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (c) => HOMOGLYPHS[c] ?? c);
}

export function containsSlur(text: string): boolean {
  return HATE_RE.test(normalizeHomoglyphs(text));
}
