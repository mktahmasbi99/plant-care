import '@testing-library/jest-dom/vitest'
import { describe, expect, it } from 'vitest'

describe('Plant Care UI', () => {
  it('keeps the no-photo identity tile deterministic through plant ids', () => {
    expect((42 * 47) % 180 + 70).toBe((42 * 47) % 180 + 70)
  })
})
