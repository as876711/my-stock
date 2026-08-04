/**
 * 智慧庫存管理系統 - 新版 Google Sheet API
 * 適用新版工作表：
 * 儀表板 / 庫存中 / 出貨紀錄 / 圖片索引 / 設定 / 使用說明
 *
 * 速度優化重點：
 * 1. doGet 支援分頁，不再一次回傳整張表。
 * 2. 列表預設只回傳 thumbnailUrl，不回傳大圖 imageUrl。
 * 3. 支援 keyword / status / partner 篩選，先在 Apps Script 端過濾。
 * 4. 使用 CacheService 快取列表查詢，減少重讀 Sheet。
 * 5. 使用 rowId，不依賴實際列號，避免刪列後前端更新錯列。
 */

const SHEET_NAMES = {
  inventory: "庫存中",
  shipments: "出貨紀錄",
  images: "圖片索引",
  settings: "設定"
};

const DRIVE_IMAGE_FOLDER_ID = "1nROY-6BSXiw4STT7tAgG2FUMopdr9trI";
const API_VERSION = "drive-upload-v5-rowid-20260528";
const OLD_SPREADSHEET_ID = "1qLKZfejUoJPnWF3epchzM0bCFm7mvZqyxgbOvtUIaB8";
const OLD_INVENTORY_SHEET_NAME = "庫存紀錄";
const IMAGE_MIGRATION_BATCH_SIZE = 10;

const INVENTORY_HEADERS = [
  "rowId",
  "createdAt",
  "updatedAt",
  "communityName",
  "lineName",
  "qty",
  "price",
  "partner",
  "status",
  "note",
  "imageUrl",
  "thumbnailUrl",
  "sortKey",
  "isArchived"
];

