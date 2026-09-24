import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiProxy, localServer } from './vite.shared.mjs';

export default defineConfig({
  plugins: [react()],
  server: { ...localServer, proxy: apiProxy() },
  preview: { ...localServer, proxy: apiProxy() }
});
