import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths } from './src/config.js';
import { buildTestPayload, sendProductEvents, sendWebhook } from './src/discord.js';
import { mergeProducts, mergeTwoProducts } from './src/extractors.js';
import { errorToString, nowIso, readJson, writeJsonAtomic } from './src/utils.js';

const EMPTY_STATE = {
  version: 3,
  initialized: false,
  lastCheckedAt: null,
  products: {},
  brands: {}
};

const config = loadConfig();
console.log(`실행 모드: ${config.runMode}`);

if (!config.webhookUrl && config.runMode !== 'inspect-api') {
  throw new Error('GitHub 저장소 Secret에 DISCORD_WEBHOOK_URL을 등록해야 합니다.');
}

if (config.runMode === 'test-webhook') {
  await sendWebhook(config.webhookUrl, buildTestPayload(config));
  console.log('Discord Webhook 테스트 메시지를 전송했습니다.');
  process.exit(0);
}

let state = normalizeState(readJson(paths.state, EMPTY_STATE));
const results = loadCollectorResults(config);
printResultSummary(results);

if (config.runMode === 'inspect-api') {
  const failed = results.filter((result) => !result.ok);
  const productCount = results.filter((result) => result.ok).reduce((sum, result) => sum + result.products.length, 0);
  console.log(`병렬 점검 완료: 성공 ${results.length - failed.length}/${results.length}개 브랜드, 상품 ${productCount}개`);
  if (failed.length) {
    console.error(`점검 실패 브랜드: ${failed.map((result) => `${result.brand.name} (${result.error || '결과 없음'})`).join(', ')}`);
    process.exitCode = 1;
  }
  process.exit();
}

if (config.runMode === 'reset-baseline') {
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    throw new Error(`기준값 저장을 중단했습니다. 수집 실패 브랜드: ${failed.map((result) => result.brand.name).join(', ')}`);
  }
  state = createBaseline(results);
  writeJsonAtomic(paths.state, state);
  console.log(`EQL 기준값 저장 완료: ${Object.keys(state.products).length}개 상품. 디스코드 상품 알림은 보내지 않았습니다.`);
  process.exit(0);
}

if (!state.initialized) {
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    throw new Error(`최초 기준값 저장을 보류했습니다. 수집 실패 브랜드: ${failed.map((result) => result.brand.name).join(', ')}`);
  }
  state = createBaseline(results);
  writeJsonAtomic(paths.state, state);
  console.log(`최초 기준값 저장 완료: ${Object.keys(state.products).length}개 상품. 다음 확인부터 변동만 알립니다.`);
  process.exit(0);
}

try {
  const events = [];
  const nextProducts = { ...state.products };
  let latestCheckedAt = state.lastCheckedAt || null;

  for (const result of results) {
    const brandCode = result.brand.code;
    const previousHealth = state.brands[brandCode] || createBrandHealth(result.brand);

    if (!result.ok) {
      state.brands[brandCode] = {
        ...previousHealth,
        name: result.brand.name,
        code: brandCode,
        failureCount: Number(previousHealth.failureCount || 0) + 1,
        lastError: result.error || '수집 결과 파일 없음',
        lastErrorAt: nowIso()
      };
      console.warn(`${result.brand.name}: 수집 실패로 기존 저장값 유지`);
      continue;
    }

    const detectedAt = result.collectedAt || nowIso();
    if (!latestCheckedAt || new Date(detectedAt) > new Date(latestCheckedAt)) latestCheckedAt = detectedAt;
    state.brands[brandCode] = {
      ...previousHealth,
      name: result.brand.name,
      code: brandCode,
      failureCount: 0,
      detailCursor: Math.max(0, Number(result.nextDetailCursor || 0)),
      lastCheckedAt: detectedAt,
      productCount: result.products.length,
      lastError: null,
      lastErrorAt: null
    };

    for (const currentRaw of result.products) {
      const id = currentRaw.id;
      if (!id) continue;
      const previous = state.products[id] || null;
      const current = mergeForComparison(previous, currentRaw);
      current.brandCode = brandCode;
      current.firstSeenAt = previous?.firstSeenAt || detectedAt;

      if (!previous) {
        current.lastChangedAt = detectedAt;
        nextProducts[id] = current;
        events.push({
          types: ['new'],
          product: current,
          changes: ['🆕 선택한 브랜드에 새 상품이 등록되었습니다.'],
          detectedAt
        });
        continue;
      }

      const comparison = compareProduct(previous, current);
      current.lastChangedAt = comparison.types.length
        ? detectedAt
        : (previous.lastChangedAt || previous.firstSeenAt || detectedAt);
      nextProducts[id] = current;
      if (comparison.types.length) events.push({ ...comparison, product: current, detectedAt });
    }
  }

  state.version = 3;
  state.products = nextProducts;
  state.lastCheckedAt = latestCheckedAt || nowIso();
  writeJsonAtomic(paths.state, state);

  if (events.length) {
    console.log(`${events.length}개 EQL 상품에서 변경을 감지했습니다.`);
    await sendProductEvents(config.webhookUrl, events, config);
  } else {
    const successCount = results.filter((result) => result.ok).length;
    console.log(`변경 없음: ${successCount}/${results.length}개 브랜드 확인. 디스코드 전송 없음.`);
  }
} catch (error) {
  console.error(errorToString(error));
  process.exitCode = 1;
}

