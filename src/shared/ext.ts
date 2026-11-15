// Firefox exposes the WebExtension APIs as `browser` (promise-based); Chrome as `chrome`.
// Both have the same shape for everything this extension uses. (Undefined in Node tests.)
const g = globalThis as unknown as { browser?: typeof chrome; chrome?: typeof chrome };
export const ext: typeof chrome = (g.browser ?? g.chrome)!;
