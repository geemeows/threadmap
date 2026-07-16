import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:4664', ws: true },
      '/api': { target: 'http://localhost:4664' },
    },
  },
})
