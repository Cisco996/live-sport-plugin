# Live Matches Stream Comparison Report

**Date**: 2026-10-18T07:26:16.651Z
**Scope**: Only Live Sports Matches (`/catalog/tv/nuvio_sports_live.json`)
**Local Instance**: `http://localhost:7000` (Branch `feature/more-24-7-channels`)
**Remote Production**: `https://nuviosports.xyz`

## 1. High-Level Metrics Summary

| Metric | Localhost (Development) | nuviosports.xyz (Production) | Delta |
| :--- | :---: | :---: | :---: |
| **Live Matches in Catalog** | **100** | **100** | +0 |
| **Audited Matches** | 25 | 25 | - |
| **Total Streams Found** | **35** | **46** | **-11 (-23.9%)** |
| **Avg Streams / Match** | **1.4** | **1.8** | -0.4 |

## 2. Stream Provider Breakdown

| Provider Source | Localhost Streams | Remote Streams | Delta |
| :--- | :---: | :---: | :---: |
| `ak47live` | 3 | 0 | +3 |
| `daddylive` | 25 | 27 | -2 |
| `damitv` | 2 | 2 | 0 |
| `ppvst` | 0 | 1 | -1 |
| `sktech` | 3 | 14 | -11 |
| `streamedpk` | 2 | 2 | 0 |

## 3. Sample Live Matches Stream Audit

| Live Match Title | Local Streams | Remote Streams | Local Providers | Delta |
| :--- | :---: | :---: | :--- | :---: |
| **🔴 LIVE: SJM Macao Open - Day 4** | 1 | 0 | `sktech` | +1 |
| **🔴 LIVE: Macau, quarter-finals** | 0 | 0 | `none` | 0 |
| **🔴 LIVE: Melbourne United vs. Illawarra Hawks** | 5 | 5 | `streamedpk, streamedpk, ak47live, damitv, damitv` | 0 |
| **🔴 LIVE: Amsterdam Marathon Edition 2026** | 7 | 7 | `daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive` | 0 |
| **🔴 LIVE: Toluca vs Atl San Luis** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: MMA BKFC 95 Herring vs Dodson** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Club Leon vs Club America** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Fundora vs Hadribeaj** | 1 | 1 | `ak47live` | 0 |
| **🔴 LIVE: Houston vs Oklahoma State** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Tour of Guangxi - Stage 5 Men - Jinchengjiang – Yizhou (170.1km)** | 1 | 1 | `daddylive` | 0 |
| **🔴 LIVE: Fremantle Dockers W vs St Kilda W** | 2 | 2 | `daddylive, daddylive` | 0 |
| **🔴 LIVE: Pouakai vs Hoiho** | 1 | 1 | `daddylive` | 0 |
| **🔴 LIVE: Carlton Blues W vs Western Bulldogs W** | 2 | 2 | `daddylive, daddylive` | 0 |
| **🔴 LIVE: Marathon Seine-Eure 2026** | 1 | 1 | `daddylive` | 0 |
| **🔴 LIVE: DP World India Championship - Day 4** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: DP World India Championship** | 11 | 11 | `daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive` | 0 |
| **🔴 LIVE: Adelaide Strikers Women vs Brisbane Heat Women** | 1 | 1 | `sktech` | 0 |
| **🔴 LIVE: Jeonbuk vs Jeju SK** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Double's Final** | 1 | 1 | `sktech` | 0 |
| **🔴 LIVE: Daejeon vs Gwangju FC** | 1 | 1 | `ak47live` | 0 |
| **🔴 LIVE: Okayama vs Vissel Kobe** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Golf Buick LPGA Shanghai** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Wellington Phoenix vs Melbourne Victory** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Canterbury vs Taranaki** | 0 | 2 | `none` | -2 |
| **🔴 LIVE: Alianza Lima vs Grau** | 0 | 1 | `none` | -1 |
