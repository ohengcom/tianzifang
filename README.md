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
  main.js          Collection, summary, report, and scheduler entrypoint
  n8n/             N8N 工作流导出（备份）
  openclaw/        OpenClaw 定时任务配置（备份）
```

## 系统架构与执行方式

整个数据流水线由三个独立部分组成：

### 1. 数据采集（N8N 工作流）

**执行方式：** N8N 云端定时触发，不依赖本地代码

- 工作流名称：`田子坊数据采集`
- 触发器：`*/5 7-18 * * *`（每天 07:00-18:55，每 5 分钟）
- 流程：定时触发 → 获取景区数据 → 获取天气 → 合并写入 → 写入 Neon → 汇总结果
- 数据直接通过 HTTP API 写入 Neon PostgreSQL，不经过本地脚本
- 工作流备份：[`n8n/tianzifang-workflow.json`](n8n/tianzifang-workflow.json)

**数据源：**
- `gov_tour` — 上海市 A 级景区实时客流（tourist.whlyj.sh.gov.cn）
- `weather` — wttr.in 天气数据（温度、湿度、风速、天气描述）
- `holiday` — 节假日/工作日标记（2026 年硬编码）

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
- 高德数据：09:00-21:55 每 30 分钟
- 日汇总：23:30

## 数据库

Neon PostgreSQL（`crowd_data` 表 + `daily_summary` 表）

连接配置通过环境变量 `NEON_URL` 提供。不要把真实数据库 URI 提交到仓库。

本地运行示例：

```bash
cp .env.example .env
# Fill NEON_URL in .env, then load it with your shell or runtime environment.
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
- Added N8N workflow export and OpenClaw cron config backups.
