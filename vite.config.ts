import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { BRAND_APP_TITLE, BRAND_NAME, BRAND_TAGLINE } from './src/shared/brand.ts';

const brandHtmlPlugin = {
  name: 'brand-html',
  transformIndexHtml(html: string) {
    return html
      .replaceAll('%BRAND_NAME%', BRAND_NAME)
      .replaceAll('%BRAND_TAGLINE%', BRAND_TAGLINE);
  },
};

export default defineConfig({
  plugins: [
    brandHtmlPlugin,
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png', 'sw-poster-lru.js'],
      manifest: {
        id: '/',
        name: BRAND_APP_TITLE,
        short_name: BRAND_NAME,
        description: `${BRAND_TAGLINE}, deterministik zevk haritası ve ilişki keşif motoru.`,
        theme_color: '#0a0b0e',
        background_color: '#0a0b0e',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        importScripts: ['/sw-poster-lru.js'],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cinetrack-google-fonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cinetrack-gstatic-fonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^(?:https:\/\/image\.tmdb\.org\/.*|\/api\/tmdb-image(?:\?.*)?$)/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cinetrack-tmdb-posters',
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 60 * 60 * 24 * 30,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/api\/tmdb(?:\?.*)?$/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'cinetrack-tmdb-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
          if (
            /[\\/]node_modules[\\/](react-force-graph-2d|force-graph|react-kapsule|three|d3-[^\\/]+)[\\/]/.test(
              id
            )
          ) {
            return 'd3-graph';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: process.env.APP_URL ? '0.0.0.0' : '127.0.0.1',
    port: 3000,
    hmr: process.env.DISABLE_HMR === 'true' || Boolean(process.env.APP_URL) ? false : true,
  },
});
