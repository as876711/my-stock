import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "C:/Users/郭育佑/Desktop/智慧庫存";
const outputPath = `${outputDir}/智慧庫存_優化版範本.xlsx`;

const wb = Workbook.create();
const dashboard = wb.worksheets.add("儀表板");
const inventory = wb.worksheets.add("庫存中");
const shipments = wb.worksheets.add("出貨紀錄");
const images = wb.worksheets.add("圖片索引");
const settings = wb.worksheets.add("設定");
const readme = wb.worksheets.add("使用說明");

for (const sheet of [dashboard, inventory, shipments, images, settings, readme]) {
  sheet.showGridLines = false;
}

const statusList = ["📝 已登記", "🛒 已採買", "❌ 尚未買", "⚠️ 缺貨", "📦 已到貨", "✅ 出貨完成"];
const partnerList = ["萌寶目錄預購", "東京速換金", "妮小舖", "NAZI夏批發", "香港中國同行批發", "橙日(日本奇異果)", "ココ購", "日和優選", "東京買買", "自行購買", "尚未安排"];

function title(sheet, range, text, color = "#0F766E") {
  sheet.getRange(range).merge();
  sheet.getRange(range).values = [[text]];
  sheet.getRange(range).format = {
    fill: color,
    font: { bold: true, color: "#FFFFFF", size: 16 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
  sheet.getRange(range).format.rowHeightPx = 34;
}

function header(range) {
  range.format = {
    fill: "#134E4A",
    font: { bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
  };
}

title(dashboard, "A1:H1", "智慧庫存 優化版儀表板");
dashboard.getRange("A3:B8").values = [
  ["指標", "數值"],
  ["庫存總件數", null],
  ["庫存總金額", null],
  ["已到貨件數", null],
  ["缺貨件數", null],
  ["待採買件數", null],
];
dashboard.getRange("B4").formulas = [["=SUM('庫存中'!F2:F1001)"]];
dashboard.getRange("B5").formulas = [["=SUMPRODUCT('庫存中'!F2:F1001,'庫存中'!G2:G1001)"]];
dashboard.getRange("B6").formulas = [["=SUMIF('庫存中'!J2:J1001,\"📦 已到貨\",'庫存中'!F2:F1001)"]];
dashboard.getRange("B7").formulas = [["=SUMIF('庫存中'!J2:J1001,\"⚠️ 缺貨\",'庫存中'!F2:F1001)"]];
dashboard.getRange("B8").formulas = [["=SUMIF('庫存中'!J2:J1001,\"❌ 尚未買\",'庫存中'!F2:F1001)"]];
header(dashboard.getRange("A3:B3"));
dashboard.getRange("A4:A8").format = { fill: "#F0FDFA", font: { bold: true } };
dashboard.getRange("B5").format.numberFormat = "$#,##0";
dashboard.getRange("A10:H14").values = [
  ["新版表格重點", "", "", "", "", "", "", ""],
  ["1. 主庫存只存圖片網址與縮圖網址，不再存 base64 圖片。", "", "", "", "", "", "", ""],
  ["2. 前端庫存頁建議一次只讀取 30-50 筆，並支援搜尋/狀態/代購條件。", "", "", "", "", "", "", ""],
  ["3. 出貨完成資料移到出貨紀錄或封存，不拖慢主庫存頁。", "", "", "", "", "", "", ""],
  ["4. 使用 updatedAt 欄位，未來可做增量同步。", "", "", "", "", "", "", ""],
];
dashboard.getRange("A10:H10").merge();
dashboard.getRange("A11:H11").merge();
dashboard.getRange("A12:H12").merge();
dashboard.getRange("A13:H13").merge();
dashboard.getRange("A14:H14").merge();
dashboard.getRange("A10:H14").format = { fill: "#F8FAFC", wrapText: true };
dashboard.getRange("A10").format = { font: { bold: true, color: "#0F766E" } };
dashboard.freezePanes.freezeRows(1);

title(inventory, "A1:N1", "庫存中 - 前端主要讀取這張表");
const inventoryHeaders = [["rowId", "createdAt", "updatedAt", "communityName", "lineName", "qty", "price", "partner", "status", "note", "imageUrl", "thumbnailUrl", "sortKey", "isArchived"]];
inventory.getRange("A2:N2").values = inventoryHeaders;
header(inventory.getRange("A2:N2"));
inventory.getRange("A3:N7").values = [
  ["INV-0001", new Date(), new Date(), "範例社群ID", "line_example", 1, 580, "尚未安排", "📝 已登記", "顏色/尺寸/規格備註", "https://drive.google.com/...", "https://drive.google.com/thumbnail...", 1, false],
  ["INV-0002", new Date(), new Date(), "範例社群ID2", "line_02", 2, 320, "東京買買", "📦 已到貨", "列表頁只讀 thumbnailUrl", "https://drive.google.com/...", "https://drive.google.com/thumbnail...", 2, false],
  ["INV-0003", new Date(), new Date(), "範例社群ID3", "line_03", 1, 990, "自行購買", "⚠️ 缺貨", "出貨完成後移到出貨紀錄", "https://drive.google.com/...", "https://drive.google.com/thumbnail...", 3, false],
  [null, null, null, null, null, null, null, null, null, null, null, null, null, false],
  [null, null, null, null, null, null, null, null, null, null, null, null, null, false],
];
inventory.tables.add("A2:N1001", true, "InventoryTable");
inventory.freezePanes.freezeRows(2);
inventory.freezePanes.freezeColumns(4);
inventory.getRange("B3:C1001").setNumberFormat("yyyy-mm-dd hh:mm");
inventory.getRange("F3:F1001").setNumberFormat("0");
inventory.getRange("G3:G1001").setNumberFormat("$#,##0");
inventory.getRange("A:N").format.wrapText = true;
inventory.getRange("A:A").format.columnWidthPx = 105;
inventory.getRange("B:C").format.columnWidthPx = 138;
inventory.getRange("D:E").format.columnWidthPx = 140;
inventory.getRange("F:G").format.columnWidthPx = 75;
inventory.getRange("H:J").format.columnWidthPx = 125;
inventory.getRange("K:L").format.columnWidthPx = 230;
inventory.getRange("M:N").format.columnWidthPx = 90;

title(shipments, "A1:M1", "出貨紀錄 - 完成後移到這裡，避免主庫存變慢", "#1D4ED8");
shipments.getRange("A2:M2").values = [["shipmentId", "shipAt", "collectorName", "sourceRowId", "communityName", "lineName", "qty", "price", "subtotal", "partner", "note", "imageUrl", "operator"]];
header(shipments.getRange("A2:M2"));
shipments.getRange("A3:M5").values = [
  ["SHIP-0001", new Date(), "範例領取人", "INV-0000", "範例社群ID", "line_example", 1, 580, null, "尚未安排", "範例資料", "https://drive.google.com/...", ""],
  [null, null, null, null, null, null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null, null, null, null, null, null],
];
shipments.getRange("I3").formulas = [["=G3*H3"]];
shipments.getRange("I3:I1001").fillDown();
shipments.tables.add("A2:M1001", true, "ShipmentTable");
shipments.freezePanes.freezeRows(2);
shipments.getRange("B3:B1001").setNumberFormat("yyyy-mm-dd hh:mm");
shipments.getRange("H3:I1001").setNumberFormat("$#,##0");

title(images, "A1:H1", "圖片索引 - 圖片放雲端，表格只存網址", "#7C3AED");
images.getRange("A2:H2").values = [["imageId", "rowId", "uploadedAt", "fileName", "driveFileId", "imageUrl", "thumbnailUrl", "note"]];
header(images.getRange("A2:H2"));
images.getRange("A3:H5").values = [
  ["IMG-0001", "INV-0001", new Date(), "sample.jpg", "drive-file-id", "https://drive.google.com/...", "https://drive.google.com/thumbnail...", "列表讀縮圖，點開讀原圖"],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
];
images.tables.add("A2:H1001", true, "ImageTable");
images.freezePanes.freezeRows(2);
images.getRange("C3:C1001").setNumberFormat("yyyy-mm-dd hh:mm");
images.getRange("F:G").format.columnWidthPx = 240;

title(settings, "A1:D1", "設定 - 前端選單來源", "#475569");
settings.getRange("A3:B3").values = [["代購選項", "狀態選項"]];
header(settings.getRange("A3:B3"));
settings.getRangeByIndexes(3, 0, partnerList.length, 1).values = partnerList.map(v => [v]);
settings.getRangeByIndexes(3, 1, statusList.length, 1).values = statusList.map(v => [v]);
settings.getRange("D3:D8").values = [
  ["建議 Apps Script API"],
  ["GET ?mode=list&page=1&pageSize=50"],
  ["GET ?mode=list&status=📦 已到貨"],
  ["POST {method:'ADD'}"],
  ["POST {method:'UPDATE'}"],
  ["POST {method:'SHIP_BATCH'}"],
];
settings.getRange("D3:D8").format = { fill: "#F8FAFC", wrapText: true };

title(readme, "A1:H1", "使用說明與遷移建議", "#0F172A");
readme.getRange("A3:H12").values = [
  ["步驟", "說明", "", "", "", "", "", ""],
  ["1", "先把舊表資料複製到「庫存中」對應欄位，不要把 base64 圖片貼進 imageUrl。", "", "", "", "", "", ""],
  ["2", "把圖片上傳 Google Drive，imageUrl 存原圖網址，thumbnailUrl 存縮圖網址。", "", "", "", "", "", ""],
  ["3", "Apps Script 的列表 API 只回傳 rowId/communityName/lineName/qty/price/partner/status/note/thumbnailUrl。", "", "", "", "", "", ""],
  ["4", "點開圖片或列印明細時，才另外使用 imageUrl。", "", "", "", "", "", ""],
  ["5", "出貨完成資料寫入「出貨紀錄」，主庫存 qty 扣到 0 後可封存或移除。", "", "", "", "", "", ""],
  ["6", "前端庫存頁建議分頁讀取，每頁 30-50 筆。", "", "", "", "", "", ""],
  ["欄位提醒", "createdAt/updatedAt 請由 Apps Script 寫入，未來才能做增量同步與快取。", "", "", "", "", "", ""],
  ["不要做", "不要在 Sheet 內存 base64 圖片，這會讓每次讀庫存都變非常慢。", "", "", "", "", "", ""],
  ["舊表", "這份是新範本，不會動到你的舊 Google Sheet。", "", "", "", "", "", ""],
];
header(readme.getRange("A3:B3"));
readme.getRange("A4:A12").format = { fill: "#F1F5F9", font: { bold: true } };
readme.getRange("B4:B12").format = { wrapText: true };
readme.getRange("A:A").format.columnWidthPx = 100;
readme.getRange("B:B").format.columnWidthPx = 620;

for (const sheet of [dashboard, inventory, shipments, images, settings, readme]) {
  const used = sheet.getUsedRange();
  if (used) {
    used.format.font = { name: "Microsoft JhengHei" };
    used.format.verticalAlignment = "center";
  }
}

await fs.mkdir(outputDir, { recursive: true });

const errors = await wb.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});
console.log(errors.ndjson);

const previewRanges = {
  "儀表板": "A1:H14",
  "庫存中": "A1:N12",
  "使用說明": "A1:H12",
};
for (const [sheetName, range] of Object.entries(previewRanges)) {
  const preview = await wb.render({ sheetName, range, scale: 1, format: "png" });
  await fs.writeFile(`${outputDir}/${sheetName}_preview.png`, new Uint8Array(await preview.arrayBuffer()));
}

const out = await SpreadsheetFile.exportXlsx(wb);
await out.save(outputPath);
console.log(outputPath);
