import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export const paths = {
  root: rootDir,
  config: path.join(rootDir, 'config.json'),
  state: path.join(rootDir, 'data', 'state.json'),
  debug: path.join(rootDir, 'debug')
};

export function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const brands = Array.isArray(raw.brands) ? raw.brands.map(normalizeBrand).filter(Boolean) : [];
  if (!brands.length) throw new Error('config.json의 brands 배열에 EQL 브랜드를 한 개 이상 등록해야 합니다.');

  return {
    ...raw,
    brands,
    maxPagesPerBrand: clampNumber(raw.maxPagesPerBrand, 1, 50, 15),
    maxProductsPerBrand: clampNumber(raw.maxProductsPerBrand, 1, 2000, 500),
    pageWaitMs: clampNumber(raw.pageWaitMs, 600, 15000, 2600),
    requestDelayMs: clampNumber(raw.requestDelayMs, 0, 10000, 650),
    detailChecksPerRun: clampNumber(raw.detailChecksPerRun, 0, 100, 16),
    detailProductUrls: Array.isArray(raw.detailProductUrls) ? raw.detailProductUrls.filter(isEqlProductUrl) : [],
    notifyOnBaseline: raw.notifyOnBaseline === true,
    notifyOnErrors: raw.notifyOnErrors === true,
    errorAlertAfterFailures: clampNumber(raw.errorAlertAfterFailures, 1, 20, 3),
    timezone: raw.timezone || 'Asia/Seoul',
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    runMode: process.env.RUN_MODE || 'monitor'
  };
}

function normalizeBrand(value, index) {
  if (!value || typeof value !== 'object') return null;
  const code = String(value.code || extractBrandCode(value.url) || '').trim();
  if (!/^BD[A-Z0-9]{6,}$/i.test(code)) {
    throw new Error(`brands[${index}]의 브랜드 코드가 올바르지 않습니다: ${code || '비어 있음'}`);
  }
  const url = value.url || buildBrandUrl(code);
  return {
    name: String(value.name || code).trim(),
    code,
    url: normalizeBrandUrl(url, code)
  };
}

function extractBrandCode(url) {
  try {
    return new URL(String(url)).searchParams.get('brndCategoryNumber');
  } catch {
    return null;
  }
}

function buildBrandUrl(code) {
  return `https://www.eqlstore.com/display/productsList?brndCategoryNumber=${encodeURIComponent(code)}&selectCtgryNo=EQL&mallGubun=BRND&ctgryType=BRND&dspEqlOtltYn=Y&sort=MD_RECOMMEND_SEQ&page=1&exclusiveGodYn=N&dcGodYn=N&excludeSoldoutGodYn=N&preOrderGodYn=N`;
}

function normalizeBrandUrl(url, code) {
  const parsed = new URL(String(url), 'https://www.eqlstore.com');
  if (!/(^|\.)eqlstore\.com$/i.test(parsed.hostname)) {
    throw new Error(`EQL 주소만 사용할 수 있습니다: ${parsed.href}`);
  }
  parsed.protocol = 'https:';
  parsed.hostname = 'www.eqlstore.com';
  parsed.searchParams.set('brndCategoryNumber', code);
  parsed.searchParams.set('excludeSoldoutGodYn', 'N');
  if (!parsed.searchParams.has('page')) parsed.searchParams.set('page', '1');
  return parsed.href;
}

function isEqlProductUrl(value) {
  try {
    const parsed = new URL(String(value));
    return /(^|\.)eqlstore\.com$/i.test(parsed.hostname) && /\/product\/[A-Za-z0-9_-]+\/detail/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
