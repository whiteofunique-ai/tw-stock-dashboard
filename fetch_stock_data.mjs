// 抓取台股每日資料並整理成儀表板要用的 JSON
import fs from "node:fs";

const HISTORY_FILE = "institutional_history.json";
const HISTORY_DAYS = 30;
const MIN_BUY_STREAK = 2;

const TAIEX_HISTORY_FILE = "taiex_history.json";
const TAIEX_HISTORY_DAYS = 60;

const WATCHLIST = [
  { code: "2330", name: "台積電" },
  { code: "2454", name: "聯發科" },
  { code: "2308", name: "台達電" },
  { code: "2317", name: "鴻海" },
  { code: "2404", name: "漢唐" },
  { code: "2383", name: "台光電" },
  { code: "2449", name: "京元電子" },
  { code: "3711", name: "日月光投控" },
];

const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));

function isCommonStock(code) {
  return /^[1-9]\d{3}$/.test(code);
}

function rocDateToISO(rocDate) {
  // e.g. "1150729" -> 2026-07-29
  const s = String(rocDate);
  const year = Number(s.slice(0, 3)) + 1911;
  const month = s.slice(3, 5);
  const day = s.slice(5, 7);
  return `${year}-${month}-${day}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("big5").decode(buf);
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchNews(query, hl, gl, ceid, count) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, count);
    return items.map((m) => {
      const block = m[1];
      const rawTitle = decodeHtmlEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
      const source = decodeHtmlEntities(
        (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || ""
      );
      const suffix = ` - ${source}`;
      const title = source && rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
      return { title, link, source, pubDate };
    });
  } catch {
    return [];
  }
}

function quarterLabel(dateStr) {
  // "2022-03-31" -> "2022 Q1"
  const [y, m] = dateStr.split("-");
  const q = { "03": 1, "06": 2, "09": 3, "12": 4 }[m];
  return q ? `${y} Q${q}` : dateStr;
}

async function fetchFinancials(code, quartersBack) {
  const startYear = new Date().getFullYear() - Math.ceil(quartersBack / 4) - 1;
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=${code}&start_date=${startYear}-01-01`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { eps: [], margin: [] };
    const json = await res.json();
    if (json.status !== 200 || !Array.isArray(json.data)) return { eps: [], margin: [] };

    const eps = json.data
      .filter((r) => r.type === "EPS")
      .sort((a, b) => (a.date > b.date ? 1 : -1))
      .map((r) => ({ label: quarterLabel(r.date), value: r.value }))
      .slice(-quartersBack);

    const revenueByDate = new Map();
    const grossProfitByDate = new Map();
    json.data.forEach((r) => {
      if (r.type === "Revenue") revenueByDate.set(r.date, r.value);
      if (r.type === "GrossProfit") grossProfitByDate.set(r.date, r.value);
    });
    const marginDates = [...grossProfitByDate.keys()]
      .filter((d) => revenueByDate.has(d) && revenueByDate.get(d))
      .sort();
    const margin = marginDates
      .map((d) => ({ label: quarterLabel(d), value: (grossProfitByDate.get(d) / revenueByDate.get(d)) * 100 }))
      .slice(-quartersBack);

    return { eps, margin };
  } catch {
    return { eps: [], margin: [] };
  }
}

function monthLabel(year, month) {
  return `${year}/${String(month).padStart(2, "0")}`;
}

