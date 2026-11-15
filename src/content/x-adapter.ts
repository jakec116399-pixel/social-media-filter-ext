// Everything that depends on X's page structure lives here, so when X changes
// its markup this is the only file that needs updating.
import type { PostData } from "../shared/types";

export const POST_SELECTOR = 'article[data-testid="tweet"]';

/** Text content including emoji, which X renders as <img alt="😳">. */
function textWithEmoji(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n instanceof HTMLImageElement) out += n.alt;
    else n.childNodes.forEach(walk);
  };
  walk(el);
  return out;
}

/** Ask X's image CDN for a small rendition: plenty for a 224px classifier, and fast to fetch. */
export function smallImageUrl(src: string): string | null {
  try {
    const u = new URL(src);
    if (u.hostname !== "pbs.twimg.com") return null;
    if (u.pathname.startsWith("/profile_images") || u.pathname.startsWith("/emoji")) return null;
    if (u.searchParams.has("name")) u.searchParams.set("name", "small");
    return u.toString();
  } catch {
    return null;
  }
}

/** Cheap id lookup (post permalink), used to skip posts that were already judged. */
export function quickPostId(article: Element): string | null {
  return article.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href") ?? null;
}

export function extractPost(article: Element): PostData | null {
  const timeLink = article.querySelector('a[href*="/status/"] time')?.closest("a");
  const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]')).map(textWithEmoji).join("\n").trim();

  const handleLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
  const author = (handleLink?.getAttribute("href") ?? "").replace(/^\//, "").split("/")[0].toLowerCase();

  const rawImages = [
    ...Array.from(article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img')).map((i) => i.src),
    ...Array.from(article.querySelectorAll<HTMLVideoElement>("video[poster]")).map((v) => v.poster),
    ...Array.from(article.querySelectorAll<HTMLImageElement>('[data-testid^="card.layout"] img')).map((i) => i.src),
  ];
  const imageUrls = [...new Set(rawImages.map(smallImageUrl).filter((u): u is string => !!u))];

  const hasLink =
    !!article.querySelector('[data-testid="card.wrapper"]') ||
    !!article.querySelector(
      '[data-testid="tweetText"] a[href^="https://t.co"], [data-testid="tweetText"] a[href^="http"]',
    );

  const id =
    timeLink?.getAttribute("href") ??
    (text || imageUrls[0] ? `anon:${author}:${text.slice(0, 80)}:${imageUrls[0] ?? ""}` : "");
  if (!id) return null;

  return { id, author, text, imageUrls, hasLink, hasMedia: imageUrls.length > 0 };
}

/** Media may load after the post text; returns true while images are still missing. */
export function mediaPending(article: Element): boolean {
  return !!article.querySelector('[data-testid="tweetPhoto"]:not(:has(img[src]))');
}
