import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/impulse-pm-dashboard/' : '/',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'dexie-react-hooks'],
          'data-vendor': ['dexie', 'dexie-cloud-addon'],
          icons: ['lucide-react']
        }
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Impulse Command Center',
        short_name: 'Impulse',
        description: 'A calm, focused workspace for Impulse projects.',
        theme_color: '#05070d',
        background_color: '#05070d',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'pwa-192x192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: 'pwa-512x512.svg', sizes: '512x512', type: 'image/svg+xml' }
        ]
      }
    })
  ]
})
