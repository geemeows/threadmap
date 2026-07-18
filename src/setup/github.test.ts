import { describe, expect, it } from 'vitest'
import { VOCABULARY_LABELS } from '../tracker/labels.js'
import { labelColor, provisionGitHub } from './github.js'

describe('labelColor', () => {
  it('maps namespaces to fixed colors', () => {
    expect(labelColor('wayfinder:map')).toBe('5319E7')
    expect(labelColor('threadmap:override:implement')).toBe('D93F0B')
    expect(labelColor('threadmap:ticket')).toBe('0E8A16')
  })
})

describe('provisionGitHub', () => {
  it('stamps every vocabulary label into each repo via gh label create --force', async () => {
    const calls: { args: string[]; cwd?: string }[] = []
    const results = await provisionGitHub(
      [
        { name: 'api', path: '/ws/api' },
        { name: 'web', path: '/ws/web' },
      ],
      async (cmd, args, cwd) => {
        expect(cmd).toBe('gh')
        calls.push({ args, cwd })
        return ''
      },
    )

    expect(results).toEqual([
      { name: 'api', ok: true, detail: `${VOCABULARY_LABELS.length} labels stamped` },
      { name: 'web', ok: true, detail: `${VOCABULARY_LABELS.length} labels stamped` },
    ])
    expect(calls).toHaveLength(VOCABULARY_LABELS.length * 2)
    const apiCalls = calls.filter((c) => c.cwd === '/ws/api')
    expect(apiCalls.map((c) => c.args[2])).toEqual(VOCABULARY_LABELS)
    for (const call of apiCalls) {
      expect(call.args.slice(0, 2)).toEqual(['label', 'create'])
      expect(call.args).toContain('--force')
    }
  })

  it('reports a failing repo without throwing or blocking the others', async () => {
    const results = await provisionGitHub(
      [
        { name: 'api', path: '/ws/api' },
        { name: 'web', path: '/ws/web' },
      ],
      async (_cmd, _args, cwd) => {
        if (cwd === '/ws/api') throw new Error('gh: HTTP 404: Not Found\nmore detail')
        return ''
      },
    )
    expect(results[0]).toEqual({ name: 'api', ok: false, detail: 'gh: HTTP 404: Not Found' })
    expect(results[1]?.ok).toBe(true)
  })
})