const SHIPMENT_HEADERS = [
  "shipmentId",
  "shipAt",
  "collectorName",
  "sourceRowId",
  "communityName",
  "lineName",
  "qty",
  "price",
  "subtotal",
  "partner",
  "note",
  "imageUrl",
  "operator"
];

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const mode = params.mode || "list";

    if (mode === "driveCheck") return jsonOutput(checkDriveAccess_());
    if (mode === "diagnostics") return jsonOutput(getLastAction_());
    if (mode === "settings") return jsonOutput(getSettings_());
    if (mode === "item") return jsonOutput(getItem_(params.rowId || params.row));

    return jsonOutput(listInventory_(params));
  } catch (err) {
    return jsonOutput({ ok: false, message: err.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let params = {};

  try {
    params = parseBody_(e);
    const method = String(params.method || "").toUpperCase();
    let result;

    if (method === "ADD") result = addInventory_(params);
    else if (method === "UPDATE") result = updateInventory_(params);
    else if (method === "DELETE") result = deleteInventory_(params);
    else if (method === "SHIP_BATCH") result = shipBatch_(params);
    else result = { ok: false, message: "未知的 method" };

    saveLastAction_({ ok: result.ok !== false, method, result, requestId: params.requestId || "" });
    return jsonOutput(result);
  } catch (err) {
    saveLastAction_({ ok: false, message: err.message, requestId: params.requestId || "" });
    return jsonOutput({ ok: false, message: err.message });
  } finally {
    lock.releaseLock();
  }
}

function listInventory_(params) {
  const page = Math.max(1, parseInt(params.page || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || "50", 10)));
  const keyword = normalize_(params.keyword || "");
  const status = String(params.status || "");
  const partner = String(params.partner || "");
  const includeImage = String(params.includeImage || "false") === "true";
  const sort = params.sort === "created" ? "created" : "updated";

  const cacheKey = [
    "list",
    page,
    pageSize,
    keyword,
    status,
    partner,
    includeImage,
    sort
  ].join("|");

  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const values = sheet.getDataRange().getValues();
  const header = values[headerRow - 1];
  const index = headerIndex_(header);
  const records = [];

  for (let i = headerRow; i < values.length; i++) {
    const row = values[i];
    const isArchived = row[index.isArchived] === true || String(row[index.isArchived]).toUpperCase() === "TRUE";
    const qty = Number(row[index.qty] || 0);
    const rowStatus = String(row[index.status] || "");
    const rowPartner = String(row[index.partner] || "");

    if (isArchived) continue;
    if (qty <= 0 && !status) continue;
    if (status && rowStatus !== status) continue;
    if (partner && rowPartner !== partner) continue;

    const searchable = normalize_([
      row[index.communityName],
      row[index.lineName],
      row[index.note],
      row[index.rowId]
    ].join(" "));
    if (keyword && searchable.indexOf(keyword) === -1) continue;

    records.push({
      row: i + 1,
      rowId: row[index.rowId],
      timestamp: row[index.createdAt],
      createdAt: row[index.createdAt],
      updatedAt: row[index.updatedAt],
      communityName: row[index.communityName],
      lineName: row[index.lineName],
      qty,
      price: Number(row[index.price] || 0),
      partner: rowPartner,
      status: rowStatus,
      note: row[index.note],
      image: includeImage ? publicImageUrl_(row[index.imageUrl]) : publicImageUrl_(row[index.thumbnailUrl]),
      imageUrl: includeImage ? publicImageUrl_(row[index.imageUrl]) : "",
      thumbnailUrl: publicImageUrl_(row[index.thumbnailUrl])
    });
  }

  records.sort((a, b) => {
    const aValue = sort === "created" ? a.createdAt : (a.updatedAt || a.createdAt);
    const bValue = sort === "created" ? b.createdAt : (b.updatedAt || b.createdAt);
    const at = new Date(aValue || 0).getTime();
    const bt = new Date(bValue || 0).getTime();
    return bt - at;
  });

  const start = (page - 1) * pageSize;
  const items = records.slice(start, start + pageSize);
  const result = {
    ok: true,
    apiVersion: API_VERSION,
    page,
    pageSize,
    sort,
    total: records.length,
    hasMore: start + pageSize < records.length,
    items
  };

  cache.put(cacheKey, JSON.stringify(result), 20);
  return result;
}

function getItem_(id) {
  if (!id) throw new Error("缺少 rowId");

  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const values = sheet.getDataRange().getValues();
  const index = headerIndex_(values[headerRow - 1]);
  const rowNumber = findRowNumber_(sheet, id);
  if (!rowNumber) throw new Error("找不到資料");

  const row = values[rowNumber - 1];
  return {
    ok: true,
    apiVersion: API_VERSION,
    item: {
      row: rowNumber,
      rowId: row[index.rowId],
      createdAt: row[index.createdAt],
      updatedAt: row[index.updatedAt],
      communityName: row[index.communityName],
      lineName: row[index.lineName],
      qty: Number(row[index.qty] || 0),
      price: Number(row[index.price] || 0),
      partner: row[index.partner],
      status: row[index.status],
      note: row[index.note],
      image: publicImageUrl_(row[index.imageUrl]),
      imageUrl: publicImageUrl_(row[index.imageUrl]),
      thumbnailUrl: publicImageUrl_(row[index.thumbnailUrl])
    }
  };
}

function addInventory_(params) {
  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const now = new Date();
  const rowId = makeUniqueId_("INV", getExistingRowIdMap_(sheet));
  const imageInfo = saveImageIfNeeded_(params.image || params.imageData || params.imageUrl, rowId);
  const imageUrl = params.imageUrl && !isDataUrl_(params.imageUrl) ? params.imageUrl : imageInfo.imageUrl;
  const thumbnailUrl = params.thumbnailUrl || imageInfo.thumbnailUrl || imageUrl;

  sheet.appendRow([
    rowId,
    now,
    now,
    params.communityName || "",
    params.lineName || "",
    Number(params.qty || 0),
    Number(params.price || 0),
    params.partner || "尚未安排",
    params.status || "📝 已登記",
    params.note || "",
    imageUrl,
    thumbnailUrl,
    Date.now(),
    false
  ]);

  clearListCache_();
  return { ok: true, apiVersion: API_VERSION, rowId, imageUrl, thumbnailUrl };
}

function updateInventory_(params) {
  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const rowNumber = findRowNumber_(sheet, params.rowId || params.row);
  if (!rowNumber || rowNumber < 2) throw new Error("找不到要更新的資料");

  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const header = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const index = headerIndex_(header);
  const allowed = [
    "communityName",
    "lineName",
    "qty",
    "price",
    "partner",
    "status",
    "note",
    "imageUrl",
    "thumbnailUrl",
    "isArchived"
  ];

  allowed.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      sheet.getRange(rowNumber, index[key] + 1).setValue(params[key]);
    }
  });

  if (Object.prototype.hasOwnProperty.call(params, "image")) {
    const rowId = sheet.getRange(rowNumber, index.rowId + 1).getValue();
    const imageInfo = saveImageIfNeeded_(params.image || "", rowId);
    sheet.getRange(rowNumber, index.imageUrl + 1).setValue(imageInfo.imageUrl || params.image || "");
    sheet.getRange(rowNumber, index.thumbnailUrl + 1).setValue(params.thumbnailUrl || imageInfo.thumbnailUrl || imageInfo.imageUrl || params.image || "");
    params._savedImageUrl = imageInfo.imageUrl || params.image || "";
    params._savedThumbnailUrl = params.thumbnailUrl || imageInfo.thumbnailUrl || imageInfo.imageUrl || params.image || "";
  }

  sheet.getRange(rowNumber, index.updatedAt + 1).setValue(new Date());
  clearListCache_();
  return {
    ok: true,
    apiVersion: API_VERSION,
    row: rowNumber,
    rowId: sheet.getRange(rowNumber, index.rowId + 1).getValue(),
    imageUrl: params._savedImageUrl || "",
    thumbnailUrl: params._savedThumbnailUrl || ""
  };
}