async function fetchMonthlyRevenue(code, monthsBack) {
  const startYear = new Date().getFullYear() - Math.ceil(monthsBack / 12) - 1;
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${code}&start_date=${startYear}-01-01`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.status !== 200 || !Array.isArray(json.data)) return [];
    return json.data
      .filter((r) => r.revenue_year && r.revenue_month)
      .sort((a, b) => (a.revenue_year - b.revenue_year) || (a.revenue_month - b.revenue_month))
      .map((r) => ({ label: monthLabel(r.revenue_year, r.revenue_month), value: r.revenue }))
      .slice(-monthsBack);
  } catch {
    return [];
  }
}

async function fetchPriceHistory(code, tradingDaysBack) {
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(tradingDaysBack * 1.6) - 10); // 多留緩衝，扣掉週末假日後仍夠 tradingDaysBack 天
  const startDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${startDate}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.status !== 200 || !Array.isArray(json.data)) return [];
    return json.data
      .sort((a, b) => (a.date > b.date ? 1 : -1))
      .map((r) => ({
        date: r.date,
        open: r.open,
        high: r.max,
        low: r.min,
        close: r.close,
        change: r.spread,
        volume: r.Trading_Volume,
      }))
      .slice(-tradingDaysBack);
  } catch {
    return [];
  }
}

function isoToYyyymmdd(iso) {
  return iso.replace(/-/g, "");
}

const parseNum = (v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isNaN(n) ? 0 : n;
};

function taipeiDateStr(offsetDays) {
  // 目前 UTC 時間 + 8 小時 = 台北時間，再往回推 offsetDays 天，回傳 YYYYMMDD
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000 - offsetDays * 24 * 60 * 60 * 1000);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function yyyymmddToISO(s) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseChangeSign(html) {
  if (!html) return 0;
  if (html.includes("color:red")) return 1;
  if (html.includes("color:green")) return -1;
  return 0;
}

// 上市當日收盤行情（比 STOCK_DAY_ALL 這份彙總檔更新得快，收盤後當天通常就有資料）
async function fetchTwseSameDayReport(maxLookback = 7) {
  for (let offset = 0; offset <= maxLookback; offset++) {
    const dateStr = taipeiDateStr(offset);
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${dateStr}&type=ALLBUT0999&response=json`;
    try {
      const json = await fetchJson(url);
      if (json.stat !== "OK" || !Array.isArray(json.tables)) continue;

      const indexTable = json.tables.find((t) => (t.title || "").includes("價格指數(臺灣證券交易所)"));
      const taiexRow = indexTable?.data?.find((r) => r[0] === "發行量加權股價指數");
      if (!taiexRow) continue;

      const stockTable = json.tables.find((t) => (t.title || "").includes("每日收盤行情"));
      if (!stockTable) continue;

      const dataDate = yyyymmddToISO(dateStr);
      const taiexClose = parseNum(taiexRow[1]);
      const taiexChangeSign = parseChangeSign(taiexRow[2]);
      const taiexChange = taiexChangeSign * parseNum(taiexRow[3]);

      const stockRows = stockTable.data
        .filter((r) => isCommonStock(r[0]))
        .map((r) => {
          const close = parseNum(r[8]);
          const changeSign = parseChangeSign(r[9]);
          const change = changeSign * parseNum(r[10]);
          const prevClose = close - change;
          return {
            market: "上市",
            code: r[0],
            name: r[1],
            close,
            change,
            changePct: prevClose ? (change / prevClose) * 100 : 0,
            volume: parseNum(r[2]),
            value: parseNum(r[4]),
            date: dataDate,
          };
        });

      return { dataDate, taiexClose, taiexChange, taiexChangePct: (taiexChange / (taiexClose - taiexChange)) * 100, stockRows };
    } catch {
      // 這個日期抓不到（可能還沒收盤或非交易日），往前一天再試
    }
  }
  return null;
}

