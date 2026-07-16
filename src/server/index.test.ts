import { describe, expect, it } from 'vitest'
import { createApp } from './index.js'

describe('server', () => {
  it('responds on /api/health', async () => {
    const { app } = createApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, name: 'threadmap' })
  })
})
