import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'UPHOFF Paletten',
        short_name: 'UPHOFF',
        display: 'standalone',
        start_url: '/',
        theme_color: '#080a0c',
        background_color: '#080a0c',
        orientation: 'portrait-primary',
        icons: [],
      },
      workbox: {
        navigateFallback: '/index.html',
      },
    }),
  ],
});