function deleteInventory_(params) {
  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const rowNumber = findRowNumber_(sheet, params.rowId || params.row);
  if (!rowNumber || rowNumber < 2) throw new Error("找不到要刪除的資料");

  // 新版預設封存，不直接刪列，避免前端或歷史資料錯位。
  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const index = headerIndex_(sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0]);
  sheet.getRange(rowNumber, index.isArchived + 1).setValue(true);
  sheet.getRange(rowNumber, index.updatedAt + 1).setValue(new Date());

  clearListCache_();
  return { ok: true, archived: true };
}

function shipBatch_(params) {
  const items = Array.isArray(params.items) ? params.items : [];
  const collectorName = params.collectorName || "";
  if (!items.length) throw new Error("沒有出貨項目");
  if (!collectorName) throw new Error("缺少領取人");

  const inventory = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const shipments = getSheet_(SHEET_NAMES.shipments, SHIPMENT_HEADERS);
  const invHeaderRow = getHeaderRow_(inventory, INVENTORY_HEADERS);
  const invHeader = inventory.getRange(invHeaderRow, 1, 1, inventory.getLastColumn()).getValues()[0];
  const invIndex = headerIndex_(invHeader);
  const now = new Date();
  const shipmentRows = [];

  items.forEach(item => {
    const rowNumber = findRowNumber_(inventory, item.rowId || item.row);
    if (!rowNumber || rowNumber < 2) throw new Error("找不到出貨項目：" + (item.rowId || item.row));

    const row = inventory.getRange(rowNumber, 1, 1, inventory.getLastColumn()).getValues()[0];
    const currentQty = Number(row[invIndex.qty] || 0);
    const pickQty = Number(item.pickQty || item.qty || 0);
    if (pickQty <= 0 || pickQty > currentQty) throw new Error("出貨數量錯誤：" + row[invIndex.rowId]);

    const newQty = currentQty - pickQty;
    inventory.getRange(rowNumber, invIndex.qty + 1).setValue(newQty);
    inventory.getRange(rowNumber, invIndex.status + 1).setValue(newQty <= 0 ? "✅ 出貨完成" : row[invIndex.status]);
    inventory.getRange(rowNumber, invIndex.updatedAt + 1).setValue(now);
    if (newQty <= 0) inventory.getRange(rowNumber, invIndex.isArchived + 1).setValue(true);

    shipmentRows.push([
      makeId_("SHIP"),
      now,
      collectorName,
      row[invIndex.rowId],
      row[invIndex.communityName],
      row[invIndex.lineName],
      pickQty,
      Number(row[invIndex.price] || 0),
      pickQty * Number(row[invIndex.price] || 0),
      row[invIndex.partner],
      row[invIndex.note],
      row[invIndex.imageUrl],
      params.operator || ""
    ]);
  });

  shipments.getRange(shipments.getLastRow() + 1, 1, shipmentRows.length, SHIPMENT_HEADERS.length).setValues(shipmentRows);
  clearListCache_();
  return { ok: true, shipped: shipmentRows.length };
}

function getSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.settings) || getSheet_(SHEET_NAMES.settings, ["代購選項", "狀態選項"]);
  const values = sheet.getDataRange().getValues();
  let headerRow = 0;
  for (let i = 0; i < Math.min(values.length, 10); i++) {
    if (values[i][0] === "代購選項" || values[i][1] === "狀態選項") {
      headerRow = i + 1;
      break;
    }
  }
  const partners = [];
  const statuses = [];

  for (let i = headerRow; i < values.length; i++) {
    if (values[i][0]) partners.push(values[i][0]);
    if (values[i][1]) statuses.push(values[i][1]);
  }

  return { ok: true, apiVersion: API_VERSION, partners, statuses };
}

function checkDriveAccess_() {
  const folder = DriveApp.getFolderById(DRIVE_IMAGE_FOLDER_ID);
  return {
    ok: true,
    apiVersion: API_VERSION,
    folderId: DRIVE_IMAGE_FOLDER_ID,
    folderName: folder.getName(),
    message: "Drive 資料夾可存取"
  };
}

function authorizeDriveAccess() {
  const folder = DriveApp.getFolderById(DRIVE_IMAGE_FOLDER_ID);
  const testFile = folder.createFile(
    Utilities.newBlob("authorization check", "text/plain", "智慧庫存_授權測試_可刪除.txt")
  );
  const createdFileId = testFile.getId();
  testFile.setTrashed(true);
  const result = {
    ok: true,
    apiVersion: API_VERSION,
    folderId: DRIVE_IMAGE_FOLDER_ID,
    folderName: folder.getName(),
    testFileId: createdFileId,
    message: "Drive 寫入權限正常，測試檔已移至垃圾桶"
  };
  Logger.log(JSON.stringify(result));
  return result;
}

/**
 * 先執行此函式檢查有多少目前庫存圖片可安全搬移。
 * 只報告結果，不會上傳圖片或修改工作表。
 */
function previewCurrentStockImageMigration() {
  const sourceMap = getLegacyImageMap_();
  const target = getCurrentInventoryRowsForMigration_();
  const result = {
    currentStock: target.length,
    alreadyHasDriveUrl: 0,
    canMigrate: 0,
    ambiguousMatch: 0,
    noImageMatch: 0,
    sampleNoMatch: []
  };

  target.forEach(item => {
    if (isUsableImageUrl_(item.imageUrl) || isUsableImageUrl_(item.thumbnailUrl)) {
      result.alreadyHasDriveUrl++;
      return;
    }

    if (isDataUrl_(item.imageUrl)) {
      result.canMigrate++;
      return;
    }

    const matches = sourceMap[item.key] || [];
    if (matches.length === 1 && isDataUrl_(matches[0].image)) {
      result.canMigrate++;
    } else if (matches.length > 1) {
      result.ambiguousMatch++;
    } else {
      result.noImageMatch++;
      if (result.sampleNoMatch.length < 5) result.sampleNoMatch.push(item.communityName || item.lineName || item.rowId);
    }
  });

  Logger.log(JSON.stringify(result));
  return result;
}

