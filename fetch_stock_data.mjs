// 抓取台股每日資料並整理成儀表板要用的 JSON
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

function isoToYyyymmdd(iso) {
  return iso.replace(/-/g, "");
}

const parseNum = (v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isNaN(n) ? 0 : n;
};

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
  const [twseStocks, twseIndex, tpexStocks, isinTwseHtml, isinTpexHtml] = await Promise.all([
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
    fetchJson("https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST"),
    fetchJson("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"),
    fetchText("https://isin.twse.com.tw/isin/C_public.jsp?strMode=2"),
    fetchText("https://isin.twse.com.tw/isin/C_public.jsp?strMode=4"),
  ]);

  const industryMap = { ...parseIndustryMap(isinTwseHtml), ...parseIndustryMap(isinTpexHtml) };

  // ---- 大盤指數 ----
  const idxSorted = [...twseIndex].sort((a, b) => (a.Date > b.Date ? 1 : -1));
  const latestIdx = idxSorted[idxSorted.length - 1];
  const prevIdx = idxSorted[idxSorted.length - 2];
  const taiexClose = num(latestIdx.ClosingIndex);
  const taiexPrevClose = num(prevIdx.ClosingIndex);
  const taiexChange = taiexClose - taiexPrevClose;
  const taiexChangePct = (taiexChange / taiexPrevClose) * 100;

  // ---- 上市股票整理 ----
  const twseRows = twseStocks
    .filter((r) => isCommonStock(r.Code))
    .map((r) => {
      const close = num(r.ClosingPrice);
      const change = num(r.Change);
      const prevClose = close - change;
      return {
        market: "上市",
        code: r.Code,
        name: r.Name,
        industry: industryMap[r.Code] || null,
        close,
        change,
        changePct: prevClose ? (change / prevClose) * 100 : 0,
        volume: num(r.TradeVolume),
        value: num(r.TradeValue),
        date: rocDateToISO(r.Date),
      };
    });

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

  const dataDate = allRows[0]?.date || rocDateToISO(latestIdx.Date);
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

  // ---- 歷史財務資料（自選股 + 熱門排行榜，EPS/毛利率近 14 季、月營收近 24 個月）----
  const financialCodes = [...new Set(
    [...watchlist, ...byValue, ...byVolume, ...byChangePct, ...byChangePctAsc,
      ...foreignBuyTop10, ...foreignSellTop10, ...trustBuyTop10, ...trustSellTop10].map((r) => r.code)
  )];
  const epsHistory = {};
  const marginHistory = {};
  const revenueHistory = {};
  for (const code of financialCodes) {
    const financials = await fetchFinancials(code, 14);
    epsHistory[code] = financials.eps;
    marginHistory[code] = financials.margin;
    await new Promise((resolve) => setTimeout(resolve, 60));
    revenueHistory[code] = await fetchMonthlyRevenue(code, 24);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  const taiexHistory = idxSorted.map((r) => ({
    date: rocDateToISO(r.Date),
    close: num(r.ClosingIndex),
  }));

  const output = {
    updatedAt: new Date().toISOString(),
    dataDate,
    taiex: {
      close: taiexClose,
      change: taiexChange,
      changePct: taiexChangePct,
      history: taiexHistory,
    },
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
    epsHistory,
    marginHistory,
    revenueHistory,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exit(1);
});
