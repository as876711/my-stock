const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwUqPm2eDBBZt2gAQ1PGjXc8wfBMxVpziMUNj6l1DwFUX_vVgv-RoRQm-TsjIl36GCroQ/exec";
const DEFAULT_PARTNERS = ["萌寶目錄預購","東京速換金","妮小舖","NAZI夏批發","香港中國同行批發","橙日(日本奇異果)","ココ購","日和優選","東京買買","自行購買","尚未安排"];
const DEFAULT_STATUS_OPTS = ["📝 已登記","🛒 已採買","❌ 尚未買","⚠️ 缺貨","📦 已到貨","✅ 出貨完成"];
const PAGE_SIZE = 30;
let partners = [...DEFAULT_PARTNERS];
let statusOpts = [...DEFAULT_STATUS_OPTS];
let rawStockData = [];
let tempPickList = [];
let inventoryPage = 1;
let inventoryTotal = 0;
let inventoryHasMore = false;
let compressedImageData = "";
let toastTimer = null;
let communitySuggestions = [];
let communityQueryCache = new Set();
let lastAutoLineId = "";

const $ = id => document.getElementById(id);
const theme = () => document.body.dataset.theme || "desk";
function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(value) { return escapeHTML(value); }
function noteArg(value) { return encodeURIComponent(String(value ?? '')); }
function money(value) { return '$' + Number(value || 0).toLocaleString('en-US'); }
function showToast(message, state = '') { clearTimeout(toastTimer); const t = $('toast'); if (!t) return; t.textContent = message; t.className = `toast visible ${state}`.trim(); toastTimer = setTimeout(() => t.className = 'toast', 1800); }
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }

function init() {
  renderOptionSelects();
  document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view, btn)));
  $('filterID')?.addEventListener('input', debounce(() => prepareInventoryList(true), 300));
  $('filterPartner')?.addEventListener('change', () => prepareInventoryList(true));
  $('filterStatus')?.addEventListener('change', () => prepareInventoryList(true));
  $('sortMode')?.addEventListener('change', () => {
    if (getSortMode() === 'price_desc') renderRecords();
    else prepareInventoryList(true);
  });
  const debouncedCommunityLookup = debounce(fetchCommunitySuggestions, 120);
  $('inCommName')?.addEventListener('change', autoFillLineId);
  $('inCommName')?.addEventListener('blur', autoFillLineId);
  $('inCommName')?.addEventListener('input', () => {
    handleCommunityTyping();
    debouncedCommunityLookup();
  });
  $('inLineName')?.addEventListener('input', () => {
    if ($('inLineName').value !== lastAutoLineId) lastAutoLineId = "";
  });
  $('cameraInput')?.addEventListener('change', handlePhotoInput);
  loadSettingsOptions();
  prepareInventoryList(true);
}

