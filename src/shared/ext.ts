// Firefox exposes the WebExtension APIs as `browser` (promise-based); Chrome as `chrome`.
// Both have the same shape for everything this extension uses.
declare const browser: typeof chrome | undefined;
export const ext: typeof chrome = typeof browser !== "undefined" ? browser : chrome;
