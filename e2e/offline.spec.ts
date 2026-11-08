import { expect, test } from '@playwright/test';
import { PROFILE_A, mockApi, savedItem, seedProfiles } from './fixtures.ts';

test.describe('Offline dayanıklılığı', () => {
  test('API ulaşılamazken yeniden yükleme yerel listeyi korur', async ({ page }) => {
    await seedProfiles(page, [
      {
        id: PROFILE_A,
        name: 'E2E Kullanıcı',
        items: [savedItem({ id: 9001, title: 'E2E Çevrimdışı Filmi' })],
      },
    ]);
    await mockApi(page);

    await page.goto('/');
    await page.getByRole('tab', { name: 'Listem' }).click();
    await expect(page.getByText('E2E Çevrimdışı Filmi').first()).toBeVisible();

    // Ağ katmanında yalnızca API'yi kes: statik dosyalar yüklenmeye devam eder,
    // uygulamanın çevrimdışı geri dönüş yolu (localStorage/IndexedDB) sınanır.
    await page.route('**/api/**', (route) => route.abort('failed'));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    });

    await page.reload();

    await expect(
      page.getByText('Çevrimdışı mod — önbellekteki veriler kullanılıyor.')
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Listem' }).click();
    await expect(page.getByText('E2E Çevrimdışı Filmi').first()).toBeVisible();
  });
});
