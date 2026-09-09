import { expect, test } from "bun:test";

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

test("account more-actions uses the compact dashboard popover language", async () => {
  const css = await Bun.file(new URL("../src/styles-codex-set.css", import.meta.url)).text();
  const body = ruleBody(css, ".codex-account-more .codex-account-more-body");

  expect(body).toMatch(/z-index:\s*var\(--z-popover\)/);
  expect(body).toMatch(/min-width:\s*min\(16rem, calc\(100vw - 2rem\)\)/);
  expect(body).toMatch(/max-width:\s*min\(22rem, calc\(100vw - 2rem\)\)/);
  expect(body).toMatch(/background:\s*var\(--raised\)/);
  expect(body).toMatch(/border-radius:\s*var\(--radius\)/);
  expect(body).toMatch(/box-shadow:\s*0 4px 24px rgb\(0 0 0 \/ 0\.14\)/);
  expect(body).toMatch(/justify-content:\s*flex-start/);
});
