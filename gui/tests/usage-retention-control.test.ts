import { expect, test } from "bun:test";

test("Usage retention control stays a small native-control surface", async () => {
  const component = await Bun.file(new URL("../src/components/usage/UsageLedgerRetentionControl.tsx", import.meta.url)).text();
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const storageWorkspace = await Bun.file(new URL("../src/components/storage-workspace/StorageWorkspace.tsx", import.meta.url)).text();

  expect(page).toContain("UsageLedgerRetentionControl");
  expect(storageWorkspace).not.toContain("UsageLedgerRetentionPanel");
  expect(component).toContain("<Switch");
  expect(component).toContain("<Select");
  expect(component).toContain("const selectedValue = customOpen");
  expect(component).toContain("? UNLIMITED_OPTION");
  expect(component).toContain('const UNLIMITED_OPTION = "unlimited"');
  expect(component).not.toContain("useState(512");
  expect(component).toContain("models.custom");
  expect(component).toContain("models.customApply");
  expect(component).toContain("enabled && limitMiB !== null ? String(limitMiB) : \"\"");
  expect(component).not.toContain("/run");
  expect(component).not.toContain("setInterval");
  expect(component).not.toContain("hasUnsavedChanges");
  expect(component).not.toContain("storage-retention-");
});
