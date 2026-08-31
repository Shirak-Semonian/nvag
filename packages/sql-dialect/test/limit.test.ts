import { describe, expect, it } from 'vitest'
import { buildLimit } from '../src/index'

describe('buildLimit — geen paginatie', () => {
  it('leeg bij undefined/null voor elk dialect', () => {
    for (const d of ['sqlite', 'tsql', 'postgres', 'mysql', 'db2', 'oracle', 'snowflake'] as const) {
      expect(buildLimit(d, undefined)).toBe('')
      expect(buildLimit(d, undefined, undefined)).toBe('')
    }
  })
})

describe('buildLimit — sqlite', () => {
  it('limit only', () => {
    expect(buildLimit('sqlite', 10)).toBe('LIMIT 10')
  })
  it('limit + offset', () => {
    expect(buildLimit('sqlite', 10, 20)).toBe('LIMIT 10 OFFSET 20')
  })
  it('offset only → LIMIT -1 (SQLite-idiom)', () => {
    expect(buildLimit('sqlite', undefined, 20)).toBe('LIMIT -1 OFFSET 20')
  })
  it('limit 0 is toegestaan', () => {
    expect(buildLimit('sqlite', 0)).toBe('LIMIT 0')
  })
})

describe('buildLimit — postgres', () => {
  it('limit only', () => {
    expect(buildLimit('postgres', 10)).toBe('LIMIT 10')
  })
  it('limit + offset', () => {
    expect(buildLimit('postgres', 10, 20)).toBe('LIMIT 10 OFFSET 20')
  })
  it('offset only is geldig in PG', () => {
    expect(buildLimit('postgres', undefined, 20)).toBe('OFFSET 20')
  })
})

describe('buildLimit — mysql', () => {
  it('limit only', () => {
    expect(buildLimit('mysql', 10)).toBe('LIMIT 10')
  })
  it('limit + offset', () => {
    expect(buildLimit('mysql', 10, 20)).toBe('LIMIT 10 OFFSET 20')
  })
  it('offset only → max-unsigned-bigint idiom', () => {
    expect(buildLimit('mysql', undefined, 20)).toBe('LIMIT 18446744073709551615 OFFSET 20')
  })
})

describe('buildLimit — tsql', () => {
  it('limit only → TOP', () => {
    expect(buildLimit('tsql', 10)).toBe('TOP (10)')
  })
  it('limit + offset → OFFSET/FETCH', () => {
    expect(buildLimit('tsql', 10, 20)).toBe('OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY')
  })
  it('offset only', () => {
    expect(buildLimit('tsql', undefined, 20)).toBe('OFFSET 20 ROWS')
  })
})

describe('buildLimit — db2', () => {
  it('limit only → FETCH FIRST', () => {
    expect(buildLimit('db2', 10)).toBe('FETCH FIRST 10 ROWS ONLY')
  })
  it('offset only', () => {
    expect(buildLimit('db2', undefined, 20)).toBe('OFFSET 20 ROWS')
  })
  it('limit + offset', () => {
    expect(buildLimit('db2', 10, 20)).toBe('OFFSET 20 ROWS FETCH FIRST 10 ROWS ONLY')
  })
})

describe('buildLimit — oracle', () => {
  it('limit only → FETCH FIRST', () => {
    expect(buildLimit('oracle', 10)).toBe('FETCH FIRST 10 ROWS ONLY')
  })
  it('limit + offset', () => {
    expect(buildLimit('oracle', 10, 20)).toBe('OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY')
  })
  it('offset only', () => {
    expect(buildLimit('oracle', undefined, 20)).toBe('OFFSET 20 ROWS')
  })
})

describe('buildLimit — snowflake', () => {
  it('limit only', () => {
    expect(buildLimit('snowflake', 10)).toBe('LIMIT 10')
  })
  it('limit + offset', () => {
    expect(buildLimit('snowflake', 10, 20)).toBe('LIMIT 10 OFFSET 20')
  })
  it('offset only', () => {
    expect(buildLimit('snowflake', undefined, 20)).toBe('OFFSET 20')
  })
})

describe('buildLimit — validatie', () => {
  it('negatieve maxRows gooit voor elk dialect', () => {
    for (const d of ['sqlite', 'tsql', 'postgres', 'mysql', 'db2', 'oracle', 'snowflake'] as const) {
      expect(() => buildLimit(d, -1)).toThrow()
    }
  })
  it('negatieve offset gooit', () => {
    expect(() => buildLimit('sqlite', undefined, -5)).toThrow()
    expect(() => buildLimit('tsql', undefined, -5)).toThrow()
  })
  it('niet-gehele waarden gooien', () => {
    expect(() => buildLimit('sqlite', 1.5)).toThrow()
    expect(() => buildLimit('sqlite', NaN)).toThrow()
  })
})