/**
 * 每次最多搬移 10 張目前庫存圖片，以避免 Apps Script 執行時間超限。
 * 可重複執行，直到回傳 done: true。
 */
function migrateCurrentStockImagesBatch() {
  const sourceMap = getLegacyImageMap_();
  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const values = sheet.getDataRange().getValues();
  const index = headerIndex_(values[headerRow - 1]);
  const propertyKey = "CURRENT_STOCK_IMAGE_MIGRATION_NEXT_ROW";
  const properties = PropertiesService.getScriptProperties();
  const startRow = Number(properties.getProperty(propertyKey) || (headerRow + 1));
  let checked = 0;
  let uploaded = 0;
  let skipped = 0;
  let ambiguous = 0;
  let noMatch = 0;
  let nextRow = startRow;

  for (let rowNumber = startRow; rowNumber <= values.length && checked < IMAGE_MIGRATION_BATCH_SIZE; rowNumber++) {
    nextRow = rowNumber + 1;
    const row = values[rowNumber - 1];
    const qty = Number(row[index.qty] || 0);
    const status = String(row[index.status] || "");
    const isArchived = row[index.isArchived] === true || String(row[index.isArchived]).toUpperCase() === "TRUE";
    if (qty <= 0 || isArchived || status === "✅ 出貨完成") continue;

    checked++;
    const currentImage = String(row[index.imageUrl] || "");
    const currentThumb = String(row[index.thumbnailUrl] || "");
    if (isUsableImageUrl_(currentImage) || isUsableImageUrl_(currentThumb)) {
      skipped++;
      continue;
    }

    let sourceImage = isDataUrl_(currentImage) ? currentImage : "";
    if (!sourceImage) {
      const key = inventoryMatchKey_(
        row[index.communityName],
        row[index.lineName],
        row[index.qty],
        row[index.price],
        row[index.partner],
        row[index.status],
        row[index.note]
      );
      const matches = sourceMap[key] || [];
      if (matches.length > 1) {
        ambiguous++;
        continue;
      }
      if (matches.length === 1 && isDataUrl_(matches[0].image)) sourceImage = matches[0].image;
    }

    if (!sourceImage) {
      noMatch++;
      continue;
    }

    const rowId = String(row[index.rowId] || ("MIGRATION-ROW-" + rowNumber));
    const imageInfo = saveImageIfNeeded_(sourceImage, rowId);
    sheet.getRange(rowNumber, index.imageUrl + 1).setValue(imageInfo.imageUrl);
    sheet.getRange(rowNumber, index.thumbnailUrl + 1).setValue(imageInfo.thumbnailUrl);
    uploaded++;
  }

  const done = nextRow > values.length;
  if (done) properties.deleteProperty(propertyKey);
  else properties.setProperty(propertyKey, String(nextRow));

  const result = { ok: true, checked, uploaded, skipped, ambiguous, noMatch, nextRow: done ? null : nextRow, done };
  Logger.log(JSON.stringify(result));
  return result;
}

function resetCurrentStockImageMigration() {
  PropertiesService.getScriptProperties().deleteProperty("CURRENT_STOCK_IMAGE_MIGRATION_NEXT_ROW");
  return { ok: true, message: "圖片搬移進度已重設" };
}

