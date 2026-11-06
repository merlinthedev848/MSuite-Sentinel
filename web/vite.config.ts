import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '^/(auth|cameras|recordings|recordings-list|events|system|users|maps|ops-api|agent|automations|go2rtc|static)': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    }
  },
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/lucide-react/')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/recharts/')) {
            return 'vendor-charts';
          }
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