async function loadSettingsOptions() {
  try {
    const data = await apiGet({ mode: 'settings', _: Date.now() });
    if (data.ok === false) throw new Error(data.message || '設定讀取失敗');
    partners = normalizeOptions(data.partners, DEFAULT_PARTNERS);
    statusOpts = normalizeOptions(data.statuses, DEFAULT_STATUS_OPTS);
    renderOptionSelects();
    if (rawStockData.length) renderRecords();
  } catch (err) {
    console.warn('設定選項讀取失敗，使用內建預設值', err);
  }
}
function normalizeOptions(options, fallback) {
  const seen = new Set();
  const cleaned = (Array.isArray(options) ? options : [])
    .map(item => String(item || '').trim())
    .filter(item => {
      const key = normalizeLookup(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return cleaned.length ? cleaned : [...fallback];
}
function renderOptionSelects() {
  renderSelectOptions('inPartner', partners);
  renderSelectOptions('inStatus', statusOpts);
  renderSelectOptions('filterPartner', partners, '全部代購');
  renderSelectOptions('filterStatus', statusOpts, '全部狀態');
}
function renderSelectOptions(id, values, blankText = '') {
  const el = $(id);
  if (!el) return;
  const current = el.value;
  const optionValues = optionListWithCurrent(values, current);
  const blank = blankText ? `<option value="">${escapeHTML(blankText)}</option>` : '';
  el.innerHTML = blank + optionValues.map(value => `<option value="${escapeAttr(value)}">${escapeHTML(value)}</option>`).join('');
  if (current && optionValues.includes(current)) el.value = current;
}
function optionListWithCurrent(values, current) {
  const list = [...values];
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

function showView(viewId, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(viewId)?.classList.add('active');
  document.querySelectorAll('[data-view]').forEach(t => t.classList.remove('active'));
  document.querySelectorAll(`[data-view="${viewId}"]`).forEach(t => t.classList.add('active'));
  if (viewId === 'recordView') prepareInventoryList(false);
}

async function apiGet(params = {}) {
  const url = new URL(GOOGLE_SCRIPT_URL);
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value); });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function newRequestId() { return crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
async function waitForWriteResult(requestId) {
  for (let i = 0; i < 7; i++) {
    await new Promise(r => setTimeout(r, 800));
    const last = await apiGet({ mode: 'diagnostics', _: Date.now() });
    if (last.requestId !== requestId) continue;
    if (last.ok === false) throw new Error(last.message || '同步失敗');
    return { verified: true, ...last };
  }
  return { verified: false };
}
async function postToGoogle(payload) {
  const requestId = payload.requestId || newRequestId();
  await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...payload, requestId }) });
  return waitForWriteResult(requestId);
}

