import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const dir = new URL(".", import.meta.url);
const files = await fs.readdir(dir);
const xlsxName = files.find(name => name.endsWith(".xlsx") && name.includes("優化版"));
if (!xlsxName) throw new Error("找不到優化版 xlsx");

const file = await FileBlob.load(fileURLToPath(new URL(xlsxName, dir)));
const wb = await SpreadsheetFile.importXlsx(file);
const sheets = await wb.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 });
console.log(sheets.ndjson);
const inv = await wb.inspect({
  kind: "table",
  range: "庫存中!A1:N7",
  include: "values,formulas",
  tableMaxRows: 8,
  tableMaxCols: 14,
  maxChars: 6000,
});
console.log(inv.ndjson);
const errors = await wb.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  maxChars: 3000,
});
console.log(errors.ndjson);
