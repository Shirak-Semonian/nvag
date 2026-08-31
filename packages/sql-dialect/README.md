# @nvag/sql-dialect

Dialect-afhankelijke SQL-generatie voor Nvag: **quoting**, **LIMIT/OFFSET** en
**error-positie** per database-dialect.

F0 levert SQLite volledig; `tsql`, `postgres`, `mysql`, `db2`, `oracle` en
`snowflake` zijn als basis aanwezig (quoting + LIMIT/OFFSET-idioms).
`parseErrorPosition` voor de overige dialecten en scripting volgen in F1/F2.

## Gebruik

```ts
import { quoteIdentifier, quoteQualifiedName, quoteLiteral, buildLimit, wrapErrorPosition, buildSelectStar, getDialect } from '@nvag/sql-dialect'

quoteIdentifier('sqlite', 'order')            // '"order"'
quoteQualifiedName('sqlite', 'main', 'users') // '"main"."users"'
quoteLiteral('sqlite', "it's")                // "'it''s'"
buildLimit('sqlite', 10, 20)                  // 'LIMIT 10 OFFSET 20'
buildLimit('sqlite', undefined, 20)           // 'LIMIT -1 OFFSET 20' (offset-only)
buildSelectStar('sqlite', 'users', undefined, 100) // 'SELECT * FROM "users" LIMIT 100'

// Error-positie: met SQL wordt het token teruggezocht in de uitgevoerde query.
wrapErrorPosition('sqlite', 'near "FRM": syntax error', 'SELECT * FRM users')
// { line: 1, column: 10 }
```

## API

| Functie | Beschrijving |
| --- | --- |
| `getDialect(id)` | Dialect ophalen (7 ids); gooit bij onbekende id |
| `quoteIdentifier(dialect, name)` | Identifier quoten volgens dialectregels |
| `quoteQualifiedName(dialect, schema, object)` | `schema.object` beiden gequoted |
| `quoteLiteral(dialect, value)` | String-literal quoten |
| `buildLimit(dialect, maxRows?, offset?)` | LIMIT/TOP/FETCH-clausule; `''` zonder max |
| `wrapErrorPosition(dialect, message, sql?)` | Foutpositie (line/column) uit DB-melding |
| `buildSelectStar(dialect, table, schema?, maxRows?, offset?)` | `SELECT * FROM …` met quoting + LIMIT |

## Quoting-regels per dialect

| Dialect | Identifier | Literal |
| --- | --- | --- |
| SQLite / PostgreSQL / DB2 / Oracle / Snowflake | `"naam"` (embedded `"` → `""`) | `'…'` |
| MySQL | `` `naam` `` (embedded `` ` `` → ``` `` ```) | `'…'` |
| T-SQL | `[naam]` (embedded `]` → `]]`) | `'…'` |

## LIMIT/OFFSET per dialect

| Dialect | limit | limit + offset | offset-only |
| --- | --- | --- | --- |
| SQLite | `LIMIT n` | `LIMIT n OFFSET m` | `LIMIT -1 OFFSET m` |
| PostgreSQL | `LIMIT n` | `LIMIT n OFFSET m` | `OFFSET m` |
| MySQL | `LIMIT n` | `LIMIT n OFFSET m` | `LIMIT 18446744073709551615 OFFSET m` |
| T-SQL | `TOP (n)` | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` | `OFFSET m ROWS` |
| DB2 | `FETCH FIRST n ROWS ONLY` | `OFFSET m ROWS FETCH FIRST n ROWS ONLY` | `OFFSET m ROWS` |
| Oracle | `FETCH FIRST n ROWS ONLY` | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` | `OFFSET m ROWS` |
| Snowflake | `LIMIT n` | `LIMIT n OFFSET m` | `OFFSET m` |

## Error-positie (SQLite)

`wrapErrorPosition('sqlite', message, sql)` herkent: `near "TOKEN"`,
`unrecognized token`, `no such column/table/function/index`,
`table X has no column named Y`, `duplicate column name` (laatste occurrence),
`ambiguous column name`, `incomplete input`. Het token wordt teruggezocht in
de SQL (woordgrenzen; strings/commentaar overgeslagen; case-insensitive
fallback). Zonder `sql` wordt de positie binnen de melding bepaald (legacy).

## Ontwikkeling

```bash
pnpm test        # vitest (inclusief integratietests tegen node:sqlite)
pnpm typecheck   # tsc --noEmit
```

## Roadmap

- F1: `parseErrorPosition` voor tsql/postgres/mysql/db2 (PG: `LINE n:` + `^`),
  scripting (statement-splitter die quotes/comments respecteert).
- F2: identifier-normalisatie (case-folding per dialect) voor de Object Explorer.