async function prepareInventoryList(reset = false) {
  if (reset) inventoryPage = 1;
  if ($('inventoryContainer')) $('inventoryContainer').innerHTML = emptyMarkup('載入中...');
  try {
    const keyword = $('filterID')?.value.trim() || '';
    const data = keyword ? await fetchFuzzyInventory(keyword) : await fetchInventoryPage(inventoryPage, PAGE_SIZE, '');
    if (data.ok === false) throw new Error(data.message || '讀取失敗');
    rawStockData = Array.isArray(data.items) ? data.items : [];
    inventoryTotal = Number(data.total || rawStockData.length);
    inventoryHasMore = Boolean(data.hasMore);
    updateCommunitySuggestions(rawStockData);
    renderRecords();
    setText('syncState', '雲端已同步');
    setText('syncTime', new Date().toLocaleString('zh-TW'));
  } catch (err) {
    if ($('inventoryContainer')) $('inventoryContainer').innerHTML = emptyMarkup('讀取失敗，請稍後再試。');
    showToast(err.message || '讀取失敗', 'error');
  }
}
async function fetchInventoryPage(page, pageSize, keyword = '') {
  return apiGet({
    mode: 'list',
    page,
    pageSize,
    keyword,
    partner: $('filterPartner')?.value || '',
    status: $('filterStatus')?.value || '',
    sort: getBackendSortMode()
  });
}
async function fetchFuzzyInventory(keyword) {
  const pageSize = 100;
  let page = 1;
  let hasMore = true;
  const allItems = [];

  while (hasMore && page <= 10) {
    const data = await fetchInventoryPage(page, pageSize, '');
    if (data.ok === false) return data;
    const items = Array.isArray(data.items) ? data.items : [];
    allItems.push(...items);
    hasMore = Boolean(data.hasMore);
    page += 1;
  }

  const items = allItems.filter(item => fuzzyItemMatches(item, keyword));
  return {
    ok: true,
    page: 1,
    pageSize,
    total: items.length,
    hasMore: false,
    items
  };
}
function fuzzyItemMatches(item, keyword) {
  const tokens = splitSearchTokens(keyword);
  if (!tokens.length) return true;
  const fields = [
    item.communityName,
    item.lineName,
    item.note,
    item.partner,
    item.status,
    item.rowId
  ].map(normalizeSearchText).filter(Boolean);
  const combined = fields.join('');
  return tokens.every(token => fields.some(field => fuzzyTextMatches(field, token)) || fuzzyTextMatches(combined, token));
}
function splitSearchTokens(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .map(normalizeSearchText)
    .filter(Boolean);
}
function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_.,/\\|@#:$%^&*+=!?~`'"()[\]{}<>，。、；：！？「」『』（）【】《》]/g, '');
}
function fuzzyTextMatches(text, token) {
  if (!token) return true;
  if (!text) return false;
  if (text.includes(token)) return true;
  if (token.length < 2) return false;
  let pos = 0;
  for (const char of text) {
    if (char === token[pos]) pos += 1;
    if (pos === token.length) return true;
  }
  return false;
}
function handleCommunityTyping() {
  const keyword = $('inCommName')?.value.trim() || '';
  const lineInput = $('inLineName');
  if (lineInput && lastAutoLineId && lineInput.value === lastAutoLineId) {
    lineInput.value = "";
    lastAutoLineId = "";
  }
  renderCommunitySuggestions(keyword);
  fillLineFromSuggestions(true);
}
async function fetchCommunitySuggestions() {
  const keyword = $('inCommName')?.value.trim() || '';
  if (keyword.length < 1) return;
  const cacheKey = normalizeLookup(keyword);
  if (communityQueryCache.has(cacheKey)) return;
  communityQueryCache.add(cacheKey);

  try {
    const data = await apiGet({ mode: 'list', page: 1, pageSize: 30, keyword, sort: 'updated' });
    updateCommunitySuggestions(Array.isArray(data.items) ? data.items : []);
    renderCommunitySuggestions(keyword);
    fillLineFromSuggestions(true);
  } catch (err) {
    communityQueryCache.delete(cacheKey);
    console.warn('社群 ID 選單查詢失敗', err);
  }
}
function updateCommunitySuggestions(items) {
  const seen = new Set(communitySuggestions.map(item => normalizeLookup(item.communityName)));
  items.forEach(item => {
    const communityName = String(item.communityName || '').trim();
    if (!communityName) return;
    const key = normalizeLookup(communityName);
    if (seen.has(key)) return;
    seen.add(key);
    communitySuggestions.push({
      communityName,
      lineName: String(item.lineName || '').trim()
    });
  });
  renderCommunitySuggestions($('inCommName')?.value.trim() || '');
}
function renderCommunitySuggestions(keyword = '') {
  const list = $('commSuggestions');
  if (!list) return;
  const query = normalizeLookup(keyword);
  const options = communitySuggestions
    .filter(item => !query || normalizeLookup(item.communityName).includes(query))
    .slice(0, 40)
    .map(item => `<option value="${escapeAttr(item.communityName)}"${item.lineName ? ` label="LINE: ${escapeAttr(item.lineName)}"` : ''}></option>`)
    .join('');
  list.innerHTML = options;
}
async function autoFillLineId() {
  const comm = $('inCommName')?.value.trim();
  const lineInput = $('inLineName');
  if (!comm || !lineInput) return;
  if (lineInput.value.trim() && lineInput.value !== lastAutoLineId) return;

  if (fillLineFromSuggestions(false)) return;

  const localMatch = findLineIdByCommunity(rawStockData, comm);
  if (localMatch) {
    lineInput.value = localMatch;
    lastAutoLineId = localMatch;
    showToast('已自動帶入 LINE ID', 'success');
    return;
  }

  try {
    const data = await apiGet({ mode: 'list', page: 1, pageSize: 20, keyword: comm, sort: 'updated' });
    const match = findLineIdByCommunity(Array.isArray(data.items) ? data.items : [], comm);
    if (match && (!lineInput.value.trim() || lineInput.value === lastAutoLineId)) {
      lineInput.value = match;
      lastAutoLineId = match;
      showToast('已從歷史資料帶入 LINE ID', 'success');
    }
  } catch (err) {
    console.warn('自動帶入 LINE ID 失敗', err);
  }
}
function fillLineFromSuggestions(silent = false) {
  const comm = $('inCommName')?.value.trim();
  const lineInput = $('inLineName');
  if (!comm || !lineInput) return false;
  if (lineInput.value.trim() && lineInput.value !== lastAutoLineId) return false;
  const match = findLineIdByCommunity(communitySuggestions, comm);
  if (!match) return false;
  lineInput.value = match;
  lastAutoLineId = match;
  if (!silent) showToast('已自動帶入 LINE ID', 'success');
  return true;
}
function findLineIdByCommunity(items, communityName) {
  const target = normalizeLookup(communityName);
  const match = items.find(item => normalizeLookup(item.communityName) === target && String(item.lineName || '').trim());
  return match ? String(match.lineName || '').trim() : '';
}
function normalizeLookup(value) {
  return String(value || '').trim().toLowerCase();
}
async function loadMoreInventory() {
  if (!inventoryHasMore) return;
  inventoryPage += 1;
  try {
    const data = await fetchInventoryPage(inventoryPage, PAGE_SIZE, $('filterID')?.value.trim() || '');
    rawStockData = rawStockData.concat(Array.isArray(data.items) ? data.items : []);
    inventoryTotal = Number(data.total || rawStockData.length);
    inventoryHasMore = Boolean(data.hasMore);
    updateCommunitySuggestions(Array.isArray(data.items) ? data.items : []);
    renderRecords();
  } catch (err) { showToast('載入更多失敗', 'error'); }
}
function setText(id, text) { if ($(id)) $(id).textContent = text; }
function emptyMarkup(text) { return theme() === 'table' ? `<div class="table-row"><div>${escapeHTML(text)}</div></div>` : `<div class="empty">${escapeHTML(text)}</div>`; }
function statusClass(status) { if (status === '📦 已到貨') return 'green'; if (status === '🛒 已採買' || status === '⚠️ 缺貨') return theme() === 'table' ? 'amber' : 'amber'; return 'blue'; }
function getSortMode() { return $('sortMode')?.value || 'created'; }
function getBackendSortMode() { return getSortMode() === 'updated' ? 'updated' : 'created'; }
function sortRecords(items) {
  const mode = getSortMode();
  const list = [...items];
  if (mode === 'price_desc') {
    return list.sort((a, b) => (Number(b.price || 0) * Number(b.qty || 0)) - (Number(a.price || 0) * Number(a.qty || 0)));
  }
  const dateKey = mode === 'updated' ? 'updatedAt' : 'createdAt';
  return list.sort((a, b) => new Date(b[dateKey] || b.timestamp || 0).getTime() - new Date(a[dateKey] || a.timestamp || 0).getTime());
}

