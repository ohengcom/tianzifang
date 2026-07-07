# Tianzifang Historical Crowd Sources

This document separates continuous measured signals from reported historical visitor anchors. A single historical anchor only proves that the import path works; useful analysis needs multiple anchors plus event, policy, holiday, weather, and data-quality context.

## Source Classes

| Source | Coverage | Granularity | Automation | Reliability | Use |
| --- | --- | --- | --- | --- | --- |
| Shanghai A-level scenic realtime API | Current project collection window | Instant in-park count | Implemented via `gov_tour` and N8N | High for occupancy, not daily totals | Continuous occupancy curve |
| Government and city-media reports | 2024-2026 visible public statements | Daily, partial-day, instant, or period anchors | Manual JSON import | Medium to high, per source confidence | Calibration and explanation |
| Activity reports and volunteer/service notices | Holiday and campaign periods | Event/context anchors | Manual JSON import | Medium | Explain demand shocks without inventing counts |
| Official history/trend scenic endpoints | Unknown | Potential daily/hourly history | Not public; probed endpoints returned 403 | Unknown | Use only if authorized/documented |
| AMap/Baidu/Tencent popularity or heat signals | Provider-dependent | Index/context, not visitor totals | Future optional API work | Medium for context, low for absolute counts | Explanatory features only |

## Imported Anchors

The import file is `data/historical_crowd_anchors.json`. It currently contains 11 anchors across 2024-2026.

| Anchor | Metric | Value | Period | Use |
| --- | --- | ---: | --- | --- |
| 2024 May Day large-crowd volunteer service | `activity_event` | n/a | 2024-05-01 to 2024-05-05 | Holiday activity context |
| 2024 short-video / inbound traffic context | `reported_peak_daily_visitors` | >= 20000 | 2024 summer operating period | Lower-confidence visitor anchor |
| 2025 April recovery peak | `reported_peak_daily_visitors` | 32000/day | 2025-04 | Recovery-period peak calibration |
| 2025 May Day peak | `reported_peak_daily_visitors` | >= 40000/day | 2025-05-01 to 2025-05-05 | Holiday peak calibration |
| 2025 inbound tourism context | `context_signal` | n/a | 2025 spring-summer | Policy / inbound tourism explanation |
| 2025 National Day total | `reported_daily_visitors` | 13000/day | 2025-10-01 | True reported daily total |
| 2025 National Day instant peak | `reported_instant_visitors` | 4000 people | 2025-10-01 | Instant peak calibration |
| 2026 New Year instant peak | `reported_instant_visitors` | 3181 people | 2026-01-01 17:00 | Instant peak calibration |
| 2026 Qingming partial day | `reported_partial_day_visitors` | 6700 to noon | 2026-04-04 | Partial-day context |
| 2026 Qingming partial day | `reported_partial_day_visitors` | 9000 to 15:00 | 2026-04-05 | Partial-day context |
| 2026 May Day total | `reported_daily_visitors` | 16000/day | 2026-05-01 | True reported daily total |

## Factor Model

Future analysis should not rely on one variable. Tianzifang demand should be modeled as a local commercial/tourism system, not as a weather-only or holiday-only time series. The current v2 feature layer now has room for:

- Calendar: weekday, weekend, statutory holiday, adjusted workday.
- Weather: district temperature from AMap and future precipitation/weather-code sources when available.
- Events: `activity_event_count` for explicit activities and service notices.
- Context: `context_signal_count` for inbound tourism, visa policy, short-video promotion, and similar demand drivers.
- Mobility: nearby metro, road, taxi, and walking-flow signals when provider terms allow them.
- Operations: temporary closures, entrance controls, police/security notices, construction, or opening-hour changes.
- Neighborhood demand: nearby exhibitions, city festivals, school vacation windows, office workday patterns, hotel/tour-group recovery, and shopping/dining promotions.
- Attention: public search interest, map popularity, short-video/social-media exposure, and travel-guide mentions as explanatory indexes, not visitor totals.
- Reported crowd anchors: daily totals, partial-day totals, instant peaks, period peaks.
- Data quality: sample coverage minutes, measured sample count, and `quality_score`.
- Semantics: instant occupancy, cumulative visitor totals, and period claims remain separate.

## Import Workflow

1. Add or update anchors in `data/historical_crowd_anchors.json` with source URL, quote, publisher, publication date, retrieval date, confidence, comparator, and period.
2. Run `npm run v2:init` so Neon has the latest granularity and feature columns.
3. Run `npm run v2:import-crowd-anchors`.
4. Run `npm run v2:derive -- START END` to refresh daily factors for dates with gov_tour samples.
5. Run `npm run v2:report-html` to regenerate the blog-ready report.

## Modeling Rules

- `in_park_count` is occupancy at one timestamp. It supports occupancy curves, peak hours, and person-hour estimates.
- `daily_total_visitors` and `reported_daily_visitors` are day-level cumulative visitor counts and may populate `daily_features.reported_visitors`.
- `reported_partial_day_visitors` is cumulative only up to a reported time and must not be compared to full-day totals without adjustment.
- `reported_instant_visitors` is an instant peak/headcount and should be compared with occupancy samples, not daily totals.
- `activity_event` and `context_signal` explain demand shifts but do not assert visitor counts.
- `period_total_visitors` and `reported_peak_daily_visitors` remain period-level unless the source gives a defensible daily split.
