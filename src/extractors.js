import { calculateDiscountRate, cleanText, toNumber, uniqueBy } from './utils.js';

const PRODUCT_ID_KEYS = [
  'godNo', 'godCd', 'goodsNo', 'goodsId', 'productNo', 'productId', 'prdNo', 'prdId', 'itemNo'
];
const NAME_KEYS = ['godNm', 'goodsName', 'goodsNm', 'productName', 'prdNm', 'itemName', 'displayName', 'name'];
const BRAND_KEYS = ['brndNm', 'brandName', 'brandNm', 'brand'];
const CURRENT_PRICE_KEYS = [
  'salePrc', 'salePrice', 'currentPrice', 'sellingPrice', 'sellPrice', 'finalPrice', 'payPrice', 'price'
];
const ORIGINAL_PRICE_KEYS = [
  'rtp', 'normalPrc', 'originalPrice', 'regularPrice', 'tagPrice', 'consumerPrice', 'listPrice'
];
const DISCOUNT_KEYS = ['dcRt', 'dcRate', 'discountRate', 'discountPercent', 'saleRate'];
const STOCK_KEYS = [
  'stockQty', 'stockQuantity', 'availableStock', 'realStockQty', 'godStockQty', 'remainQty', 'salePsbQty', 'inventoryQty'
];
const IMAGE_KEYS = ['godImg', 'imageUrl', 'imgUrl', 'mainImg', 'thumbnail', 'thumbnailUrl', 'image'];
const URL_KEYS = ['godUrl', 'productUrl', 'detailUrl', 'linkUrl', 'url'];
const SOLDOUT_KEYS = ['soldOutYn', 'soldoutYn', 'soldOut', 'soldout', 'outOfStockYn', 'stockYn', 'salePsbYn', 'availableYn'];
const OPTION_HINT_KEYS = ['itmNo', 'skuNo', 'optionNo', 'optionId', 'size', 'sizeCd', 'itmNm', 'optionName', 'optionValue'];
const PRODUCT_CODE_KEYS = [
  'styleCode', 'styleCd', 'styleNo', 'modelCode', 'modelCd', 'modelNo', 'modelNumber',
  'articleCode', 'articleNo', 'articleNumber', 'partNumber', 'productCode', 'productCd',
  'goodsCode', 'goodsCd', 'godCode', 'godCd', 'itemCode', 'itemCd', 'sku', 'skuCode',
  'erpGodNo', 'erpGoodsNo', 'vendorGodNo', 'vendorGoodsNo', 'supplyGodNo', 'mdsGodNo'
];

export function extractProductsFromJson(data, brandHint = null) {
  const products = [];
  const visited = new Set();
  let inspected = 0;

  function walk(value) {
    if (!value || typeof value !== 'object' || visited.has(value) || inspected > 150_000) return;
    visited.add(value);
    inspected += 1;

    if (!Array.isArray(value)) {
      const product = productFromObject(value, brandHint);
      if (product) products.push(product);
    }

    for (const child of Object.values(value)) walk(child);
  }

  walk(data);
  return mergeProducts(products);
}

export function productFromObject(node, brandHint = null) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const id = normalizeProductId(firstValue(node, PRODUCT_ID_KEYS) || findProductIdInObject(node));
  if (!id) return null;

  const name = cleanText(firstValue(node, NAME_KEYS));
  const currentPrice = toNumber(firstValue(node, CURRENT_PRICE_KEYS));
  const originalPrice = toNumber(firstValue(node, ORIGINAL_PRICE_KEYS));
  let discountRate = toNumber(firstValue(node, DISCOUNT_KEYS));
  if (discountRate === null) discountRate = calculateDiscountRate(originalPrice, currentPrice);

  const soldOut = soldOutFromObject(node);
  const stockQuantity = toNumber(firstValue(node, STOCK_KEYS));
  const imageUrl = normalizeImageUrl(firstValue(node, IMAGE_KEYS));
  const candidateUrl = firstValue(node, URL_KEYS);
  const url = normalizeProductUrl(candidateUrl, id);
  const options = extractOptionsFromObject(node);
  const productCodes = extractProductCodes(node, name, id);

  // Avoid treating SKU/option rows as complete products. Option rows often repeat godNo but do not carry product-level name/price/image.
  const hasProductIdentity = Boolean(
    firstValue(node, ['godNm', 'goodsName', 'goodsNm', 'productName', 'prdNm', 'itemName', 'displayName']) ||
    currentPrice !== null || originalPrice !== null || imageUrl || candidateUrl
  );
  if (!hasProductIdentity) return null;
  if (!name && currentPrice === null && !imageUrl && !candidateUrl) return null;

  return finalizeProduct({
    id,
    name,
    brand: cleanText(firstValue(node, BRAND_KEYS)) || brandHint,
    originalPrice,
    currentPrice,
    discountRate,
    soldOut,
    stockQuantity,
    stockStatus: stockStatusText(soldOut, stockQuantity),
    options,
    url,
    imageUrl,
    productCodes
  }, brandHint);
}

