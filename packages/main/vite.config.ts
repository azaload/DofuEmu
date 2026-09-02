import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  build: {
    outDir: path.resolve(__dirname, '../../dist/main'),
    lib: {
      entry: path.resolve(__dirname, 'index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs'
    },
    rollupOptions: {
      // Bundle relative, absolute and workspace imports; leave node/electron
      // built-ins external. path.isAbsolute keeps Windows entries (C:\...) in.
      external: (id) =>
        id === 'electron' ||
        id.startsWith('electron/') ||
        (!id.startsWith('.') && !path.isAbsolute(id) && !id.startsWith('@dofemu/'))
    },
    minify: false,
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@dofemu/shared': path.resolve(__dirname, '../shared/index.ts')
    }
  }
})