function renderRecords() {
  let totalQty = 0, totalCash = 0;
  const rows = sortRecords(rawStockData).map(item => {
    const qty = Number(item.qty || 0);
    const price = Number(item.price || 0);
    totalQty += qty;
    totalCash += qty * price;
    return theme() === 'table' ? renderTableRecord(item, qty, price) : renderDeskRecord(item, qty, price);
  }).join('');
  $('inventoryContainer').innerHTML = rows || emptyMarkup('目前沒有符合條件的庫存');
  if ($('loadMoreBtn')) $('loadMoreBtn').style.display = inventoryHasMore ? 'block' : 'none';
  setText('loadInfo', `載入 ${rawStockData.length} / ${inventoryTotal}`);
  setText('statCount', `${inventoryTotal}`);
  setText('statQty', `${totalQty}`);
  setText('statCash', money(totalCash));
}

function renderDeskRecord(item, qty, price) {
  const image = escapeAttr(item.image || item.thumbnailUrl || 'https://via.placeholder.com/100?text=無圖片');
  const note = item.note ? escapeHTML(item.note).replace(/\n/g, '<br>') : '+ 補備註';
  const pickedQty = getPickedQty(item.row);
  const remainingQty = Math.max(0, qty - pickedQty);
  const pickDisabled = remainingQty <= 0 ? 'disabled' : '';
  const pickLabel = remainingQty <= 0 ? '已滿' : '加入';
  const fullClass = remainingQty <= 0 ? ' is-full' : '';
  const statusText = remainingQty <= 0 ? '已選滿' : escapeHTML(item.status || '未設定');
  const statusChipClass = remainingQty <= 0 ? 'full' : statusClass(item.status);
  return `<article class="record${fullClass}">
    <div class="record-top"><img src="${image}" loading="lazy" onclick="viewImage(this.src)" onerror="this.src='https://via.placeholder.com/100?text=無圖片'"><div><h3>${escapeHTML(item.communityName || '無')}</h3><div class="meta">LINE: ${escapeHTML(item.lineName || '無')} · ${escapeHTML(item.partner || '尚未安排')}</div><span class="note" onclick="openNoteModal(${item.row}, decodeURIComponent('${noteArg(item.note || '')}'))">${note}</span><div class="record-controls">${selectsMarkup(item)}</div></div></div>
    <div class="record-bottom"><span class="stock-info"><span class="amount">${money(price * qty)}</span><span class="remain">剩 ${remainingQty}/${qty} 件</span></span><span class="chip ${statusChipClass}">${statusText}</span><span class="mini-actions"><input class="qty-input" id="pQty_${item.row}" type="number" min="1" max="${remainingQty}" value="${remainingQty}" ${pickDisabled}><button class="add-pick" onclick="addPick(${item.row})" ${pickDisabled}>${pickLabel}</button><button class="icon" onclick="triggerEditPhoto(${item.row})">📷</button><button class="icon danger" onclick="deleteRow(${item.row})">🗑</button></span></div>
  </article>`;
}
function renderTableRecord(item, qty, price) {
  const image = escapeAttr(item.image || item.thumbnailUrl || 'https://via.placeholder.com/100?text=無圖片');
  const note = escapeHTML(item.note || '');
  const pickedQty = getPickedQty(item.row);
  const remainingQty = Math.max(0, qty - pickedQty);
  const pickDisabled = remainingQty <= 0 ? 'disabled' : '';
  return `<div class="table-row">
    <img class="photo" src="${image}" onclick="viewImage(this.src)" onerror="this.src='https://via.placeholder.com/100?text=無圖片'">
    <div class="item-name"><b>${escapeHTML(item.communityName || '無')}</b><span>LINE: ${escapeHTML(item.lineName || '無')} · ${note || '無備註'}</span></div>
    <div>${selectMarkup('partner', item)}</div>
    <span class="chip ${statusClass(item.status)}">${escapeHTML(item.status || '未設定')}</span>
    <div><span class="money">${money(price * qty)}</span><br><span class="qty">剩 ${remainingQty}/${qty} 件</span></div>
    <div class="actions"><input class="qty-input" id="pQty_${item.row}" type="number" min="1" max="${remainingQty}" value="${remainingQty}" ${pickDisabled}><button class="icon" onclick="addPick(${item.row})" ${pickDisabled}>＋</button><button class="icon" onclick="triggerEditPhoto(${item.row})">📷</button><button class="icon danger" onclick="deleteRow(${item.row})">🗑</button></div>
  </div>`;
}
function selectsMarkup(item) { return selectMarkup('partner', item) + selectMarkup('status', item); }
function selectMarkup(key, item) {
  const arr = key === 'partner' ? partners : statusOpts;
  const current = item[key] || '';
  return `<select onchange="updateRow(${item.row}, '${key}', this.value)">${optionListWithCurrent(arr, current).map(v => `<option value="${escapeAttr(v)}" ${current === v ? 'selected' : ''}>${escapeHTML(v)}</option>`).join('')}</select>`;
}
function getPickedQty(row) {
  const picked = tempPickList.find(p => Number(p.row) === Number(row));
  return picked ? Number(picked.pickQty || 0) : 0;
}

