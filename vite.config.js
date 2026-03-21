import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        capture: 'capture.html',
        menu: 'menu.html',
      },
      external: [
        'worker_threads',
        'crypto',
        'fs',
        'path',
        'os'
      ]
    },
  },
  optimizeDeps: {
    exclude: ['@imgly/background-removal']
  },
  server: {
    port: 5174,
    strictPort: true,
  },
})
