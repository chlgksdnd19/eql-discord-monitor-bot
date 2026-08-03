export function searchProducts(state, rawQuery, limit = 5) {
  const query = clean(rawQuery);
  const queryKey = compact(query);
  if (!queryKey) return [];

  const products = Object.values(state?.products || {}).filter(Boolean);
  return products
    .map((product) => ({ product, score: scoreProduct(product, query, queryKey) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || recentValue(right.product) - recentValue(left.product))
    .slice(0, limit)
    .map((entry) => entry.product);
}

export function productToEmbed(product, state) {
  const codes = visibleCodes(product);
  const fields = [
    { name: '브랜드', value: safe(product.brand || 'EQL'), inline: true },
    { name: '품번', value: safe(codes.length ? codes.join(' / ') : product.id || '확인 불가'), inline: true },
    { name: '금액', value: formatPriceBlock(product), inline: true },
    { name: '재고', value: formatStock(product), inline: false },
    { name: '상품 URL', value: safe(product.url || '확인 불가'), inline: false },
    { name: '데이터 확인 시간', value: formatKoreanTime(state?.lastCheckedAt || product.detailCheckedAt || product.lastChangedAt), inline: false }
  ];

  return {
    title: safe(product.name || `EQL 상품 ${product.id}`, 256),
    url: product.url || undefined,
    color: product.soldOut === true ? 0xe74c3c : 0x2ecc71,
    thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
    fields,
    footer: { text: footerText(product) }
  };
}

export function normalizeQuery(value) {
  return compact(clean(value));
}

function scoreProduct(product, query, queryKey) {
  const id = clean(product.id);
  const idKey = compact(id);
  if (queryKey === idKey) return 1000;

  const codes = [...(product.productCodes || []), ...(product.codes || [])]
    .map(clean)
    .filter(Boolean);
  for (const code of codes) {
    const codeKey = compact(code);
    if (queryKey === codeKey) return 950;
    if (codeKey.startsWith(queryKey) || queryKey.startsWith(codeKey)) return 820;
    if (codeKey.includes(queryKey)) return 760;
  }

  const name = clean(product.name);
  const nameKey = compact(name);
  if (nameKey === queryKey) return 700;
  if (nameKey.includes(queryKey)) return 600;
  if (query.length >= 3 && name.toUpperCase().includes(query.toUpperCase())) return 550;
  if (idKey.includes(queryKey)) return 500;
  return 0;
}

function visibleCodes(product) {
  return [...new Set([...(product.productCodes || []), ...(product.codes || [])].filter(Boolean))].slice(0, 5);
}

function formatPriceBlock(product) {
  const lines = [];
  if (isNumber(product.originalPrice) && Number(product.originalPrice) !== Number(product.currentPrice)) {
    lines.push(`정상가: ${won(product.originalPrice)}`);
  }
  lines.push(`판매가: ${won(product.currentPrice)}`);
  if (isNumber(product.discountRate)) lines.push(`할인율: ${Math.round(Number(product.discountRate))}%`);
  return lines.join('\n');
}

function formatStock(product) {
  const lines = [];
  const live = product.liveStock;

  if (live?.ok) {
    if (product.stockQuantityExact === true && isNumber(product.stockQuantity)) {
      lines.push(`실시간 전체 공개 재고: ${Math.max(0, Math.trunc(Number(product.stockQuantity))).toLocaleString('ko-KR')}개`);
    } else if (isNumber(product.stockMinimumQuantity)) {
      lines.push(`실시간 공개 최소 재고: ${Math.max(0, Math.trunc(Number(product.stockMinimumQuantity))).toLocaleString('ko-KR')}개 이상`);
    } else if (product.soldOut === true) {
      lines.push('실시간 전체 상태: 품절');
    }
  } else if (isNumber(product.stockQuantity)) {
    lines.push(`저장된 전체 공개 재고: ${Math.max(0, Math.trunc(Number(product.stockQuantity))).toLocaleString('ko-KR')}개`);
  } else if (product.soldOut === true) {
    lines.push('저장된 전체 상태: 품절');
  } else if (product.soldOut === false) {
    lines.push('저장된 전체 상태: 판매 가능');
  } else {
    lines.push(`저장된 전체 상태: ${product.stockStatus || '확인 불가'}`);
  }

  const options = (product.options || []).slice(0, 25);
  if (options.length) {
    lines.push('', live?.ok ? '실시간 옵션별 재고' : '저장된 옵션별 상태');
    for (const option of options) {
      let status = option.stockStatus || '확인 불가';
      if (option.soldOut === true) status = '품절';
      else if (isNumber(option.stockQuantity)) status = `${Math.max(0, Math.trunc(Number(option.stockQuantity)))}개`;
      else if (isNumber(option.minimumQuantity)) status = `${Math.max(0, Math.trunc(Number(option.minimumQuantity)))}개 이상`;
      else if (option.soldOut === false) status = '판매 가능';
      lines.push(`${option.name}: ${status}`);
    }
  }

  if (live?.ok && product.stockQuantityExact !== true) {
    lines.push('', '※ EQL 공개 화면은 품절 임박 수량만 숫자로 표시합니다. 숫자가 없는 판매 가능 옵션은 6개 이상으로 표기합니다.');
  } else if (live?.ok !== true && live?.error) {
    lines.push('', `⚠️ 실시간 재고 확인 실패: ${live.error}`);
  }
  return safe(lines.join('\n'), 1024);
}

function footerText(product) {
  if (product.liveStock?.ok) return 'EQL 상품 페이지를 방금 조회한 공개 재고입니다.';
  if (product.liveStock?.error) return '실시간 조회에 실패해 마지막 모니터링 정보를 표시합니다.';
  return 'EQL 모니터가 마지막으로 저장한 공개 정보를 표시합니다.';
}

function formatKoreanTime(value) {
  if (!value) return '확인 불가';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safe(String(value));
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function won(value) {
  return isNumber(value) ? `${Math.round(Number(value)).toLocaleString('ko-KR')}원` : '확인 불가';
}

function isNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function compact(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9가-힣]/g, '');
}

function safe(value, limit = 1024) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function recentValue(product) {
  const value = new Date(product.detailCheckedAt || product.lastChangedAt || product.firstSeenAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}
