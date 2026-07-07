# Tianzifang Crowd Collector

Collects and summarizes Tianzifang crowd-related signals with a single Node.js runtime and PostgreSQL storage.

Current version: `1.4.3`

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
| AMap Weather | `collectors/amap_weather.js` | Huangpu District current/forecast weather in v2 observations |
| wttr.in | `collectors/weather.js` | Legacy local/manual weather collector only; not used for new v2 weather context |
| Local holiday table | `collectors/holiday.js` | 2026 holiday/workday flags |

## Commands

```bash
npm install
npm run init
npm run collect
npm run summary
npm run report:yesterday
npm run query -- today
npm run v2:init
npm run v2:collect:amap-weather
npm run v2:import-crowd-anchors
npm run v2:derive -- 2025-10-03 2026-07-07
npm run v2:report-html
npm run v2:summary
npm start          # 启动本地定时采集 (--schedule)
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
  data/            Curated historical/event anchor inputs
  docs/            Architecture and upgrade notes
  main.js          Collection, summary, report, and scheduler entrypoint
  n8n/             N8N 工作流导出（备份）
  openclaw/        OpenClaw 定时任务配置（备份）
  reports/         Generated WordPress-friendly report artifacts
  v2/              Normalized observation and feature derivation layer
```

## 系统架构与执行方式

整个数据流水线由三个独立部分组成：

### 1. 数据采集（N8N 工作流）

**执行方式：** N8N 云端定时触发，不依赖本地代码

- 工作流名称：`田子坊数据采集`
- 触发器：`*/5 7-18 * * *`（每天 07:00-18:55，每 5 分钟）
- 流程：定时触发 → 获取景区实测在园人数 → 获取节假日标记 → 写入 Neon → 汇总结果
- 数据直接通过 HTTP API 写入 Neon PostgreSQL，不经过本地脚本
- 工作流备份：[`n8n/tianzifang-workflow.json`](n8n/tianzifang-workflow.json)

**数据源：**
- `gov_tour` — 上海市 A 级景区实时客流（tourist.whlyj.sh.gov.cn）
- `holiday` — 节假日/工作日标记（2026 年硬编码）
- AMap 天气不在 N8N 主流程中采集；使用 `npm run v2:collect:amap-weather` 写入 v2 observations，作为黄浦区天气上下文。

> ⚠️ N8N 工作流不使用本地 `collectors/` 目录下的 Node.js 采集器。
> 本地采集器用于手动测试和 `--schedule` 模式，两者独立运行。

### 2. 每日报告（OpenClaw Cron 定时任务）

**执行方式：** OpenClaw 隔离会话自动运行

- 任务名称：`早间汇报`
- 时间：每天 08:00（Asia/Shanghai）
- 田子坊数据作为汇报的第 2 项自动包含
- 执行命令：`node main.js --report-yesterday`
- 配置备份：[`openclaw/morning-report-cron.json`](openclaw/morning-report-cron.json)

报告内容包含：
- 昨日样本数、实测/冻结/估算分布
- 官方首次更新时间
- 最高/平均/最低在园人数
- 高峰小时 TOP 3
- 最后采样时间和舒适度

### 3. 本地定时采集（可选，当前未启用）

`node main.js --schedule` 可启动本地 `node-cron` 定时采集，但当前 N8N 已承担采集职责，**不建议同时运行**以免重复写入。

本地模式的采集频率：
- 基础采集（估算段）：06:00-08:30 每 30 分钟
- 基础采集（实测段）：09:00-21:55 每 5 分钟
- 日汇总：23:30

## 数据库

Neon PostgreSQL（`crowd_data` 表 + `daily_summary` 表）

连接配置通过环境变量 `NEON_URL` 提供。不要把真实数据库 URI 提交到仓库。

本地运行示例：

```bash
cp .env.example .env
# Fill NEON_URL in .env, then load it with your shell or runtime environment.
```

## Neon Database

This project intentionally supports the Neon PostgreSQL path only. There is no local SQLite or local PostgreSQL fallback.

- `NEON_URL` is required for every command that reads or writes data.
- `AMAP_KEY` can be set to collect Huangpu District current and forecast weather from AMap.
- `npm run init` applies idempotent Neon schema setup, creates query indexes, and records the applied schema version in `schema_migrations`.
- Collector HTTP failures are recorded through collector status rows; normal successful responses with no fresh scenic data write zero metric rows.
- Holiday data is strict for configured tables, but production collection falls back to weekday/workday markers with `confidence='unavailable'` if a future year has not been configured yet.
- v2 adds `data_sources`, `collection_runs`, `observations`, and `daily_features` while preserving legacy tables. See [`docs/V2_UPGRADE.md`](docs/V2_UPGRADE.md).

