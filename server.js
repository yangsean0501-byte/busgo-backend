"use strict";

/**
 * 快搭公車 BusGo — Backend v3 (Final Fix)
 * ─────────────────────────────────────────────────
 * 修正重點：
 * 1. 權限：必須透過 ClientID/Secret 換取 Access Token (已實作)
 * 2. 404 修正：TDX 不支援 /StopUID/{id} 路徑，改用 $filter 語法
 * 3. 效能：避免抓取全城市 10000 筆站牌，改用 API 端搜尋
 * 4. 穩定：合併多個 StopUID 查詢，減少 API 呼叫次數
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// TDX 設定
const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BUS = "https://tdx.transportdata.tw/api/basic/v2/Bus";

// ═══════════════════════════════════════════════
// § 1  Token 管理 (避免頻繁請求)
// ═══════════════════════════════════════════════
let _tok = null, _tokExp = 0;

async function getToken() {
  if (_tok && Date.now() < _tokExp) return _tok;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.TDX_CLIENT_ID || "",
    client_secret: process.env.TDX_CLIENT_SECRET || "",
  });

  try {
    const { data } = await axios.post(TDX_AUTH, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    _tok = data.access_token;
    _tokExp = Date.now() + 25 * 60 * 1000; // 25 min 緩存
    console.log("[TDX] Token refreshed");
    return _tok;
  } catch (err) {
    console.error("[TDX Auth Error]", err.response?.data || err.message);
    throw new Error("TDX 驗證失敗，請檢查環境變數");
  }
}

const auth = (tok) => ({ "authorization": `Bearer ${tok}`, "Accept-Encoding": "gzip" });

// ═══════════════════════════════════════════════
// § 2  簡單快取邏輯
// ═══════════════════════════════════════════════
const cache = new Map();
function cGet(k) { const x = cache.get(k); return (x && x.t > Date.now()) ? x.v : null; }
function cSet(k, v, ttl = 5 * 60 * 1000) { cache.set(k, { v, t: Date.now() + ttl }); }

// ═══════════════════════════════════════════════
// § 3  TDX 查詢助手
// ═══════════════════════════════════════════════

// 搜尋站牌名，取得 StopUID (修正：不再抓取全城市，改用 API 過濾)
async function searchStopsByName(city, name, tok) {
  const key = `stops:${city}:${name}`;
  const hit = cGet(key);
  if (hit) return hit;

  // 使用 OData contains 語法搜尋站名
  const url = `${TDX_BUS}/Stop/City/${city}?$filter=contains(StopName/Zh_tw,'${encodeURIComponent(name)}')&$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  
  cSet(key, data, 10 * 60 * 1000); 
  return data;
}

// 批次取得 ETA (修正：使用 $filter 解決 404 問題)
async function fetchETAByBatch(city, stopUIDs, tok) {
  if (!stopUIDs || stopUIDs.length === 0) return [];

  // 合併多個 StopUID 查詢：StopUID eq 'A' or StopUID eq 'B'
  const filterQuery = stopUIDs.map(uid => `StopUID eq '${uid}'`).join(' or ');
  const url = `${TDX_BUS}/EstimatedTimeOfArrival/City/${city}?$filter=${encodeURIComponent(filterQuery)}&$format=JSON`;
  
  const { data } = await axios.get(url, { headers: auth(tok) });
  return data;
}

// 取得路線停靠站 (用於比對目的地關鍵字)
async function fetchStopOfRoute(city, routeName, tok) {
  const key = `sor:${city}:${routeName}`;
  const hit = cGet(key);
  if (hit) return hit;

  const url = `${TDX_BUS}/StopOfRoute/City/${city}/${encodeURIComponent(routeName)}?$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  cSet(key, data, 10 * 60 * 1000);
  return data;
}

// ═══════════════════════════════════════════════
// § 4  API 端點
// ═══════════════════════════════════════════════

// 搜尋站牌 (Autocomplete)
app.get("/api/search-stop", async (req, res) => {
  const { q = "", city = "Taipei" } = req.query;
  try {
    const tok = await getToken();
    const stops = await searchStopsByName(city, q, tok);
    
    const seen = new Set();
    const results = [];
    for (const s of stops) {
      const name = s.StopName?.Zh_tw;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      results.push({ stopName: name, city });
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 主查詢：搭車站名 + 目的地
app.get("/api/bus-arrivals", async (req, res) => {
  const { stopName, keyword, city = "Taipei" } = req.query;
  if (!stopName || !keyword) return res.status(400).json({ error: "缺少參數" });

  try {
    const tok = await getToken();

    // A. 找出所有符合的 StopUID
    const stops = await searchStopsByName(city, stopName.trim(), tok);
    if (stops.length === 0) return res.json({ routes: [], hint: "找不到站牌" });

    const stopUIDs = [...new Set(stops.map(s => s.StopUID))].slice(0, 10);

    // B. 批次抓取 ETA
    const allETA = await fetchETAByBatch(city, stopUIDs, tok);
    if (allETA.length === 0) return res.json({ routes: [], hint: "目前無即時到站資料" });

    // C. 整理 RouteMap
    const routeMap = new Map();
    for (const item of allETA) {
      const rName = item.RouteName?.Zh_tw;
      const eta = item.EstimateTime;
      if (!rName) continue;

      const key = `${rName}:${item.Direction}`;
      const prev = routeMap.get(key);
      if (!prev || (eta !== null && (prev.etaSec === null || eta < prev.etaSec))) {
        routeMap.set(key, { 
          routeName: rName, 
          direction: item.Direction, 
          etaSec: eta, 
          etaMin: eta !== null ? Math.floor(eta / 60) : null 
        });
      }
    }

    // D. 並行比對目的地 (StopOfRoute)
    const entries = [...routeMap.values()];
    const uniqueNames = [...new Set(entries.map(e => e.routeName))];
    const sorResults = await Promise.allSettled(uniqueNames.map(n => fetchStopOfRoute(city, n, tok)));

    const nameMap = new Map();
    sorResults.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const stopSet = new Set();
        r.value.forEach(sub => sub.Stops?.forEach(st => stopSet.add(st.StopName.Zh_tw)));
        nameMap.set(uniqueNames[i], stopSet);
      }
    });

    // E. 合併結果與排序
    const kw = keyword.trim();
    const finalRoutes = entries.map(e => {
      const stopsOnRoute = nameMap.get(e.routeName) || new Set();
      const hasDest = [...stopsOnRoute].some(n => n.includes(kw));
      return { ...e, hasDestination: hasDest };
    }).sort((a, b) => (b.hasDestination - a.hasDestination) || (a.etaMin - b.etaMin));

    res.json({ routes: finalRoutes, stopName, keyword });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "查詢失敗", detail: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`🚌 BusGo Backend v3 running on port ${PORT}`));
