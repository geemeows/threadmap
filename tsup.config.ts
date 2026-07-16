import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    server: 'src/server/index.ts',
    adapters: 'src/adapters/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
})
