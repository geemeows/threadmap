import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/{server,cli,adapters}/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          environment: 'node',
          include: ['src/ui/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