function loadCollectorResults(config) {
  const results = [];
  for (const brand of config.brands) {
    const file = path.join(config.resultsDir, `${brand.code}.json`);
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = null;
    }
    results.push(normalizeResult(raw, brand));
  }
  return results;
}

function normalizeResult(raw, brand) {
  if (!raw || typeof raw !== 'object') {
    return {
      brand: { name: brand.name, code: brand.code },
      ok: false,
      products: [],
      error: 'collector 결과 파일이 없습니다.',
      collectedAt: null,
      nextDetailCursor: 0,
      detailTargetCount: 0
    };
  }
  return {
    ...raw,
    brand: {
      name: raw.brand?.name || brand.name,
      code: raw.brand?.code || brand.code
    },
    ok: raw.ok === true,
    products: Array.isArray(raw.products) ? mergeProducts(raw.products) : [],
    error: raw.error ? String(raw.error) : null,
    collectedAt: raw.collectedAt || null,
    nextDetailCursor: Math.max(0, Number(raw.nextDetailCursor || 0)),
    detailTargetCount: Math.max(0, Number(raw.detailTargetCount || 0))
  };
}

function printResultSummary(results) {
  for (const result of results) {
    if (result.ok) {
      console.log(`${result.brand.name}: 상품 ${result.products.length}개, 상세 ${result.detailTargetCount}개, 성공`);
    } else {
      console.warn(`${result.brand.name}: 수집 보류 - ${result.error || '알 수 없는 오류'}`);
    }
  }
}