## Data Semantics

- `crowd_data.source='gov_tour'` + `metric='in_park_count'` is a point-in-time in-park count sample, not cumulative visitor traffic.
- `observations.source_id` values such as `reported_crowd_shanghai_gov` store reported historical visitor anchors with provenance.
- `daily_summary.total_visitors` is intentionally written as `NULL` until a reliable cumulative visitor source is available.
- `daily_summary.notes` keeps `in_park_sample_sum=...` as a diagnostic value only; do not use it as total visitors.
- Crowd analysis should consider multiple local drivers: holidays, weather, activities, policy/media context, mobility, temporary operations, nearby events, school/office calendars, and data quality.
- See [`docs/HISTORICAL_CROWD_SOURCES.md`](docs/HISTORICAL_CROWD_SOURCES.md) for verified and candidate historical crowd sources.
- `npm run v2:derive -- START END` derives measured-only daily features from official `gov_tour` samples.
- `npm run v2:report-html` generates a no-script HTML + inline SVG WordPress-friendly embed at [`reports/tianzifang-crowd-report.html`](reports/tianzifang-crowd-report.html).

## Notes

- The project intentionally uses the Node/PostgreSQL path only.
- Runtime settings are centralized in `config/settings.js`.
- Scheduled mode runs collection jobs in the Asia/Shanghai timezone.
- Source files are UTF-8. If PowerShell displays Chinese text as mojibake, verify with a UTF-8 reader before treating the file as corrupted.

## Release Notes

### 1.4.3

- Standardized human-facing crowd statistics on official `quality=measured` gov_tour samples only.
- Excluded legacy `estimated` / `historical_model` rows from daily features, yesterday reports, and blog embeds.
- Simplified the WordPress embed into a no-script HTML/SVG trend card with hourly quiet-period guidance.
- Updated the N8N workflow backup to collect measured gov_tour and holiday markers only; AMap weather remains in the v2 collection path.
- Cleaned local-tool ignore rules so `.agents/`, `.codex/`, `.env`, and `node_modules/` stay out of commits.

### 1.4.2

- Expanded historical/context anchors to cover 2024-2026 Tianzifang crowd reports, partial-day figures, instant peaks, activities, and policy context.
- Added `activity_event_count`, `context_signal_count`, and strongest context confidence to daily features.
- Added `npm run v2:report-html` to generate a self-contained, no-script HTML/SVG blog embed with measured-only trends and hourly quiet-period guidance.
- Restored `.env.example` with safe placeholder values only.

### 1.4.0

- Added AMap weather collection for Tianzifang's Huangpu District context.
- Replaced the previous weather backfill command with `npm run v2:collect:amap-weather`.
- Documented that AMap is suitable for current/forecast district weather, but not historical hourly backfill.

### 1.3.0

- Added the v2 normalized Neon observation model, source registry, collection run log, and daily feature table.
- Added a legacy sync trigger so existing `crowd_data` writes flow into v2 observations.
- Added provider-validated weather collection with Zod runtime validation.
- Added daily feature derivation based on occupancy statistics, coverage, person-hours, and dwell-time assumptions.
- Documented the v2 architecture, data semantics, migration commands, and next upgrade plan.

### 1.2.0

- Hardened the Neon-only production path with idempotent schema migration tracking and query indexes.
- Corrected the daily summary visitor semantics: in-park count samples are no longer treated as cumulative visitors.
- Improved collector failure reporting for HTTP/JSON failures and added unavailable fallback records for missing future holiday tables.
- Updated N8N workflow backup writes to match the PostgreSQL schema and use conflict-safe upserts.
- Upgraded dependencies and migrated Biome configuration to the current schema.

### 1.1.0

- Standardized the project on Node.js and PostgreSQL.
- Removed the duplicate Python and SQLite implementation path.
- Upgraded `node-cron` to v4 and removed unused `sql.js`.
- Added Biome linting/formatting and Vitest tests.
- Fixed query CLI async handling and parameterized date queries.
- Added N8N workflow export and OpenClaw cron config backups.