export function extractDomCard(raw, brandHint = null) {
  const id = normalizeProductId(raw?.id || raw?.href);
  if (!id) return null;
  const text = cleanText(raw?.text, 2000) || '';
  const prices = [...text.matchAll(/(?:^|\s)(\d{1,3}(?:,\d{3})+)(?=\s|원|$)/g)]
    .map((match) => toNumber(match[1]))
    .filter((value) => value !== null);
  const discountMatch = text.match(/(\d{1,2})\s*%/);
  const soldOut = /SOLD\s*OUT|품절/i.test(text) ? true : false;
  const currentPrice = prices.length ? prices.at(-1) : null;
  const originalPrice = prices.length >= 2 ? prices[0] : null;
  const discountRate = discountMatch ? Number(discountMatch[1]) : calculateDiscountRate(originalPrice, currentPrice);

  return finalizeProduct({
    id,
    name: cleanText(raw?.name) || inferNameFromText(text, brandHint),
    brand: brandHint,
    originalPrice,
    currentPrice,
    discountRate,
    soldOut,
    stockQuantity: parsePublicStock(text),
    stockStatus: soldOut ? '품절' : '판매 가능',
    options: [],
    url: normalizeProductUrl(raw?.href, id),
    imageUrl: normalizeImageUrl(raw?.imageUrl),
    productCodes: extractCodesFromText(`${raw?.name || ''} ${text}`, id)
  }, brandHint);
}

export function extractDetailDom(raw, brandHint = null) {
  const id = normalizeProductId(raw?.id || raw?.url);
  if (!id) return null;
  const text = cleanText(raw?.text, 15000) || '';
  const prices = [...text.matchAll(/(?:^|\s)(\d{1,3}(?:,\d{3})+)(?=\s|원|$)/g)]
    .map((match) => toNumber(match[1]))
    .filter((value) => value !== null && value < 100_000_000);
  const discountMatch = text.match(/(\d{1,2})\s*%/);
  const currentPrice = prices.length ? prices.at(-1) : null;
  const originalPrice = prices.length >= 2 ? prices[0] : null;
  const options = uniqueBy((raw.options || []).map(normalizeDomOption).filter(Boolean), (option) => option.id);
  const explicitSoldOut = /SOLD\s*OUT|현재\s*품절|품절된\s*상품/i.test(text);
  const hasPurchase = /구매하기|바로구매|장바구니/i.test(text);
  const soldOut = explicitSoldOut ? true : (hasPurchase ? false : null);

  return finalizeProduct({
    id,
    name: cleanText(raw?.name) || null,
    brand: brandHint,
    originalPrice,
    currentPrice,
    discountRate: discountMatch ? Number(discountMatch[1]) : calculateDiscountRate(originalPrice, currentPrice),
    soldOut,
    stockQuantity: parsePublicStock(text),
    stockStatus: stockStatusText(soldOut, parsePublicStock(text)),
    options,
    url: normalizeProductUrl(raw?.url, id),
    imageUrl: normalizeImageUrl(raw?.imageUrl),
    productCodes: extractCodesFromText(`${raw?.name || ''} ${text}`, id)
  }, brandHint);
}

export function mergeTwoProducts(left, right) {
  if (!left) return right ? structuredClone(right) : null;
  if (!right) return structuredClone(left);
  if (left.id && right.id && left.id !== right.id) return structuredClone(right);

  const output = { ...left };
  for (const field of ['id', 'name', 'brand', 'originalPrice', 'currentPrice', 'discountRate', 'soldOut', 'stockQuantity', 'stockStatus', 'url', 'imageUrl']) {
    if (right[field] !== null && right[field] !== undefined && right[field] !== '') output[field] = right[field];
  }
  output.options = mergeOptions(left.options || [], right.options || []);
  output.productCodes = mergeCodes(left.productCodes || [], right.productCodes || [], output.name, output.id);
  return finalizeProduct(output, output.brand);
}

export function mergeProducts(products) {
  const map = new Map();
  for (const product of products.filter(Boolean)) {
    map.set(product.id, mergeTwoProducts(map.get(product.id), product));
  }
  return [...map.values()];
}

export function normalizeProductId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const urlMatch = text.match(/\/product\/([A-Za-z0-9_-]+)\/detail/i);
  const candidate = urlMatch?.[1] || text.trim();
  return /^G[A-Z][A-Za-z0-9_-]{8,}$/i.test(candidate) ? candidate : null;
}

