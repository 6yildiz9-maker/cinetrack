import { expect, test } from '@playwright/test';
import { PROFILE_A, mockApi, savedItem, seedProfiles } from './fixtures.ts';

test.describe('Cinethos smoke', () => {
  test('renders brand, navigation and locally stored list', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await seedProfiles(page, [
      {
        id: PROFILE_A,
        name: 'E2E Kullanıcı',
        items: [savedItem({ id: 9001, title: 'E2E Alfa Filmi' })],
      },
    ]);
    await mockApi(page);

    await page.goto('/');

    await expect(page.locator('.brand-title')).toHaveText('Cinethos');
    await expect(page.getByRole('tab', { name: 'Listem' })).toBeVisible();

    await page.getByRole('tab', { name: 'Listem' }).click();
    await expect(page.getByText('E2E Alfa Filmi').first()).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('exposes the main tabs and profile entry point', async ({ page }) => {
    await seedProfiles(page, [{ id: PROFILE_A, name: 'E2E Kullanıcı' }]);
    await mockApi(page);

    await page.goto('/');

    for (const tab of ['Keşfet', 'Listem', 'Zevkim']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /Profil: E2E Kullanıcı/ })).toBeVisible();
  });
});