function getLegacyImageMap_() {
  const oldSs = SpreadsheetApp.openById(OLD_SPREADSHEET_ID);
  const oldSheet = oldSs.getSheetByName(OLD_INVENTORY_SHEET_NAME) || oldSs.getSheets()[0];
  const values = oldSheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!isDataUrl_(row[7])) continue;
    const key = inventoryMatchKey_(row[1], row[2], row[3], row[4], row[5], row[6], row[8]);
    if (!map[key]) map[key] = [];
    map[key].push({ row: i + 1, image: row[7] });
  }
  return map;
}

function getCurrentInventoryRowsForMigration_() {
  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const values = sheet.getDataRange().getValues();
  const index = headerIndex_(values[headerRow - 1]);
  const output = [];
  for (let i = headerRow; i < values.length; i++) {
    const row = values[i];
    const qty = Number(row[index.qty] || 0);
    const status = String(row[index.status] || "");
    const isArchived = row[index.isArchived] === true || String(row[index.isArchived]).toUpperCase() === "TRUE";
    if (qty <= 0 || isArchived || status === "✅ 出貨完成") continue;
    output.push({
      rowId: row[index.rowId],
      communityName: row[index.communityName],
      lineName: row[index.lineName],
      imageUrl: row[index.imageUrl],
      thumbnailUrl: row[index.thumbnailUrl],
      key: inventoryMatchKey_(
        row[index.communityName],
        row[index.lineName],
        row[index.qty],
        row[index.price],
        row[index.partner],
        row[index.status],
        row[index.note]
      )
    });
  }
  return output;
}

function inventoryMatchKey_(communityName, lineName, qty, price, partner, status, note) {
  return [
    communityName,
    lineName,
    Number(qty || 0),
    Number(price || 0),
    partner,
    status,
    note
  ].map(function(value) {
    return String(value || "").trim().toLowerCase();
  }).join("|");
}

function isUsableImageUrl_(value) {
  const text = String(value || "");
  return /^https?:\/\//.test(text) && text.indexOf("drive.google.com/...") === -1;
}

function saveLastAction_(data) {
  PropertiesService.getScriptProperties().setProperty("LAST_API_ACTION", JSON.stringify({
    apiVersion: API_VERSION,
    time: new Date().toISOString(),
    ok: data.ok,
    method: data.method || "",
    message: data.message || "",
    requestId: data.requestId || "",
    rowId: data.result && data.result.rowId ? data.result.rowId : "",
    imageUrl: data.result && data.result.imageUrl ? data.result.imageUrl : ""
  }));
}

function getLastAction_() {
  const saved = PropertiesService.getScriptProperties().getProperty("LAST_API_ACTION");
  return saved ? JSON.parse(saved) : { ok: true, apiVersion: API_VERSION, message: "尚無新的寫入紀錄" };
}