export function normalizeProductUrl(value, id) {
  const productId = normalizeProductId(id || value);
  if (!productId) return null;
  return `https://www.eqlstore.com/product/${productId}/detail`;
}

export function finalizeProduct(product, brandHint = null) {
  if (!product?.id) return null;
  const originalPrice = toNumber(product.originalPrice);
  const currentPrice = toNumber(product.currentPrice);
  let discountRate = toNumber(product.discountRate);
  if (discountRate === null) discountRate = calculateDiscountRate(originalPrice, currentPrice);
  const soldOut = normalizeBoolean(product.soldOut);
  const stockQuantity = toNumber(product.stockQuantity);
  return {
    id: product.id,
    name: cleanText(product.name) || `EQL 상품 ${product.id}`,
    brand: cleanText(product.brand) || brandHint || 'EQL',
    originalPrice,
    currentPrice,
    discountRate,
    soldOut,
    stockQuantity,
    stockStatus: cleanText(product.stockStatus) || stockStatusText(soldOut, stockQuantity),
    options: uniqueBy((product.options || []).map(finalizeOption).filter(Boolean), (option) => option.id),
    url: normalizeProductUrl(product.url, product.id),
    imageUrl: normalizeImageUrl(product.imageUrl),
    productCodes: mergeCodes(product.productCodes || [], [], product.name, product.id)
  };
}


function extractProductCodes(node, name, id) {
  const values = [];
  for (const key of PRODUCT_CODE_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    collectCodeValue(values, node[key]);
  }
  for (const [key, value] of Object.entries(node)) {
    if (!/(?:style|model|article|part|product|goods|god|item|sku).*(?:code|cd|no|number)|(?:code|cd|no|number).*(?:style|model|article|part|product|goods|god|item|sku)/i.test(key)) continue;
    collectCodeValue(values, value);
  }
  values.push(...extractCodesFromText(name || '', id));
  return mergeCodes(values, [], name, id);
}

function collectCodeValue(output, value) {
  if (Array.isArray(value)) {
    for (const item of value) collectCodeValue(output, item);
    return;
  }
  if (value && typeof value === 'object') return;
  const text = cleanText(value, 120);
  if (!text) return;
  for (const token of text.split(/[\s,|/]+/)) {
    const code = normalizeProductCode(token);
    if (code) output.push(code);
  }
}

function extractCodesFromText(text, id) {
  const source = String(text || '').toUpperCase();
  const matches = source.match(/[A-Z0-9]{2,}(?:[-_.][A-Z0-9]{2,})+(?:[-_.][A-Z0-9]{1,})?|[A-Z]{1,5}\d{4,}[A-Z0-9-]*/g) || [];
  return matches
    .map(normalizeProductCode)
    .filter(Boolean)
    .filter((code) => normalizeProductCode(code) !== normalizeProductCode(id));
}

function normalizeProductCode(value) {
  const text = cleanText(value, 120)?.toUpperCase().replace(/[–—]/g, '-').replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
  if (!text || text.length < 4 || text.length > 60) return null;
  const hasLetter = /[A-Z]/.test(text);
  const hasDigit = /\d/.test(text);
  const structuredNumericCode = /^\d{4,}(?:[-_.]\d{2,})+$/.test(text);
  if (!hasDigit || (!hasLetter && !structuredNumericCode)) return null;
  if (/^https?$|^WWW$|^EQL$/.test(text)) return null;
  if (/^G[A-Z][A-Z0-9_-]{8,}$/i.test(text)) return null;
  return text;
}

function mergeCodes(left, right, name, id) {
  const candidates = [...left, ...right, ...extractCodesFromText(name || '', id)];
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const code = normalizeProductCode(candidate);
    if (!code) continue;
    const key = code.replace(/[^A-Z0-9]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(code);
  }
  return output.slice(0, 20);
}

