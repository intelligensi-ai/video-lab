import { test, expect } from '@playwright/test';
test('landing page has showcase CTA', async ({ page }) => { await page.goto('/'); await expect(page.getByText('Intelligensi.ai Showcase Trial')).toBeVisible(); await expect(page.getByRole('link', { name: 'Start creating' })).toBeVisible(); });
