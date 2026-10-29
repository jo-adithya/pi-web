import { beforeEach, vi } from "vitest";

// jsdom has no viewport/media-query engine; browser smoke tests cover real changes.
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })));
});
