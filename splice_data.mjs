// 把 stock_data.json 的內容嵌入 tw-stock-dashboard.html 的資料區塊
import fs from "node:fs";

const html = fs.readFileSync("tw-stock-dashboard.html", "utf8");
const raw = fs.readFileSync("stock_data.json", "utf8").trim();

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error("stock_data.json 不是合法 JSON，中止：", err.message);
  process.exit(1);
}

const hasCoreFields =
  parsed.dataDate &&
  parsed.taiex &&
  typeof parsed.taiex.close === "number" &&
  Array.isArray(parsed.watchlist) &&
  parsed.watchlist.length > 0;

if (!hasCoreFields) {
  console.error("核心欄位（dataDate / taiex.close / watchlist）缺漏，中止，不覆蓋現有網頁。");
  process.exit(1);
}

const startMarker = '<script id="stock-data" type="application/json">';
const endMarker = "</script>";
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker, startIdx + startMarker.length);

if (startIdx === -1 || endIdx === -1) {
  console.error("在 tw-stock-dashboard.html 裡找不到資料區塊標籤，中止。");
  process.exit(1);
}

const newHtml =
  html.slice(0, startIdx + startMarker.length) +
  "\n" + raw + "\n" +
  html.slice(endIdx);

fs.writeFileSync("tw-stock-dashboard.html", newHtml);
console.log(`已將 ${parsed.dataDate} 的資料寫入 tw-stock-dashboard.html`);