function addPick(row) {
  const item = rawStockData.find(i => Number(i.row) === Number(row));
  if (!item) return;
  const stockQty = Number(item.qty || 0);
  const qty = Number($(`pQty_${row}`)?.value || 1);
  if (!Number.isFinite(qty) || qty <= 0) return showToast('請輸入正確數量', 'error');
  if (stockQty <= 0) return showToast('此商品已無庫存', 'error');

  const existing = tempPickList.find(p => Number(p.row) === Number(row));
  const alreadyPicked = existing ? Number(existing.pickQty || 0) : 0;
  const remaining = stockQty - alreadyPicked;

  if (remaining <= 0) return showToast(`已選滿庫存 ${stockQty} 件`, 'error');
  if (qty > remaining) {
    const input = $(`pQty_${row}`);
    if (input) input.value = remaining;
    return showToast(`最多只能再選 ${remaining} 件`, 'error');
  }

  if (existing) existing.pickQty = alreadyPicked + qty;
  else tempPickList.push({ ...item, pickQty: qty });

  const input = $(`pQty_${row}`);
  if (input) input.value = Math.max(1, Math.min(stockQty - (existing ? Number(existing.pickQty || 0) : qty), stockQty));
  renderSummary();
  renderRecords();
}
function addLoadedRecordsToPickList() {
  const rows = sortRecords(rawStockData);
  if (!rows.length) return showToast('目前沒有可加入的紀錄', 'error');

  let addedRows = 0;
  let addedQty = 0;
  rows.forEach(item => {
    const stockQty = Number(item.qty || 0);
    if (!Number.isFinite(stockQty) || stockQty <= 0) return;

    const existing = tempPickList.find(p => Number(p.row) === Number(item.row));
    const alreadyPicked = existing ? Number(existing.pickQty || 0) : 0;
    const remaining = stockQty - alreadyPicked;
    if (remaining <= 0) return;

    if (existing) existing.pickQty = alreadyPicked + remaining;
    else tempPickList.push({ ...item, pickQty: remaining });
    addedRows += 1;
    addedQty += remaining;
  });

  if (!addedRows) return showToast('目前紀錄都已選滿', 'error');
  renderSummary();
  renderRecords();
  showToast(`已加入 ${addedRows} 筆，共 ${addedQty} 件`, 'success');
}
function renderSummary() {
  let totalQty = 0, total = 0;
  const groups = new Map();
  tempPickList.forEach((item, idx) => {
    const qty = Number(item.pickQty || 0);
    const price = Number(item.price || 0);
    totalQty += qty;
    total += qty * price;
    const key = normalizeLookup(item.communityName || item.lineName || '未分類');
    if (!groups.has(key)) groups.set(key, { label: item.communityName || item.lineName || '未分類', qty: 0, total: 0, items: [] });
    const group = groups.get(key);
    group.qty += qty;
    group.total += qty * price;
    group.items.push({ item, idx });
  });
  const html = Array.from(groups.values()).map(group => {
    const rows = group.items.map(({ item, idx }) => {
      const qty = Number(item.pickQty || 0);
      const price = Number(item.price || 0);
      const image = escapeAttr(item.image || item.thumbnailUrl || 'https://via.placeholder.com/80?text=無圖');
      const cls = theme() === 'table' ? 'pick-card' : 'pick-row';
      const note = item.note ? `<span title="${escapeAttr(item.note)}">備註：${escapeHTML(item.note)}</span>` : '<span>無備註</span>';
      return `<div class="${cls}"><img src="${image}" onclick="viewImage(this.src)" onerror="this.src='https://via.placeholder.com/80?text=無圖'"><div><b>${escapeHTML(item.communityName || item.lineName || '無')}</b><span>${qty} 件 · ${money(qty * price)}</span>${note}</div><button class="remove" onclick="removeItem(${idx})">×</button></div>`;
    }).join('');
    return `<section class="pick-group"><div class="pick-group-head"><b>${escapeHTML(group.label)}</b><button class="fill-collector" onclick="fillCollectorName(decodeURIComponent('${noteArg(group.label)}'))">帶入</button><span>${group.qty} 件 · ${money(group.total)}</span></div>${rows}</section>`;
  }).join('');
  $('pickSummary').innerHTML = html || '<div class="empty">尚未選取商品</div>';
  setText('pickStatCount', `${totalQty} 件`);
  setText('pickTotalAmount', money(total));
  if ($('createPickSheetBtn')) $('createPickSheetBtn').disabled = tempPickList.length === 0;
  if ($('clearPickBtn')) $('clearPickBtn').disabled = tempPickList.length === 0;
}
function fillCollectorName(name) {
  if (!$('pickCollectorName')) return;
  $('pickCollectorName').value = String(name || '').trim();
  showToast('已帶入領取人', 'success');
}
function removeItem(idx) {
  tempPickList.splice(idx, 1);
  renderSummary();
  renderRecords();
}
function clearPickList() {
  if (!tempPickList.length) return;
  if (!confirm('確定清空已選明細？')) return;
  tempPickList = [];
  renderSummary();
  renderRecords();
  showToast('已清空已選明細', 'success');
}

