import { loadConfig, paths } from './src/config.js';
import { buildErrorPayload, buildTestPayload, sendProductEvents, sendWebhook } from './src/discord.js';
import { mergeTwoProducts } from './src/extractors.js';
import { scrapeEql } from './src/scraper.js';
import { errorToString, nowIso, readJson, writeJsonAtomic } from './src/utils.js';

const EMPTY_STATE = {
  version: 2,
  initialized: false,
  failureCount: 0,
  detailCursor: 0,
  products: {}
};

const config = loadConfig();
let state = readJson(paths.state, EMPTY_STATE);
state = { ...EMPTY_STATE, ...state, products: state.products || {} };

if (!config.webhookUrl && config.runMode !== 'inspect-api') {
  throw new Error('GitHub 저장소 Secret에 DISCORD_WEBHOOK_URL을 등록해야 합니다.');
}

if (config.runMode === 'test-webhook') {
  await sendWebhook(config.webhookUrl, buildTestPayload(config));
  console.log('Discord Webhook 테스트 메시지를 전송했습니다.');
  process.exit(0);
}

if (config.runMode === 'reset-baseline') {
  state = structuredClone(EMPTY_STATE);
  writeJsonAtomic(paths.state, state);
  console.log('기존 기준값을 초기화했습니다. 현재 상품 상태를 새 기준값으로 수집합니다.');
}

try {
  const result = await scrapeEql(config, state, paths.debug);
  if (config.runMode === 'inspect-api') {
    console.log(`API 점검 완료: JSON 응답 ${result.apiCount}개, 상품 ${result.products.length}개 추출`);
    process.exit(0);
  }

  const detectedAt = result.collectedAt || nowIso();
  const currentMap = new Map(result.products.map((product) => [product.id, product]));

  if (!state.initialized) {
    state.products = Object.fromEntries(result.products.map((product) => [product.id, storeProduct(product, detectedAt)]));
    state.lastCheckedAt = detectedAt;
    state.initialized = true;
    state.failureCount = 0;
    state.detailCursor = advanceCursor(state.detailCursor, result.products.length, config.detailChecksPerRun);
    writeJsonAtomic(paths.state, state);
    console.log(`EQL 기준값 저장 완료: ${result.products.length}개 상품. 디스코드 알림은 보내지 않았습니다.`);
    process.exit(0);
  }

  const events = [];
  const nextProducts = { ...state.products };

  for (const [id, currentRaw] of currentMap) {
    const previous = state.products[id] || null;
    const current = mergeForComparison(previous, currentRaw);
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
    current.lastChangedAt = comparison.types.length ? detectedAt : (previous.lastChangedAt || previous.firstSeenAt || detectedAt);
    nextProducts[id] = current;
    if (comparison.types.length) events.push({ ...comparison, product: current, detectedAt });
  }

  state.products = nextProducts;
  state.lastCheckedAt = detectedAt;
  state.failureCount = 0;
  state.detailCursor = advanceCursor(state.detailCursor, result.products.length, config.detailChecksPerRun);
  delete state.lastError;
  delete state.lastErrorAt;
  writeJsonAtomic(paths.state, state);

  if (events.length) {
    console.log(`${events.length}개 EQL 상품에서 변경을 감지했습니다.`);
    await sendProductEvents(config.webhookUrl, events, config);
  } else {
    console.log(`변경 없음: ${result.products.length}개 상품 확인 완료. 디스코드 전송 없음.`);
  }
} catch (error) {
  const message = errorToString(error);
  state.failureCount = (state.failureCount || 0) + 1;
  state.lastErrorAt = nowIso();
  state.lastError = message;
  writeJsonAtomic(paths.state, state);

  if (config.notifyOnErrors && state.failureCount === config.errorAlertAfterFailures) {
    try {
      await sendWebhook(config.webhookUrl, buildErrorPayload(config, state.failureCount, message));
    } catch (webhookError) {
      console.error('오류 알림 전송 실패:', errorToString(webhookError));
    }
  }
  console.error(message);
  process.exitCode = 1;
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

function advanceCursor(cursor, productCount, checksPerRun) {
  if (!productCount || !checksPerRun) return 0;
  return (Math.max(0, Number(cursor || 0)) + checksPerRun) % productCount;
}
