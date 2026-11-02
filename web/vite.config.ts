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
      },
    }
  }
})
