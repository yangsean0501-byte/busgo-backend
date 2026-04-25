"use strict";

/**
 * 快搭公車 BusGo — Backend v2
 * ─────────────────────────────────────────────────
 * 404 修正重點：
 *  1. ETA  → 用 StopName 查（非 StopUID）：
 *     GET /EstimatedTimeOfArrival/City/{City}/StopName/{StopName}
 *  2. SOR  → 用 RouteName 查（非 RouteUID）：
 *     GET /StopOfRoute/City/{City}/RouteName/{RouteName}
 *  3. 搜站 → 用 OData $filter contains 查站名：
 *     GET /Stop/City/{City}?$filter=contains(StopName/Zh_tw,'...')
 *  4. 移除 GPS，改為手動輸入「搭車站名 + 目的地」流程
 *
 * Install: npm install express axios cors dotenv
 * Run:     node server.js
 */

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════
// § 1  TDX OAuth2 Token (25-min cache)
// ═══════════════════════════════════════════════
const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BUS  = "https://tdx.transportdata.tw/api/basic/v2/Bus";

let _tok = null, _tokExp = 0;

async function getToken() {
  if (_tok && Date.now() < _tokExp) return _tok;

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     process.env.TDX_CLIENT_ID     ?? "",
    client_secret: process.env.TDX_CLIENT_SECRET ?? "",
  });

  const { data } = await axios.post(TDX_AUTH, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  _tok    = data.access_token;
  _tokExp = Date.now() + 25 * 60 * 1000;
  console.log("[TDX] Token refreshed");
  return _tok;
}

const auth = (tok) => ({ Authorization: `Bearer ${tok}` });

// ═══════════════════════════════════════════════
// § 2  TTL Cache
// ═══════════════════════════════════════════════
const _cache = new Map();

function cGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(key); return null; }
  return e.v;
}

function cSet(key, v, ttl = 5 * 60 * 1000) {
  _cache.set(key, { v, exp: Date.now() + ttl });
}

// ═══════════════════════════════════════════════
// § 3  TDX fetch helpers
// ═══════════════════════════════════════════════

// 取得城市所有站牌 —— 快取 10 分鐘（資料量大但穩定）
async function tdxAllStops(city, tok) {
  const key = `allstops:${city}`;
  const hit = cGet(key);
  if (hit) return hit;

  // 不帶任何 filter，直接抓全部，TDX 預設回傳上限約 10000 筆
  const url = `${TDX_BUS}/Stop/City/${city}?$top=10000&$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  cSet(key, data, 10 * 60 * 1000); // 10-min cache
  return data;
}

// 搜尋站牌（在後端過濾，避免 OData 中文編碼問題）
async function tdxSearchStops(city, q, tok) {
  const allStops = await tdxAllStops(city, tok);
  // 後端直接 filter，完全不依賴 OData contains
  return allStops.filter(s =>
    (s.StopName?.Zh_tw ?? "").includes(q)
  );
}

// 取得站名的即時 ETA —— 不 cache（即時資料）
// ⚡ 修正：用 /StopName/{name} 而非 /StopUID/{uid}
async function tdxETA(city, stopName, tok) {
  const url = `${TDX_BUS}/EstimatedTimeOfArrival/City/${city}/StopName/${encodeURIComponent(stopName)}?$top=200&$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  return data;
}

