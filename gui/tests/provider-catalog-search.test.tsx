import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";

/**
 * Unified search replaces browse mode instead of filtering inside one tab, and the tab
 * strip becomes jump chips rather than moving the selection. These pin the three things
 * that make that safe rather than merely different: the selected tab survives a search
 * that matches nothing in it, a strip click does not throw the query away, and a login
 * already in flight is never unmounted by a query that does not happen to match it.
 */

const PRESETS = [
  { id: "cerebras", label: "Cerebras", adapter: "openai-completions", baseUrl: "https://api.cerebras.ai/v1", auth: "key" },
  { id: "nvidia", label: "NVIDIA NIM", adapter: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", auth: "key", freeTier: true },
];

const ACCOUNT_ROWS = [
  { id: "cursor", label: "Cursor", kind: "oauth" as const },
  { id: "anthropic", label: "Anthropic (Claude)", kind: "oauth" as const },
];

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: PRESETS });
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      return Response.json({});
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

type ModalExtras = Partial<Parameters<typeof AddProviderModal>[0]>;

async function mount(extras: ModalExtras = {}) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={() => {}} {...extras} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
}

function search(): HTMLInputElement {
  return win.document.querySelector(".provider-catalog-search") as unknown as HTMLInputElement;
}

async function type(value: string) {
  const input = search();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
  });
}

function chips(): HTMLButtonElement[] {
  return [...win.document.querySelectorAll<HTMLButtonElement>(".provider-catalog-chip")] as unknown as HTMLButtonElement[];
}

function selectedTabs(): string[] {
  return [...win.document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(el => el.textContent ?? "");
}

test("a query that matches nothing on the selected tab does not move the tab", async () => {
  await mount();
  expect(selectedTabs()).toEqual(["Paid"]);

  // NVIDIA is a Free row; Paid has no hit at all.
  await type("nvidia");

  // Search mode: the strip is chips, so nothing is announced as a selected tab, and the
  // Free group is on screen without the Paid tab having been stolen.
  expect(selectedTabs()).toEqual([]);
  expect(chips().length).toBe(4);
  expect(win.document.querySelector(".provider-catalog-rows")?.textContent).toContain("NVIDIA NIM");

  // Clearing restores the tab the user actually chose.
  await type("");
  expect(selectedTabs()).toEqual(["Paid"]);
});

test("clicking the strip during a search does not throw the query away", async () => {
  await mount();
  await type("nvidia");
  const free = chips().find(chip => (chip.textContent ?? "").startsWith("Free"));
  expect(free?.disabled).toBe(false);
  await act(async () => { free?.click(); });
  expect(search().value).toBe("nvidia");
});

test("a login in flight survives a query that does not match its row", async () => {
  await mount({
    accountRows: ACCOUNT_ROWS,
    accountBusy: "cursor",
    accountLoginHint: { provider: "cursor", url: "https://example.com/authorize" },
  });
  await type("nvidia");
  const rows = win.document.querySelector(".provider-catalog-rows")?.textContent ?? "";
  // Cursor does not match "nvidia". It stays because it owns the authorization URL and
  // the paste field, and unmounting it mid-login throws away the login in progress.
  expect(rows).toContain("Cursor");
  expect(rows).not.toContain("Anthropic");
});
