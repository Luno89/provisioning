import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';
const API_BASE = 'http://localhost:3001';

test.describe('Evals UI — live end-to-end operational verification with TabbyAPI', () => {
  test('authenticates, navigates to Tool Evals, selects TabbyAPI, and runs live case to pass', async ({ page, context }) => {
    test.setTimeout(120_000);

    // 1. Authenticate via Google OAuth mock on running dev backend
    await page.goto(`${API_BASE}/api/auth/google`);
    await page.waitForLoadState('networkidle');

    // 2. Navigate to frontend root
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 3. Verify Sidebar contains "Tool Evals" and click it
    const toolEvalsNav = page.locator('button:has-text("Tool Evals")');
    await expect(toolEvalsNav).toBeVisible({ timeout: 15_000 });
    await toolEvalsNav.click();

    // 4. Verify URL is #/evals and Tool evals header renders
    await expect(page).toHaveURL(/.*#\/evals/);
    const heading = page.locator('h1:has-text("Tool evals")');
    await expect(heading).toBeVisible();

    // 5. Verify Model selector contains TabbyAPI deployment
    const modelSelect = page.locator('label:has-text("Model") select');
    await expect(modelSelect).toBeVisible();

    // Ensure Tabbyapi-Production option exists
    const tabbyOption = modelSelect.locator('option:has-text("Tabbyapi-Production")');
    await expect(tabbyOption).toBeAttached({ timeout: 10_000 });

    // Select Tabbyapi-Production
    const tabbyValue = await tabbyOption.getAttribute('value');
    expect(tabbyValue).toBeTruthy();
    await modelSelect.selectOption(tabbyValue!);

    // 6. Set Repeats to 1 for fast, deterministic E2E verification
    const repeatsInput = page.locator('label:has-text("Repeats") input');
    await repeatsInput.fill('1');

    // 7. Select only the first case ("list/before-naming-anything")
    const noneBtn = page.locator('button:has-text("none")');
    await noneBtn.click();

    const firstCaseCheckbox = page.locator('input[type="checkbox"]').first();
    await firstCaseCheckbox.check();

    // 8. Trigger Run
    const runBtn = page.locator('button:has-text("Run 1 case")');
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    // 9. Button changes to "Running…"
    await expect(page.locator('button:has-text("Running…")')).toBeVisible();

    // 10. Wait for execution against live TabbyAPI to finish
    await expect(page.locator('button:has-text("Run 1 case")')).toBeVisible({ timeout: 60_000 });

    // 11. Assert that the outcome is rendered in the UI with pass status
    await expect(page.locator('span[aria-label="1 passed"]')).toBeVisible();
    await expect(page.locator('text=1/1 cases')).toBeVisible();

    // Assert that the tool reliability scorecard shows the passed outcome for list_references
    await expect(page.locator('h2:has-text("How reliably each tool was chosen")')).toBeVisible();
    await expect(page.locator('span:has-text("list_references")').first()).toBeVisible();
  });
});
