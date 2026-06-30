// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://labs.klymot.com',
  outDir: './docs',
  build: {
    assets: '_astro',
  },
  vite: {
    server: {
      proxy: {
        '/api': {
          target: 'https://api.klymot.com',
          changeOrigin: true,
        },
      },
    },
  },
});