function openNoteModal(row, note) { $('editNoteRow').value = row; $('editNoteInput').value = note; $('noteModal').classList.add('open'); }
function closeNoteModal() { $('noteModal').classList.remove('open'); }
async function saveNote() {
  const row = Number($('editNoteRow').value);
  const note = $('editNoteInput').value;
  const item = rawStockData.find(i => Number(i.row) === row);
  const old = item ? item.note : '';
  if (item) item.note = note;
  closeNoteModal(); renderRecords(); showToast('備註已更新，背景同步中...');
  try { await postToGoogle({ method:'UPDATE', row, note }); showToast('備註已同步', 'success'); }
  catch (err) { if (item) item.note = old; renderRecords(); showToast('備註同步失敗', 'error'); }
}
function updateRow(row, key, val) {
  const item = rawStockData.find(i => Number(i.row) === Number(row));
  const old = item ? item[key] : '';
  if (item) item[key] = val;
  showToast('正在同步變更...');
  return postToGoogle({ method:'UPDATE', row:Number(row), [key]: val }).then(() => showToast('變更已同步', 'success')).catch(() => { if (item) item[key] = old; renderRecords(); showToast('同步失敗', 'error'); });
}
async function deleteRow(row) {
  if (!confirm('確定刪除？')) return;
  await postToGoogle({ method:'DELETE', row:Number(row) });
  rawStockData = rawStockData.filter(i => Number(i.row) !== Number(row));
  renderRecords();
  showToast('已刪除', 'success');
}
function viewImage(src) { $('fullImage').src = src; $('imageViewer').classList.add('open'); }
function handlePhotoInput(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = event => { const img = new Image(); img.onload = () => { const cvs = document.createElement('canvas'); const scale = Math.min(1, 700 / img.width); cvs.width = Math.round(img.width * scale); cvs.height = Math.round(img.height * scale); cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height); compressedImageData = cvs.toDataURL('image/jpeg', .58); if ($('preview')) { $('preview').src = compressedImageData; $('preview').style.display = 'block'; } showToast('照片已準備'); }; img.src = event.target.result; };
  reader.readAsDataURL(file);
}
async function addToInventory() {
  const comm = $('inCommName').value.trim(); if (!comm) return showToast('請填寫社群 ID', 'error');
  const btn = $('inBtn'); btn.disabled = true; btn.textContent = '同步中...';
  try {
    await postToGoogle({ method:'ADD', communityName: comm, lineName: $('inLineName').value, qty: Number($('inQty').value || 1), price: Number($('inPrice').value || 0), partner: $('inPartner').value, status: $('inStatus').value, note: $('inNote').value, image: compressedImageData });
    showToast('入庫完成', 'success');
    ['inPrice','inNote'].forEach(id => $(id).value = '');
    if ($('inQty')) $('inQty').value = 1;
    if ($('cameraInput')) $('cameraInput').value = '';
    compressedImageData = '';
    if ($('preview')) $('preview').style.display = 'none';
    prepareInventoryList(true);
  } catch (err) { showToast(err.message || '入庫失敗', 'error'); }
  finally { btn.disabled = false; btn.textContent = '確認同步入庫'; }
}
async function triggerEditPhoto(row) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
  input.onchange = e => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = event => { const img = new Image(); img.onload = async () => { const cvs = document.createElement('canvas'); const scale = Math.min(1, 700 / img.width); cvs.width = Math.round(img.width * scale); cvs.height = Math.round(img.height * scale); cvs.getContext('2d').drawImage(img,0,0,cvs.width,cvs.height); const image = cvs.toDataURL('image/jpeg', .58); showToast('正在上傳圖片...'); try { await postToGoogle({ method:'UPDATE', row:Number(row), image }); showToast('圖片已更新', 'success'); prepareInventoryList(true); } catch (err) { showToast('圖片更新失敗', 'error'); } }; img.src = event.target.result; }; reader.readAsDataURL(file); };
  input.click();
}
function confirmPickAndShowSheet() {
  const name = $('pickCollectorName').value.trim(); if (!name || !tempPickList.length) return showToast('請填寫領取人並選取商品', 'error');
  const validation = validatePickList();
  if (!validation.ok) return showToast(validation.message, 'error');
  $('resName').textContent = name; $('resTime').textContent = new Date().toLocaleDateString('zh-TW'); let total = 0;
  $('resTableBody').innerHTML = tempPickList.map(item => { const qty = Number(item.pickQty || 0); const subtotal = qty * Number(item.price || 0); total += subtotal; const image = escapeAttr(item.image || item.thumbnailUrl || 'https://via.placeholder.com/100?text=無圖'); return `<tr><td style="width:116px"><img class="print-img" src="${image}"></td><td><b>${escapeHTML(item.communityName || item.lineName || '無')}</b><br>${escapeHTML(item.note || '')}</td><td>${qty} 件</td><td>${money(subtotal)}</td></tr>`; }).join('');
  if ($('resSummary')) $('resSummary').remove();
  $('resTotal').textContent = money(total); $('printOverlay').classList.add('open');
}
function validatePickList() {
  for (const picked of tempPickList) {
    const source = rawStockData.find(item => Number(item.row) === Number(picked.row));
    if (!source) return { ok: false, message: '有商品已不在目前庫存清單，請重新同步' };
    const stockQty = Number(source.qty || 0);
    const pickQty = Number(picked.pickQty || 0);
    if (!Number.isFinite(pickQty) || pickQty <= 0) return { ok: false, message: '檢貨數量不可小於 1' };
    if (pickQty > stockQty) return { ok: false, message: `${source.communityName || source.lineName || '商品'} 超過庫存 ${stockQty} 件` };
  }
  return { ok: true };
}
async function finalCommitToGoogle() {
  if (!confirm('確定要扣庫存結案嗎？')) return;
  const validation = validatePickList();
  if (!validation.ok) return showToast(validation.message, 'error');
  const btn = $('finalConfirmBtn'); btn.disabled = true; btn.textContent = '同步中...';
  try { await postToGoogle({ method:'SHIP_BATCH', collectorName: $('pickCollectorName').value.trim(), items: tempPickList.map(i => ({ rowId:i.rowId, row:i.row, pickQty:i.pickQty })) }); showToast('結案成功', 'success'); tempPickList = []; renderSummary(); $('printOverlay').classList.remove('open'); prepareInventoryList(true); }
  catch (err) { showToast('結案失敗', 'error'); }
  finally { btn.disabled = false; btn.textContent = '確認出貨'; }
}

init();