// 取得路線停靠站 —— 5-min cache
// ⚡ 修正：用 /RouteName/{name} 而非 /RouteUID/{uid}
async function tdxStopOfRoute(city, routeName, tok) {
  const key = `sor:${city}:${routeName}`;
  const hit = cGet(key);
  if (hit) return hit;

  const url = `${TDX_BUS}/StopOfRoute/City/${city}/RouteName/${encodeURIComponent(routeName)}?$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  cSet(key, data);
  return data;
}

// ═══════════════════════════════════════════════
// § 4  GET /api/search-stop
//   用 ETA 端點驗證站名（最穩定，不依賴 OData filter）
//
//   Query: q=台北車站, city=Taipei
//   Return: { results: [{ stopName, city }] }
// ═══════════════════════════════════════════════
app.get("/api/search-stop", async (req, res) => {
  const { q = "", city = "Taipei" } = req.query;
  const name = q.trim();

  if (name.length === 0)
    return res.status(400).json({ error: "q is required" });

  try {
    const tok = await getToken();

    // 用 ETA 端點驗證站名是否存在（有資料 = 站名正確）
    const url = `${TDX_BUS}/EstimatedTimeOfArrival/City/${city}/StopName/${encodeURIComponent(name)}?$top=1&$format=JSON`;
    let valid = false;
    try {
      const { data } = await axios.get(url, { headers: auth(tok) });
      valid = Array.isArray(data) && data.length > 0;
    } catch (e) {
      valid = false;
    }

    if (valid) {
      res.json({ results: [{ stopName: name, city }], q, city });
    } else {
      res.json({ results: [], q, city });
    }
  } catch (err) {
    console.error("[search-stop]", err.response?.status, err.message);
    res.status(500).json({ error: "TDX 站牌查詢失敗", detail: err.message });
  }
});

// ═══════════════════════════════════════════════
// § 5  GET /api/bus-arrivals
//   主查詢：搭車站名 + 目的地關鍵字
//
//   Query:
//     stopName  — 搭車站（中文），例如「台北車站」
//     keyword   — 目的地關鍵字，例如「松山」
//     city      — 預設 Taipei（台北市）
//                 新北市用 NewTaipei，台中用 Taichung
//
//   Pipeline:
//     A. ETA by StopName → 收集所有 routeName + 到站秒數
//     B. StopOfRoute by RouteName（並行）
//     C. keyword 比對每條路線停靠站
//     D. 排序：有目的地優先，ETA 小到大
// ═══════════════════════════════════════════════
app.get("/api/bus-arrivals", async (req, res) => {
  const { stopName, keyword, city = "Taipei" } = req.query;

  if (!stopName || !keyword)
    return res.status(400).json({ error: "stopName and keyword are required" });

  try {
    const tok = await getToken();

    // ── A: ETA ─────────────────────────────────
    let etaList;
    try {
      etaList = await tdxETA(city, stopName.trim(), tok);
    } catch (e) {
      if (e.response?.status === 404) {
        return res.json({
          routes: [],
          stopName,
          keyword,
          hint: `找不到站牌「${stopName}」。請確認站名正確，台北市用 city=Taipei，新北市用 city=NewTaipei。`,
        });
      }
      throw e;
    }

    if (!Array.isArray(etaList) || etaList.length === 0)
      return res.json({ routes: [], stopName, keyword, hint: "此站目前無公車資料" });

    // ── B: 整理 routeMap（每個 routeName:direction 保留最小 ETA）
    const routeMap = new Map();

    for (const item of etaList) {
      const rName = item.RouteName?.Zh_tw;
      if (!rName) continue;

      const dir = item.Direction ?? 0;
      const key = `${rName}:${dir}`;
      const eta = item.EstimateTime ?? null; // 秒

      const prev = routeMap.get(key);
      if (!prev || (eta !== null && (prev.etaSec === null || eta < prev.etaSec))) {
        routeMap.set(key, {
          routeUID:  item.RouteUID ?? rName,
          routeName: rName,
          direction: dir === 0 ? "去程" : "返程",
          dirLabel:  item.DestinationStopName?.Zh_tw
            ? `往 ${item.DestinationStopName.Zh_tw}`
            : (dir === 0 ? "去程" : "返程"),
          etaSec:    eta,
          etaMin:    eta !== null ? Math.ceil(eta / 60) : null,
          plateNumb: item.PlateNumb ?? null,
        });
      }
    }

    if (routeMap.size === 0)
      return res.json({ routes: [], stopName, keyword });

    // ── C: StopOfRoute 並行 ────────────────────
    const entries      = [...routeMap.values()];
    const uniqueNames  = [...new Set(entries.map((e) => e.routeName))];

    const sorResults = await Promise.allSettled(
      uniqueNames.map((n) => tdxStopOfRoute(city, n, tok))
    );

    // routeName → Set<中文停靠站名>
    const nameMap = new Map();
    for (let i = 0; i < uniqueNames.length; i++) {
      const r = sorResults[i];
      if (r.status !== "fulfilled") continue;

      const s = new Set();
      for (const sub of r.value ?? []) {
        for (const stop of sub.Stops ?? []) {
          const n = stop.StopName?.Zh_tw ?? "";
          if (n) s.add(n);
        }
      }
      nameMap.set(uniqueNames[i], s);
    }

    // ── D: 合併 + keyword 比對 ─────────────────
    const kw = keyword.trim();

    const routes = entries.map((e) => {
      const names          = nameMap.get(e.routeName) ?? new Set();
      const hasDestination = [...names].some((n) => n.includes(kw));
      const destinationStop = hasDestination
        ? ([...names].find((n) => n.includes(kw)) ?? null)
        : null;

      return {
        routeUID:       e.routeUID,
        routeName:      e.routeName,
        direction:      e.direction,
        directionLabel: e.dirLabel,
        etaMin:         e.etaMin,
        plateNumb:      e.plateNumb,
        hasDestination,
        destinationStop,
      };
    });

    // ── E: 排序 ───────────────────────────────
    routes.sort((a, b) => {
      if (a.hasDestination !== b.hasDestination) return a.hasDestination ? -1 : 1;
      if (a.etaMin === null && b.etaMin === null) return 0;
      if (a.etaMin === null) return 1;
      if (b.etaMin === null) return -1;
      return a.etaMin - b.etaMin;
    });

    res.json({ routes, stopName, keyword, total: routes.length });

  } catch (err) {
    const status = err.response?.status;
    console.error("[bus-arrivals]", status, err.message);

    if (status === 404) {
      return res.status(404).json({
        error: "TDX 回傳 404",
        hint:  `站牌「${req.query.stopName}」在城市「${req.query.city ?? "Taipei"}」找不到。` +
               "常見原因：1) 站名有誤（要完整中文站名） 2) 城市參數錯誤（台北市=Taipei，新北市=NewTaipei）",
      });
    }
    res.status(500).json({ error: "TDX 錯誤", detail: err.message });
  }
});

// ═══════════════════════════════════════════════
// § 6  Health checks
// ═══════════════════════════════════════════════
app.get("/health", (_, res) =>
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date() })
);

// 測試金鑰是否有效（curl http://localhost:3001/health/token）
app.get("/health/token", async (_, res) => {
  try {
    const tok = await getToken();
    res.json({ ok: true, tokenLength: tok.length });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`🚌 BusGo v2 → http://localhost:${PORT}`)
);