function extractOptionsFromObject(root) {
  const candidates = [];
  const visited = new Set();
  let count = 0;

  function walk(value, depth) {
    if (!value || typeof value !== 'object' || visited.has(value) || depth > 8 || count > 5000) return;
    visited.add(value);
    count += 1;
    if (!Array.isArray(value) && looksLikeOption(value)) {
      const option = optionFromObject(value);
      if (option) candidates.push(option);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  }
  walk(root, 0);
  return uniqueBy(candidates, (option) => option.id);
}

function looksLikeOption(node) {
  const keys = Object.keys(node);
  return keys.some((key) => OPTION_HINT_KEYS.includes(key)) &&
    keys.some((key) => STOCK_KEYS.includes(key) || SOLDOUT_KEYS.includes(key) || /stock|sold|avail|salePsb/i.test(key));
}

function optionFromObject(node) {
  const rawName = firstValue(node, ['itmNm', 'optionName', 'optionValue', 'size', 'sizeCd', 'name', 'displayName']);
  const rawId = firstValue(node, ['itmNo', 'skuNo', 'optionNo', 'optionId', 'sizeCd', 'size']) || rawName;
  const name = cleanText(rawName);
  const id = cleanText(rawId);
  if (!id || !name) return null;
  const stockQuantity = toNumber(firstValue(node, STOCK_KEYS));
  const soldOut = soldOutFromObject(node);
  return finalizeOption({ id, name, stockQuantity, soldOut });
}

function normalizeDomOption(raw) {
  const text = cleanText(raw?.text, 300);
  if (!text || /구매하기|장바구니|선택하세요|옵션 선택/i.test(text)) return null;
  const name = text
    .replace(/SOLD\s*OUT|품절\s*임박\s*\(?\d*\)?|품절|재입고\s*알림\s*신청/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 80) return null;
  const soldOut = /SOLD\s*OUT|품절|재입고\s*알림/i.test(text);
  const stockQuantity = parsePublicStock(text);
  return finalizeOption({ id: name, name, soldOut, stockQuantity });
}

function finalizeOption(option) {
  const id = cleanText(option?.id || option?.name);
  const name = cleanText(option?.name || option?.id);
  if (!id || !name) return null;
  const soldOut = normalizeBoolean(option.soldOut);
  const stockQuantity = toNumber(option.stockQuantity);
  return {
    id,
    name,
    soldOut,
    stockQuantity,
    stockStatus: stockStatusText(soldOut, stockQuantity)
  };
}

function mergeOptions(left, right) {
  const map = new Map();
  for (const option of left) map.set(option.id, option);
  for (const option of right) map.set(option.id, { ...(map.get(option.id) || {}), ...option });
  return [...map.values()].map(finalizeOption).filter(Boolean);
}

function firstValue(node, keys) {
  for (const key of keys) {
    if (Object.hasOwn(node, key) && node[key] !== null && node[key] !== undefined && node[key] !== '') return node[key];
  }
  return null;
}

function findProductIdInObject(node) {
  for (const value of Object.values(node)) {
    if (typeof value !== 'string') continue;
    const id = normalizeProductId(value);
    if (id) return id;
  }
  return null;
}

function soldOutFromObject(node) {
  for (const key of SOLDOUT_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    if (/stockYn|salePsbYn|availableYn/i.test(key)) {
      const available = normalizeBoolean(value);
      return available === null ? null : !available;
    }
    const result = normalizeBoolean(value);
    if (result !== null) return result;
  }
  for (const [key, value] of Object.entries(node)) {
    if (!/saleStat|sellStat|stockStat|godSaleSect|soldOutStatus/i.test(key)) continue;
    const text = String(value).toUpperCase();
    if (/SOLD|OUT|STOP|품절|SOLD_OUT/.test(text)) return true;
    if (/SALE|SELL|AVAILABLE|NORMAL|판매/.test(text)) return false;
  }
  return null;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  if (['Y', 'YES', 'TRUE', 'SOLD_OUT', 'SOLDOUT', 'OUT_OF_STOCK'].includes(text)) return true;
  if (['N', 'NO', 'FALSE', 'AVAILABLE', 'IN_STOCK'].includes(text)) return false;
  return null;
}

function stockStatusText(soldOut, stockQuantity) {
  if (soldOut === true) return '품절';
  if (stockQuantity !== null && stockQuantity !== undefined) return `${Math.max(0, Math.trunc(stockQuantity))}개`;
  if (soldOut === false) return '판매 가능';
  return '확인 불가';
}

function parsePublicStock(text) {
  const match = String(text || '').match(/(?:품절\s*임박|재고|남은\s*수량)\s*[:：]?\s*\(?\s*(\d+)\s*\)?/i);
  return match ? Number(match[1]) : null;
}

function normalizeImageUrl(value) {
  if (typeof value === 'object' && value) value = value.url || value.src || value.path;
  const text = cleanText(value, 2000);
  if (!text) return null;
  try {
    if (text.startsWith('//')) return `https:${text}`;
    return new URL(text, 'https://www.eqlstore.com').href;
  } catch {
    return null;
  }
}

function inferNameFromText(text, brandHint) {
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const filtered = lines.filter((line) => {
    if (/^(NEW|COUPON|SOLD\s*OUT|품절)$/i.test(line)) return false;
    if (/^\d{1,3}(?:,\d{3})+(?:원)?$/.test(line)) return false;
    if (/^\d{1,2}%$/.test(line)) return false;
    if (brandHint && line.toUpperCase() === String(brandHint).toUpperCase()) return false;
    return line.length >= 3;
  });
  return cleanText(filtered.sort((a, b) => b.length - a.length)[0]);
}
