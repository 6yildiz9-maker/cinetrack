import { expect, test } from '@playwright/test';
import {
  PROFILE_A,
  PROFILE_B,
  mockApi,
  profileDocument,
  savedItem,
  seedProfiles,
} from './fixtures.ts';

test.describe('Profil ve çakışma senaryoları', () => {
  test('hızlı profil değişimi listeleri birbirine karıştırmaz', async ({ page }) => {
    await seedProfiles(
      page,
      [
        {
          id: PROFILE_A,
          name: 'Ali',
          items: [savedItem({ id: 9001, title: 'E2E Alfa Filmi' })],
        },
        {
          id: PROFILE_B,
          name: 'Bora',
          items: [savedItem({ id: 9002, title: 'E2E Beta Filmi' })],
        },
      ],
      PROFILE_A
    );
    await mockApi(page);

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Profil: Ali' })).toBeVisible();

    for (const name of ['Bora', 'Ali', 'Bora']) {
      await page.getByRole('button', { name: /^Profil:/ }).click();
      await page.getByRole('tab', { name: 'Profil & Tercihler' }).click();
      await page.getByRole('radio', { name: new RegExp(name) }).click();
      await expect(page.getByRole('button', { name: `Profil: ${name}` })).toBeVisible();
    }

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('cinetrack.activeProfile.v1')))
      .toBe(PROFILE_B);

    await page.getByRole('tab', { name: 'Listem' }).click();
    await expect(page.getByText('E2E Beta Filmi').first()).toBeVisible();
    await expect(page.getByText('E2E Alfa Filmi')).toHaveCount(0);
  });

  test('sunucu revizyon çakışması uyarısı gösterir ve kayıpsız birleştirme ile toparlanır', async ({
    page,
  }) => {
    const serverDocument = profileDocument(
      [
        {
          id: PROFILE_A,
          name: 'Ali',
          items: [savedItem({ id: 9100, title: 'Sunucudaki Film' })],
        },
      ],
      7
    );

    await seedProfiles(page, [
      {
        id: PROFILE_A,
        name: 'Ali',
        items: [savedItem({ id: 9001, title: 'E2E Yerel Filmi', status: 'watchlist' })],
      },
    ]);
    const api = await mockApi(page, {
      doc: profileDocument([{ id: PROFILE_A, name: 'Ali' }], 1),
      putResponder: (callIndex) =>
        callIndex === 1
          ? {
              status: 409,
              body: {
                code: 'revision_conflict',
                status_message: 'Sürüm çakışması (E2E)',
                currentRevision: 7,
                expectedRevision: 1,
                serverDocument,
              },
            }
          : { status: 200, body: { revision: 8, updatedAt: new Date().toISOString() } },
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Listem' }).click();
    await expect(page.getByText('E2E Yerel Filmi').first()).toBeVisible();

    // Başlangıç birleştirmesi yerel veriyi kirli işaretler ve ilk PUT 409 alır.
    const banner = page.getByRole('alert');
    await expect(banner).toContainText('Veri Eşitleme Uyarısı');
    await expect(banner).toContainText('Sürüm çakışması (E2E)');
    expect(api.pushCount()).toBeGreaterThanOrEqual(1);

    await page.getByRole('button', { name: 'Kayıpsız Birleştir' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => api.pushCount()).toBeGreaterThanOrEqual(2);
  });
});