function createBaseline(results) {
  const detectedAt = results
    .map((result) => result.collectedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || nowIso();
  const products = {};
  const brands = {};

  for (const result of results) {
    brands[result.brand.code] = {
      name: result.brand.name,
      code: result.brand.code,
      failureCount: 0,
      detailCursor: Math.max(0, Number(result.nextDetailCursor || 0)),
      lastCheckedAt: result.collectedAt || detectedAt,
      productCount: result.products.length,
      lastError: null,
      lastErrorAt: null
    };
    for (const product of result.products) {
      if (!product?.id) continue;
      products[product.id] = storeProduct({ ...product, brandCode: result.brand.code }, result.collectedAt || detectedAt);
    }
  }

  return {
    version: 3,
    initialized: true,
    lastCheckedAt: detectedAt,
    products,
    brands
  };
}

function normalizeState(value) {
  const state = value && typeof value === 'object' ? structuredClone(value) : structuredClone(EMPTY_STATE);
  state.version = 3;
  state.initialized = state.initialized === true;
  state.products = state.products && typeof state.products === 'object' ? state.products : {};
  state.brands = state.brands && typeof state.brands === 'object' ? state.brands : {};
  return state;
}

function createBrandHealth(brand) {
  return {
    name: brand.name,
    code: brand.code,
    failureCount: 0,
    detailCursor: 0,
    productCount: 0,
    lastCheckedAt: null,
    lastError: null,
    lastErrorAt: null
  };
}

function storeProduct(product, detectedAt) {
  return {
    ...product,
    firstSeenAt: detectedAt,
    lastChangedAt: detectedAt,
    detailCheckedAt: product.detailCheckedAt || null
  };
}

function mergeForComparison(previous, currentRaw) {
  const merged = mergeTwoProducts(previous, currentRaw) || currentRaw;
  for (const field of ['stockQuantity', 'discountRate', 'originalPrice', 'currentPrice', 'imageUrl']) {
    if (currentRaw[field] === null || currentRaw[field] === undefined) merged[field] = previous?.[field] ?? null;
  }
  if (currentRaw.soldOut === null || currentRaw.soldOut === undefined) {
    merged.soldOut = previous?.soldOut ?? null;
    merged.stockStatus = previous?.stockStatus || currentRaw.stockStatus || '확인 불가';
  }
  if (!currentRaw.options?.length) merged.options = previous?.options || [];
  merged.detailCheckedAt = currentRaw.detailCheckedAt || previous?.detailCheckedAt || null;
  return merged;
}

function compareProduct(previous, current) {
  const types = [];
  const changes = [];

  if (previous.soldOut === true && current.soldOut === false) {
    types.push('restock');
    changes.push('🟢 전체 재고: 품절 → 판매 가능');
  } else if (previous.soldOut === false && current.soldOut === true) {
    types.push('soldout');
    changes.push('🔴 전체 재고: 판매 가능 → 품절');
  }

  if (bothNumbers(previous.stockQuantity, current.stockQuantity) && Number(previous.stockQuantity) !== Number(current.stockQuantity)) {
    types.push(Number(previous.stockQuantity) === 0 && Number(current.stockQuantity) > 0 ? 'restock' : 'stock');
    changes.push(`📦 전체 공개 재고: ${formatQuantity(previous.stockQuantity)} → ${formatQuantity(current.stockQuantity)}`);
  }

  compareOptions(previous.options || [], current.options || [], types, changes);

  if (changedNumber(previous.currentPrice, current.currentPrice)) {
    types.push('price');
    changes.push(`💰 판매가: ${formatPrice(previous.currentPrice)} → ${formatPrice(current.currentPrice)}`);
  }
  if (changedNumber(previous.originalPrice, current.originalPrice)) {
    types.push('price');
    changes.push(`💳 정상가: ${formatPrice(previous.originalPrice)} → ${formatPrice(current.originalPrice)}`);
  }
  if (changedNumber(previous.discountRate, current.discountRate)) {
    types.push('price');
    changes.push(`🏷️ 할인율: ${formatRate(previous.discountRate)} → ${formatRate(current.discountRate)}`);
  }

  return { types: [...new Set(types)], changes };
}

function compareOptions(previousOptions, currentOptions, types, changes) {
  if (!currentOptions.length) return;
  const previousMap = new Map(previousOptions.map((option) => [option.id, option]));
  for (const current of currentOptions) {
    const previous = previousMap.get(current.id);
    if (!previous) continue;
    if (previous.soldOut === true && current.soldOut === false) {
      types.push('restock');
      changes.push(`🟢 ${current.name}: 품절 → 판매 가능`);
    } else if (previous.soldOut === false && current.soldOut === true) {
      types.push('soldout');
      changes.push(`🔴 ${current.name}: 판매 가능 → 품절`);
    }
    if (bothNumbers(previous.stockQuantity, current.stockQuantity) && Number(previous.stockQuantity) !== Number(current.stockQuantity)) {
      types.push(Number(previous.stockQuantity) === 0 && Number(current.stockQuantity) > 0 ? 'restock' : 'stock');
      changes.push(`📦 ${current.name}: ${formatQuantity(previous.stockQuantity)} → ${formatQuantity(current.stockQuantity)}`);
    }
  }
}

function bothNumbers(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined && Number.isFinite(Number(left)) && Number.isFinite(Number(right));
}

function changedNumber(left, right) {
  return bothNumbers(left, right) && Number(left) !== Number(right);
}

function formatQuantity(value) {
  return `${Math.max(0, Math.trunc(Number(value))).toLocaleString('ko-KR')}개`;
}

function formatPrice(value) {
  return value === null || value === undefined ? '확인 불가' : `${Math.round(Number(value)).toLocaleString('ko-KR')}원`;
}

function formatRate(value) {
  return value === null || value === undefined ? '확인 불가' : `${Math.round(Number(value))}%`;
}