function saveImageIfNeeded_(imageValue, rowId) {
  if (!imageValue) return { imageUrl: "", thumbnailUrl: "" };
  const value = String(imageValue);
  if (!isDataUrl_(value)) {
    return { imageUrl: value, thumbnailUrl: value };
  }

  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error("圖片格式不正確");

  const contentType = match[1];
  const base64 = match[2];
  const extension = contentType.indexOf("png") !== -1 ? "png" : "jpg";
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, contentType, `${rowId}_${Date.now()}.${extension}`);
  const folder = DriveApp.getFolderById(DRIVE_IMAGE_FOLDER_ID);
  const file = folder.createFile(blob);

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    console.warn("無法設定圖片分享權限，請確認資料夾權限。", err);
  }

  const fileId = file.getId();
  return {
    imageUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
    thumbnailUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w300`
  };
}

function isDataUrl_(value) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(String(value || ""));
}

function publicImageUrl_(value) {
  if (!value) return "";
  const text = String(value);
  return isDataUrl_(text) ? "" : text;
}

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const headerRow = getHeaderRow_(sheet, headers);
  if (!headerRow) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function getHeaderRow_(sheet, headers) {
  const maxRows = Math.min(Math.max(sheet.getLastRow(), 1), 10);
  const maxCols = Math.max(sheet.getLastColumn(), headers.length);
  const values = sheet.getRange(1, 1, maxRows, maxCols).getValues();

  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    const hasAllHeaders = headers.every(header => row.indexOf(header) !== -1);
    if (hasAllHeaders) return r + 1;
  }
  return 0;
}

function headerIndex_(header) {
  const index = {};
  header.forEach((name, i) => {
    if (name) index[name] = i;
  });
  return index;
}

function findRowNumber_(sheet, rowIdOrRow) {
  if (!rowIdOrRow) return null;

  const asNumber = parseInt(rowIdOrRow, 10);
  if (String(rowIdOrRow) === String(asNumber) && asNumber >= 2 && asNumber <= sheet.getLastRow()) {
    return asNumber;
  }

  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (let i = Math.max(headerRow, 1); i < values.length; i++) {
    if (String(values[i][0]) === String(rowIdOrRow)) return i + 1;
  }
  return null;
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error("沒有收到資料");
  const rawContent = e.postData.contents.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return JSON.parse(rawContent);
}

function jsonOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function repairDuplicateRowIds() {
  const sheet = getSheet_(SHEET_NAMES.inventory, INVENTORY_HEADERS);
  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow <= headerRow) return { ok: true, repaired: 0, duplicate: 0, blank: 0 };

  const header = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const index = headerIndex_(header);
  const rowIdCol = index.rowId + 1;
  const values = sheet.getRange(headerRow + 1, rowIdCol, lastRow - headerRow, 1).getValues();
  const used = {};
  const repairs = [];
  let duplicate = 0;
  let blank = 0;

  values.forEach(function(row, offset) {
    const rowNumber = headerRow + 1 + offset;
    const current = String(row[0] || "").trim();

    if (!current) {
      blank++;
      const nextId = makeUniqueId_("INV", used);
      used[nextId] = true;
      repairs.push({ rowNumber: rowNumber, rowId: nextId });
      return;
    }

    if (used[current]) {
      duplicate++;
      const nextId = makeUniqueId_("INV", used);
      used[nextId] = true;
      repairs.push({ rowNumber: rowNumber, rowId: nextId });
      return;
    }

    used[current] = true;
  });

  repairs.forEach(function(item) {
    sheet.getRange(item.rowNumber, rowIdCol).setValue(item.rowId);
  });

  return {
    ok: true,
    apiVersion: API_VERSION,
    scanned: values.length,
    repaired: repairs.length,
    duplicate: duplicate,
    blank: blank,
    sample: repairs.slice(0, 10)
  };
}

function getExistingRowIdMap_(sheet) {
  const headerRow = getHeaderRow_(sheet, INVENTORY_HEADERS);
  const lastRow = sheet.getLastRow();
  const used = {};
  if (lastRow <= headerRow) return used;

  const values = sheet.getRange(headerRow + 1, 1, lastRow - headerRow, 1).getValues();
  values.forEach(function(row) {
    const id = String(row[0] || "").trim();
    if (id) used[id] = true;
  });
  return used;
}

function makeUniqueId_(prefix, used) {
  const seen = used || {};
  for (let i = 0; i < 50; i++) {
    const id = makeId_(prefix);
    if (!seen[id]) return id;
  }
  return prefix + "-" + new Date().getTime() + "-" + Utilities.getUuid();
}

function makeId_(prefix) {
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss-SSS");
  const uuid = Utilities.getUuid().replace(/-/g, "").slice(0, 10);
  return prefix + "-" + stamp + "-" + uuid;
}

function normalize_(value) {
  return String(value || "").toLowerCase().trim();
}

function clearListCache_() {
  // Apps Script 沒有萬用刪除 cache key，使用版本 key 會更完整。
  // 目前列表快取只有 20 秒，寫入後讓短快取自然過期即可。
}
