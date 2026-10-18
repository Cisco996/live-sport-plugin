# Live Matches Stream Comparison Report

**Date**: 2026-10-18T06:37:58.147Z
**Scope**: Only Live Sports Matches (`/catalog/tv/nuvio_sports_live.json`)
**Local Instance**: `http://localhost:7000` (Branch `feature/more-24-7-channels`)
**Remote Production**: `https://nuviosports.xyz`

## 1. High-Level Metrics Summary

| Metric | Localhost (Development) | nuviosports.xyz (Production) | Delta |
| :--- | :---: | :---: | :---: |
| **Live Matches in Catalog** | **100** | **100** | +0 |
| **Audited Matches** | 129 | 129 | - |
| **Total Streams Found** | **205** | **253** | **-48 (-19.0%)** |
| **Avg Streams / Match** | **1.6** | **2.0** | -0.4 |

## 2. Stream Provider Breakdown

| Provider Source | Localhost Streams | Remote Streams | Delta |
| :--- | :---: | :---: | :---: |
| `ak47live` | 5 | 0 | +5 |
| `cdnlive` | 31 | 45 | -14 |
| `daddylive` | 115 | 127 | -12 |
| `damitv` | 15 | 17 | -2 |
| `ppvst` | 0 | 10 | -10 |
| `sktech` | 17 | 36 | -19 |
| `streamedpk` | 10 | 18 | -8 |
| `vavoo` | 12 | 0 | +12 |

## 3. Sample Live Matches Stream Audit

| Live Match Title | Local Streams | Remote Streams | Local Providers | Delta |
| :--- | :---: | :---: | :--- | :---: |
| **🔴 LIVE: ARCA West at Phoenix International Raceway** | 0 | 0 | `none` | 0 |
| **🔴 LIVE: Tasmania JackJumpers vs. New Zealand Breakers** | 3 | 5 | `vavoo, streamedpk, streamedpk` | -2 |
| **🔴 LIVE: Melbourne United vs. Illawarra Hawks** | 5 | 5 | `vavoo, streamedpk, streamedpk, damitv, damitv` | 0 |
| **🔴 LIVE: Oregon vs Nebraska** | 2 | 4 | `streamedpk, streamedpk` | -2 |
| **🔴 LIVE: SJM Macao Open - Day 4** | 1 | 0 | `sktech` | +1 |
| **🔴 LIVE: Toluca vs Atl San Luis** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Fundora vs Hadribeaj** | 1 | 1 | `ak47live` | 0 |
| **🔴 LIVE: MMA BKFC 95 Herring vs Dodson** | 1 | 1 | `ak47live` | 0 |
| **🔴 LIVE: Houston vs Oklahoma State** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Club Leon vs Club America** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Pouakai vs Hoiho** | 2 | 1 | `daddylive, vavoo` | +1 |
| **🔴 LIVE: Fremantle Dockers W vs St Kilda W** | 2 | 2 | `daddylive, daddylive` | 0 |
| **🔴 LIVE: Carlton Blues W vs Western Bulldogs W** | 3 | 2 | `daddylive, vavoo, daddylive` | +1 |
| **🔴 LIVE: Tour of Guangxi - Stage 5 Men - Jinchengjiang – Yizhou (170.1km)** | 1 | 1 | `daddylive` | 0 |
| **🔴 LIVE: Bordeaux 3x3 vs Doha 3x3** | 1 | 0 | `daddylive` | +1 |
| **🔴 LIVE: Papua New Guinea vs Lebanon** | 2 | 2 | `daddylive, daddylive` | 0 |
| **🔴 LIVE: Adelaide Strikers Women vs Brisbane Heat Women** | 1 | 1 | `sktech` | 0 |
| **🔴 LIVE: Jeonbuk vs Jeju SK** | 1 | 1 | `ak47live` | 0 |
| **🔴 LIVE: Double's Final** | 1 | 1 | `sktech` | 0 |
| **🔴 LIVE: DP World India Championship - Day 4** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Daejeon vs Gwangju FC** | 1 | 1 | `ak47live` | 0 |
| **🔴 LIVE: Okayama vs Vissel Kobe** | 1 | 1 | `ak47live` | 0 |
| **🔴 LIVE: Golf Buick LPGA Shanghai** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Canterbury vs Taranaki** | 0 | 2 | `none` | -2 |
| **🔴 LIVE: Wellington Phoenix vs Melbourne Victory** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: DP World India Championship** | 12 | 11 | `vavoo, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive, daddylive` | +1 |
| **🔴 LIVE: Alianza Lima vs Grau** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Ind Medellin vs Once Caldas** | 0 | 1 | `none` | -1 |
| **🔴 LIVE: Marathon Seine-Eure 2026** | 1 | 1 | `daddylive` | 0 |
| **🔴 LIVE: ATP Masters Shanghai: (pairs) final** | 1 | 1 | `daddylive` | 0 |