async function fetchInstitutionalByStock(queryDate) {
  const netByCode = new Map();

  try {
    const twseUrl = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${queryDate}&selectType=ALL&response=json`;
    const twseRes = await fetch(twseUrl);
    const twseJson = await twseRes.json();
    if (twseJson.stat === "OK" && Array.isArray(twseJson.data)) {
      twseJson.data.forEach((row) => {
        const code = String(row[0]).trim();
        if (!isCommonStock(code)) return;
        netByCode.set(code, {
          foreignNet: parseNum(row[4]) + parseNum(row[7]),
          trustNet: parseNum(row[10]),
          dealerNet: parseNum(row[11]),
          totalNet: parseNum(row[18]),
        });
      });
    }
  } catch {
    // 上市三大法人資料抓取失敗，略過
  }

  try {
    const tpexJson = await fetchJson("https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading");
    tpexJson.forEach((row) => {
      const code = String(row.SecuritiesCompanyCode).trim();
      if (!isCommonStock(code)) return;
      netByCode.set(code, {
        foreignNet: parseNum(row["ForeignInvestorsIncludeMainlandAreaInvestors-Difference"]),
        trustNet: parseNum(row["SecuritiesInvestmentTrustCompanies-Difference"]),
        dealerNet: parseNum(row["Dealers-Difference"]),
        totalNet: parseNum(row.TotalDifference),
      });
    });
  } catch {
    // 上櫃三大法人資料抓取失敗，略過
  }

  return netByCode;
}

async function fetchMarketInstitutionalSummary(queryDate) {
  try {
    const url = `https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate=${queryDate}&type=day&response=json`;
    const json = await fetchJson(url);
    if (json.stat !== "OK" || !Array.isArray(json.data)) return null;
    const rowByName = new Map(json.data.map((r) => [r[0], parseNum(r[3])]));
    const dealerNet = (rowByName.get("自營商(自行買賣)") || 0) + (rowByName.get("自營商(避險)") || 0);
    const trustNet = rowByName.get("投信") || 0;
    const foreignNet = (rowByName.get("外資及陸資(不含外資自營商)") || 0) + (rowByName.get("外資自營商") || 0);
    const totalNet = rowByName.get("合計") || (dealerNet + trustNet + foreignNet);
    return { foreignNet, trustNet, dealerNet, totalNet };
  } catch {
    return null;
  }
}

// ---- 加權指數走勢（跨日滾動歷史，存在 taiex_history.json）----
// 注意：MI_5MINS_HIST 這個 API 只會回傳「當月至今」的資料，一到月初就會斷頭，
// 不能直接拿來當作近 20 日走勢的資料源，所以改成自己每天累積存檔。
function loadTaiexHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(TAIEX_HISTORY_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function updateTaiexHistory(history, dataDate, close) {
  const merged = new Map(history.map((r) => [r.date, r.close]));
  merged.set(dataDate, close);
  return [...merged.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0))
    .slice(-TAIEX_HISTORY_DAYS);
}

// ---- 外資／投信連買追蹤（跨日滾動歷史，存在 institutional_history.json）----
function loadInstitutionalHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function updateInstitutionalHistory(history, dataDate, instRows) {
  instRows.forEach((r) => {
    const entry = history[r.code] || { days: [] };
    entry.name = r.name;
    entry.market = r.market;
    entry.industry = r.industry;
    entry.days = entry.days.filter((d) => d.date !== dataDate);
    entry.days.push({ date: dataDate, f: r.foreignNet > 0, t: r.trustNet > 0 });
    entry.days.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
    entry.days = entry.days.slice(-HISTORY_DAYS);
    history[r.code] = entry;
  });
  return history;
}

function computeBuyStreaks(history, nameLookup, flagKey) {
  const results = [];
  for (const [code, entry] of Object.entries(history)) {
    let streak = 0;
    for (let i = entry.days.length - 1; i >= 0; i--) {
      const d = entry.days[i];
      if (d[flagKey]) streak++;
      else break;
    }
    if (streak >= MIN_BUY_STREAK) {
      const info = nameLookup.get(code);
      if (!info) continue;
      results.push({ ...info, streak });
    }
  }
  results.sort((a, b) => b.streak - a.streak || b.value - a.value);
  return results.slice(0, 10);
}

function parseIndustryMap(html) {
  const map = {};
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let cm;
    while ((cm = cellRe.exec(m[1]))) cells.push(cm[1].trim());
    if (cells.length < 5) continue;
    const codeMatch = cells[0].match(/^([0-9A-Za-z]+)　/);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    if (!isCommonStock(code)) continue;
    const industry = cells[4];
    if (!industry) continue;
    map[code] = industry;
  }
  return map;
}

async function main() {
  const [twseReport, tpexStocks, isinTwseHtml, isinTpexHtml, newsTw, newsUs] = await Promise.all([
    fetchTwseSameDayReport(),
    fetchJson("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"),
    fetchText("https://isin.twse.com.tw/isin/C_public.jsp?strMode=2"),
    fetchText("https://isin.twse.com.tw/isin/C_public.jsp?strMode=4"),
    fetchNews("台股 大盤", "zh-TW", "TW", "TW:zh-Hant", 5),
    fetchNews("US stock market", "en-US", "US", "US:en", 5),
  ]);

  if (!twseReport) {
    throw new Error("無法取得上市當日收盤行情（MI_INDEX），已嘗試回推 7 天皆失敗");
  }

  const industryMap = { ...parseIndustryMap(isinTwseHtml), ...parseIndustryMap(isinTpexHtml) };

  // ---- 大盤指數（當日）----
  const taiexClose = twseReport.taiexClose;
  const taiexChange = twseReport.taiexChange;
  const taiexChangePct = twseReport.taiexChangePct;

  // ---- 上市股票整理 ----
  const twseRows = twseReport.stockRows.map((r) => ({
    ...r,
    industry: industryMap[r.code] || null,
  }));

  // ---- 上櫃股票整理 ----
  const tpexRows = tpexStocks
    .filter((r) => isCommonStock(r.SecuritiesCompanyCode))
    .map((r) => {
      const close = num(r.Close);
      const change = num(r.Change);
      const prevClose = close - change;
      return {
        market: "上櫃",
        code: r.SecuritiesCompanyCode,
        name: r.CompanyName,
        industry: industryMap[r.SecuritiesCompanyCode] || null,
        close,
        change,
        changePct: prevClose ? (change / prevClose) * 100 : 0,
        volume: num(r.TradingShares),
        value: num(r.TransactionAmount),
        date: rocDateToISO(r.Date),
      };
    });

  const allRows = [...twseRows, ...tpexRows].filter(
    (r) => r.close !== null && r.value !== null && r.value > 0
  );

  const byValue = [...allRows].sort((a, b) => b.value - a.value).slice(0, 20);
  const byVolume = [...allRows].sort((a, b) => b.volume - a.volume).slice(0, 20);
  const byChangePct = [...allRows].sort((a, b) => b.changePct - a.changePct).slice(0, 20);
  const byChangePctAsc = [...allRows].sort((a, b) => a.changePct - b.changePct).slice(0, 20);

  const nameLookup = new Map(allRows.map((r) => [r.code, r]));
  const watchlist = WATCHLIST.map((w) => {
    const hit = nameLookup.get(w.code);
    return hit ? hit : { ...w, market: "-", close: null, change: null, changePct: null, volume: null, value: null, date: null };
  });

  // ---- 產業漲跌家數統計 ----
  const industryStats = new Map();
  allRows.forEach((r) => {
    if (!r.industry) return;
    if (!industryStats.has(r.industry)) {
      industryStats.set(r.industry, { industry: r.industry, up: 0, down: 0, flat: 0, total: 0 });
    }
    const s = industryStats.get(r.industry);
    s.total += 1;
    if (r.change > 0) s.up += 1;
    else if (r.change < 0) s.down += 1;
    else s.flat += 1;
  });
  const industryBreakdown = [...industryStats.values()]
    .filter((s) => s.total >= 5)
    .map((s) => ({ ...s, net: s.up - s.down }))
    .sort((a, b) => b.net - a.net);

  const dataDate = twseReport.dataDate;
  const queryDate = isoToYyyymmdd(dataDate);

  // ---- 三大法人買賣超（大盤摘要 + 個股買賣超前10）----
  const institutionalSummary = await fetchMarketInstitutionalSummary(queryDate);
  const instByCode = await fetchInstitutionalByStock(queryDate);
  const instRows = [...instByCode.entries()]
    .map(([code, net]) => {
      const info = nameLookup.get(code);
      if (!info) return null;
      return { ...info, ...net };
    })
    .filter(Boolean);

  const foreignBuyTop10 = [...instRows].sort((a, b) => b.foreignNet - a.foreignNet).slice(0, 10);
  const foreignSellTop10 = [...instRows].sort((a, b) => a.foreignNet - b.foreignNet).slice(0, 10);
  const trustBuyTop10 = [...instRows].sort((a, b) => b.trustNet - a.trustNet).slice(0, 10);
  const trustSellTop10 = [...instRows].sort((a, b) => a.trustNet - b.trustNet).slice(0, 10);

  let institutionalHistory = loadInstitutionalHistory();
  institutionalHistory = updateInstitutionalHistory(institutionalHistory, dataDate, instRows);
  const foreignBuyStreak = computeBuyStreaks(institutionalHistory, nameLookup, "f");
  const trustBuyStreak = computeBuyStreaks(institutionalHistory, nameLookup, "t");
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(institutionalHistory));

  // ---- 歷史財務資料（自選股 + 熱門排行榜，EPS/毛利率近 14 季、月營收近 24 個月）----
  const financialCodes = [...new Set(
    [...watchlist, ...byValue, ...byVolume, ...byChangePct, ...byChangePctAsc,
      ...foreignBuyTop10, ...foreignSellTop10, ...trustBuyTop10, ...trustSellTop10,
      ...foreignBuyStreak, ...trustBuyStreak].map((r) => r.code)
  )];
  const epsHistory = {};
  const marginHistory = {};
  const revenueHistory = {};
  const priceHistory = {};
  for (const code of financialCodes) {
    const financials = await fetchFinancials(code, 14);
    epsHistory[code] = financials.eps;
    marginHistory[code] = financials.margin;
    await new Promise((resolve) => setTimeout(resolve, 60));
    revenueHistory[code] = await fetchMonthlyRevenue(code, 24);
    await new Promise((resolve) => setTimeout(resolve, 60));
    priceHistory[code] = await fetchPriceHistory(code, 60);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  const taiexHistory = updateTaiexHistory(loadTaiexHistory(), dataDate, taiexClose);
  fs.writeFileSync(TAIEX_HISTORY_FILE, JSON.stringify(taiexHistory));

  const output = {
    updatedAt: new Date().toISOString(),
    dataDate,
    taiex: {
      close: taiexClose,
      change: taiexChange,
      changePct: taiexChangePct,
      history: taiexHistory,
    },
    news: { tw: newsTw, us: newsUs },
    watchlist,
    topByValue: byValue,
    topByVolume: byVolume,
    topByChangePct: byChangePct,
    topByChangePctAsc: byChangePctAsc,
    industryBreakdown,
    institutionalSummary,
    foreignBuyTop10,
    foreignSellTop10,
    trustBuyTop10,
    trustSellTop10,
    foreignBuyStreak,
    trustBuyStreak,
    epsHistory,
    marginHistory,
    revenueHistory,
    priceHistory,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exit(1);
});
