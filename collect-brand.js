import path from 'node:path';
import { loadConfig, paths } from './src/config.js';
import { scrapeEql } from './src/scraper.js';
import { ensureDir, errorToString, nowIso, readJson, sleep, writeJsonAtomic } from './src/utils.js';

const EMPTY_STATE = {
  version: 3,
  initialized: false,
  products: {},
  brands: {}
};

const config = loadConfig();
if (config.brands.length !== 1) {
  throw new Error('collect-brand.js는 BRAND_CODE로 선택된 브랜드 한 개만 처리해야 합니다.');
}

const brand = config.brands[0];
const outputFile = path.join(paths.out, `${brand.code}.json`);
const debugDir = path.join(paths.debug, brand.code);
ensureDir(paths.out);
ensureDir(debugDir);

if (config.startDelaySeconds > 0) {
  console.log(`${brand.name} 시작 전 ${config.startDelaySeconds}초 대기`);
  await sleep(config.startDelaySeconds * 1000);
}

const rawState = readJson(paths.state, EMPTY_STATE);
const state = normalizeState(rawState);
const brandState = state.brands[brand.code] || {};
const stateForScraper = {
  ...state,
  detailCursor: Math.max(0, Number(brandState.detailCursor || 0))
};

const output = {
  version: 1,
  runMode: config.runMode,
  brand: {
    name: brand.name,
    code: brand.code,
    minimumProducts: brand.minimumProducts
  },
  ok: false,
  products: [],
  collectedAt: nowIso(),
  detailTargetCount: 0,
  nextDetailCursor: stateForScraper.detailCursor,
  apiCount: 0,
  error: null
};

try {
  const result = await scrapeEql(config, stateForScraper, debugDir);
  const failed = result.failedBrands || [];
  output.products = result.products || [];
  output.collectedAt = result.collectedAt || nowIso();
  output.detailTargetCount = Number(result.detailTargetCount || 0);
  output.apiCount = Number(result.apiCount || 0);
  output.nextDetailCursor = advanceCursor(
    stateForScraper.detailCursor,
    output.products.length,
    config.runMode === 'monitor' && state.initialized ? Math.max(1, output.detailTargetCount || config.detailChecksPerRun) : 0
  );

  if (failed.length) {
    output.error = failed.map((item) => item.message).join(' / ');
  } else if (output.products.length < brand.minimumProducts) {
    output.error = `상품 ${output.products.length}개: 안전 기준 ${brand.minimumProducts}개 미달`;
  } else {
    output.ok = true;
  }
} catch (error) {
  output.error = errorToString(error);
}

writeJsonAtomic(outputFile, output);

if (output.ok) {
  console.log(`${brand.name} 수집 성공: 상품 ${output.products.length}개, 상세 ${output.detailTargetCount}개`);
} else {
  console.warn(`${brand.name} 수집 보류: ${output.error || '알 수 없는 오류'}`);
}

// 결과는 항상 artifact로 전달해야 하므로 일시적인 EQL 오류만으로 이 matrix job을 실패시키지 않습니다.
process.exit(0);

function normalizeState(value) {
  const state = value && typeof value === 'object' ? structuredClone(value) : structuredClone(EMPTY_STATE);
  state.version = 3;
  state.initialized = state.initialized === true;
  state.products = state.products && typeof state.products === 'object' ? state.products : {};
  state.brands = state.brands && typeof state.brands === 'object' ? state.brands : {};
  return state;
}

function advanceCursor(cursor, productCount, steps) {
  if (!productCount || !steps) return Math.max(0, Number(cursor || 0));
  return (Math.max(0, Number(cursor || 0)) + Math.max(0, Number(steps || 0))) % productCount;
}
