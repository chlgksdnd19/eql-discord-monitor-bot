import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export const paths = {
  root: rootDir,
  config: path.join(rootDir, 'config.json'),
  state: path.join(rootDir, 'data', 'state.json'),
  debug: path.join(rootDir, 'debug'),
  out: path.join(rootDir, 'out')
};

export function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  let brands = Array.isArray(raw.brands) ? raw.brands.map(normalizeBrand).filter(Boolean) : [];
  if (!brands.length) throw new Error('config.json의 brands 배열에 EQL 브랜드를 한 개 이상 등록해야 합니다.');

  const collectorBrandCode = String(process.env.BRAND_CODE || '').trim();
  if (collectorBrandCode) {
    brands = brands.filter((brand) => brand.code === collectorBrandCode);
    if (brands.length !== 1) throw new Error(`BRAND_CODE와 일치하는 브랜드가 없습니다: ${collectorBrandCode}`);
  }

  return {
    ...raw,
    brands,
    allBrandCount: Array.isArray(raw.brands) ? raw.brands.length : brands.length,
    maxPagesPerBrand: clampNumber(raw.maxPagesPerBrand, 1, 5, 1),
    maxProductsPerBrand: clampNumber(raw.maxProductsPerBrand, 20, 500, 160),
    pageWaitMs: clampNumber(raw.pageWaitMs, 600, 15000, 2200),
    requestDelayMs: clampNumber(raw.requestDelayMs, 0, 10000, 900),
    brandRetryCount: clampNumber(raw.brandRetryCount, 1, 3, 2),
    brandRetryDelayMs: clampNumber(raw.brandRetryDelayMs, 1000, 60000, 8000),
    detailChecksPerRun: clampNumber(raw.detailChecksPerRun, 0, 5, 1),
    detailProductUrls: Array.isArray(raw.detailProductUrls) ? raw.detailProductUrls.filter(isEqlProductUrl) : [],
    loadMoreClicksPerBrand: clampNumber(raw.loadMoreClicksPerBrand, 0, 40, 14),
    notifyOnBaseline: raw.notifyOnBaseline === true,
    notifyOnErrors: raw.notifyOnErrors === true,
    errorAlertAfterFailures: clampNumber(raw.errorAlertAfterFailures, 1, 20, 3),
    timezone: raw.timezone || 'Asia/Seoul',
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    runMode: process.env.RUN_MODE || 'monitor',
    collectorBrandCode,
    startDelaySeconds: clampNumber(process.env.START_DELAY_SECONDS, 0, 240, 0),
    resultsDir: path.resolve(process.env.RESULTS_DIR || paths.out)
  };
}

function normalizeBrand(value, index) {
  if (!value || typeof value !== 'object') return null;
  const code = String(value.code || extractBrandCode(value.url) || '').trim();
  if (!/^BD[A-Z0-9]{6,}$/i.test(code)) {
    throw new Error(`brands[${index}]의 브랜드 코드가 올바르지 않습니다: ${code || '비어 있음'}`);
  }

  const name = String(value.name || code).trim();
  const searchTerm = String(value.searchTerm || name).trim();
  const url = normalizeSearchUrl(value.url || buildSearchUrl(searchTerm), searchTerm, 'www.eqlstore.com');
  const mobileUrl = normalizeSearchUrl(value.mobileUrl || value.url || buildSearchUrl(searchTerm), searchTerm, 'm.eqlstore.com');
  const aliases = [name, searchTerm, ...(Array.isArray(value.aliases) ? value.aliases : [])]
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  return {
    name,
    code,
    searchTerm,
    url,
    mobileUrl,
    aliases: [...new Set(aliases)],
    matchKeys: [...new Set(aliases.map(compactText).filter(Boolean))],
    minimumProducts: clampNumber(value.minimumProducts, 1, 500, 10)
  };
}

function extractBrandCode(url) {
  try {
    return new URL(String(url)).searchParams.get('brndCategoryNumber');
  } catch {
    return null;
  }
}

function buildSearchUrl(searchTerm) {
  const url = new URL('https://www.eqlstore.com/public/search/view');
  url.searchParams.set('searchWord', searchTerm);
  url.searchParams.set('tabContent0', '');
  return url.href;
}

function normalizeSearchUrl(url, searchTerm, hostname) {
  const parsed = new URL(String(url), `https://${hostname}`);
  if (!/(^|\.)eqlstore\.com$/i.test(parsed.hostname)) {
    throw new Error(`EQL 주소만 사용할 수 있습니다: ${parsed.href}`);
  }
  parsed.protocol = 'https:';
  parsed.hostname = hostname;
  parsed.pathname = '/public/search/view';
  parsed.searchParams.set('searchWord', searchTerm);
  parsed.searchParams.set('tabContent0', '');
  parsed.searchParams.set('sort', 'NEW_GOD');
  parsed.searchParams.set('excludeSoldoutGodYn', 'N');
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

function compactText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^A-Z0-9가-힣]/g, '');
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
