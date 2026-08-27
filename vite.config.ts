import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    watch: {
      // Docker Desktop en macOS no propaga eventos fsnotify a través del bind mount.
      usePolling: true,
    },
  },
})
