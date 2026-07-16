import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('ui', () => {
  it('App is a component', () => {
    expect(typeof App).toBe('function')
  })
})
