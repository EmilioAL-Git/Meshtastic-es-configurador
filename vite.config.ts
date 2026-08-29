import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Vite rechaza peticiones cuyo Host no sea localhost/IP por protección DNS rebinding;
    // hay que listar aquí el dominio público tras el que se sirve (proxy/túnel/producción).
    allowedHosts: ['config.meshtastic.es'],
    watch: {
      // Docker Desktop en macOS no propaga eventos fsnotify a través del bind mount.
      usePolling: true,
    },
  },
})
