import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Acceptance test mirroring slide 14 live demo script:
 * 1. Two clients see order #42 (1 bag, Ama St.)
 * 2. Both go offline
 * 3. Ada edits quantity → 3 bags; Chidi edits address → Aba Road; pending badges
 * 4. Reconnect → outboxes flush → field-level merge keeps BOTH edits
 * 5. Same-field conflict → last-write-wins note visible
 */

async function resetServer(request: typeof test.prototype extends never ? never : import("@playwright/test").APIRequestContext) {
  await request.post("/api/reset");
}

async function openAs(page: Page, client: "ada" | "chidi") {
  await page.addInitScript((c) => {
    localStorage.setItem("order42_client", c);
    // Fresh IndexedDB per role via Dexie db name — already keyed by clientId
  }, client);
  await page.goto("/");
  await expect(page.getByTestId("order-panel")).toBeVisible();
  await expect(page.getByTestId("debug-client")).toHaveText(client);
  // Ensure starting values visible
  await expect(page.getByTestId("order-snapshot")).toContainText('qty="1 bag"');
  await expect(page.getByTestId("order-snapshot")).toContainText('addr="Ama St."');
}

async function setOffline(page: Page, offline: boolean) {
  // In-app toggle is more reliable than CDP offline for fetch in Playwright
  const box = page.getByTestId("simulate-offline");
  if (offline) {
    await box.check();
    await expect(page.getByTestId("network-pill")).toContainText(/Offline/i);
  } else {
    await box.uncheck();
    await expect(page.getByTestId("network-pill")).toContainText(/Online/i);
  }
}

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

test("slide 14: Ada + Chidi offline edits merge on reconnect", async ({ browser }) => {
  const adaCtx: BrowserContext = await browser.newContext();
  const chidiCtx: BrowserContext = await browser.newContext();
  const ada = await adaCtx.newPage();
  const chidi = await chidiCtx.newPage();

  await openAs(ada, "ada");
  await openAs(chidi, "chidi");

  // Both offline
  await setOffline(ada, true);
  await setOffline(chidi, true);

  // Ada edits quantity
  await ada.getByTestId("input-quantity").fill("3 bags");
  await ada.getByTestId("save-quantity").click();
  await expect(ada.getByTestId("badge-pending")).toBeVisible();
  await expect(ada.getByTestId("outbox-list")).toContainText("3 bags");
  await expect(ada.getByTestId("order-snapshot")).toContainText('qty="3 bags"');

  // Chidi edits address
  await chidi.getByTestId("input-address").fill("Aba Road");
  await chidi.getByTestId("save-address").click();
  await expect(chidi.getByTestId("badge-pending")).toBeVisible();
  await expect(chidi.getByTestId("outbox-list")).toContainText("Aba Road");
  await expect(chidi.getByTestId("order-snapshot")).toContainText('addr="Aba Road"');

  // While still offline, neither should have the other's edit
  await expect(ada.getByTestId("order-snapshot")).toContainText('addr="Ama St."');
  await expect(chidi.getByTestId("order-snapshot")).toContainText('qty="1 bag"');

  // Reconnect both
  await setOffline(ada, false);
  await setOffline(chidi, false);

  // Wait for outboxes to flush and both to converge
  await expect(ada.getByTestId("outbox-empty")).toBeVisible({ timeout: 20_000 });
  await expect(chidi.getByTestId("outbox-empty")).toBeVisible({ timeout: 20_000 });

  await expect(ada.getByTestId("order-snapshot")).toContainText('qty="3 bags"', {
    timeout: 20_000,
  });
  await expect(ada.getByTestId("order-snapshot")).toContainText('addr="Aba Road"');
  await expect(chidi.getByTestId("order-snapshot")).toContainText('qty="3 bags"');
  await expect(chidi.getByTestId("order-snapshot")).toContainText('addr="Aba Road"');

  await adaCtx.close();
  await chidiCtx.close();
});

test("slide 14: same-field conflict shows last-write-wins note", async ({ browser }) => {
  const adaCtx = await browser.newContext();
  const chidiCtx = await browser.newContext();
  const ada = await adaCtx.newPage();
  const chidi = await chidiCtx.newPage();

  await openAs(ada, "ada");
  await openAs(chidi, "chidi");

  await setOffline(ada, true);
  await setOffline(chidi, true);

  await ada.getByTestId("input-quantity").fill("3 bags");
  await ada.getByTestId("save-quantity").click();
  await expect(ada.getByTestId("badge-pending")).toBeVisible();

  // Slight delay so Chidi's timestamp is later (LWW)
  await chidi.waitForTimeout(50);
  await chidi.getByTestId("input-quantity").fill("5 bags");
  await chidi.getByTestId("save-quantity").click();
  await expect(chidi.getByTestId("badge-pending")).toBeVisible();

  await setOffline(ada, false);
  await setOffline(chidi, false);

  await expect(ada.getByTestId("outbox-empty")).toBeVisible({ timeout: 20_000 });
  await expect(chidi.getByTestId("outbox-empty")).toBeVisible({ timeout: 20_000 });

  // Winner is last write — Chidi's 5 bags (later timestamp)
  await expect(ada.getByTestId("order-snapshot")).toContainText('qty="5 bags"', {
    timeout: 20_000,
  });
  await expect(chidi.getByTestId("order-snapshot")).toContainText('qty="5 bags"');

  // Conflict note visible after pull (Chidi overwrote Ada on quantity)
  await expect(chidi.getByTestId("conflict-note")).toBeVisible({ timeout: 10_000 });
  await expect(chidi.getByTestId("conflict-note")).toContainText(/last-write-wins/i);
  await expect(ada.getByTestId("conflict-note")).toBeVisible({ timeout: 10_000 });
  await expect(ada.getByTestId("conflict-note")).toContainText(/last-write-wins/i);

  await adaCtx.close();
  await chidiCtx.close();
});

test("Reset #42 uses the in-app confirm and restores the starting order", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openAs(page, "chidi");

  await page.getByTestId("input-address").fill("Aba Road");
  await page.getByTestId("save-address").click();
  await expect(page.getByTestId("order-snapshot")).toContainText('addr="Aba Road"');
  await expect(page.getByTestId("outbox-empty")).toBeVisible({ timeout: 20_000 });

  // Cancel keeps the edit
  await page.getByTestId("reset-demo").click();
  await expect(page.getByTestId("reset-confirm-box")).toBeVisible();
  await page.getByTestId("reset-cancel").click();
  await expect(page.getByTestId("reset-confirm-box")).toBeHidden();
  await expect(page.getByTestId("order-snapshot")).toContainText('addr="Aba Road"');

  // Confirm resets server + local
  await page.getByTestId("reset-demo").click();
  await page.getByTestId("reset-confirm").click();
  await expect(page.getByTestId("order-snapshot")).toContainText('addr="Ama St."', { timeout: 15_000 });
  await expect(page.getByTestId("order-snapshot")).toContainText('qty="1 bag"');
  await expect(page.getByTestId("input-address")).toHaveValue("Ama St.");

  await ctx.close();
});
