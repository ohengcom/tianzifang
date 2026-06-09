# Tianzifang Crowd Collector

Collects and summarizes Tianzifang crowd-related signals with a single Node.js runtime and PostgreSQL storage.

Current version: `1.1.0`

## Stack

- Node.js 20.19+ with native ESM
- PostgreSQL via `pg` using the Neon connection in `config/settings.js`
- `node-cron` for scheduled collection
- Biome for linting/formatting
- Vitest for focused tests

## Data Sources

| Source | Collector | Notes |
| --- | --- | --- |
| Shanghai A-level scenic realtime API | `collectors/gov_tour.js` | In-park count and official metadata |
| Amap API | `collectors/amap.js` | Nearby traffic and POI signals |
| wttr.in | `collectors/weather.js` | Weather and temperature signals |
| Local holiday table | `collectors/holiday.js` | 2026 holiday/workday flags |

## Commands

```bash
npm install
npm run init
npm run collect
npm run summary
npm run report:yesterday
npm run query -- today
npm start
```

Quality checks:

```bash
npm run lint
npm test
npm run check
```

## Project Layout

```text
tianzifang/
  analysis/        Query CLI and tests
  collectors/      Data collectors
  config/          Runtime settings and PostgreSQL wrapper
  main.js          Collection, summary, report, and scheduler entrypoint
```

## Notes

- The project intentionally uses the Node/PostgreSQL path only.
- Runtime settings are centralized in `config/settings.js`.
- Scheduled mode runs collection jobs in the Asia/Shanghai timezone.

## Release Notes

### 1.1.0

- Standardized the project on Node.js and PostgreSQL.
- Removed the duplicate Python and SQLite implementation path.
- Upgraded `node-cron` to v4 and removed unused `sql.js`.
- Added Biome linting/formatting and Vitest tests.
- Fixed query CLI async handling and parameterized date queries.
