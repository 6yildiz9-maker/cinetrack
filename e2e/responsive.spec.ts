import { expect, test } from '@playwright/test';
import { PROFILE_A, mockApi, savedItem, seedProfiles } from './fixtures.ts';

const VIEWPORTS = [
  { name: 'mobil-360x640', width: 360, height: 640 },
  { name: 'mobil-390x844', width: 390, height: 844 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'laptop-1024x768', width: 1024, height: 768 },
  { name: 'masaustu-1440x900', width: 1440, height: 900 },
  { name: 'genis-1920x1080', width: 1920, height: 1080 },
];

for (const viewport of VIEWPORTS) {
  test(`layout ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();

    await seedProfiles(page, [
      {
        id: PROFILE_A,
        name: 'E2E Kullanıcı',
        items: [savedItem({ id: 9001, title: 'E2E Alfa Filmi' })],
      },
    ]);
    await mockApi(page);

    await page.goto('/');
    await expect(page.locator('.app-header')).toBeVisible();
    await expect(page.locator('main.shell')).toBeVisible();

    const desktopNavVisible = await page.locator('.header-nav-tabs').isVisible();
    const mobileNavVisible = await page.locator('.mobile-tab-bar').isVisible();
    expect(desktopNavVisible || mobileNavVisible).toBe(true);

    // Mobile uses the fixed bottom bar from <=768px, desktop keeps the header tab list.
    if (viewport.width <= 768) {
      expect(mobileNavVisible).toBe(true);
      expect(desktopNavVisible).toBe(false);
    } else {
      expect(desktopNavVisible).toBe(true);
      expect(mobileNavVisible).toBe(false);
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow, 'sayfa yatay olarak taşmamalı').toBeLessThanOrEqual(1);

    await page.getByRole('tab', { name: 'Listem' })
      .or(page.getByRole('button', { name: 'Listem' }))
      .first()
      .click();
    await expect(page.getByText('E2E Alfa Filmi').first()).toBeVisible();

    await context.close();
  });
}
