import { chunk, formatKoreanTime, formatPercent, formatWon, sleep } from './utils.js';

const COLORS = {
  new: 0x3498db,
  restock: 0x2ecc71,
  soldout: 0xe74c3c,
  stock: 0xe67e22,
  price: 0xf1c40f,
  test: 0x9b59b6,
  error: 0xe74c3c
};

export async function sendWebhook(webhookUrl, payload) {
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL GitHub Secret가 설정되지 않았습니다.');
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord Webhook 전송 실패 (${response.status}): ${body.slice(0, 300)}`);
  }
}

export async function sendProductEvents(webhookUrl, events, config) {
  for (const group of chunk(events, 10)) {
    await sendWebhook(webhookUrl, {
      username: 'EQL 브랜드 모니터',
      allowed_mentions: { parse: [] },
      embeds: group.map((event) => buildProductEmbed(event, config))
    });
    await sleep(700);
  }
}

export function buildTestPayload(config) {
  const brands = config.brands.map((brand) => `${brand.name} (${brand.code})`).join('\n');
  return {
    username: 'EQL 브랜드 모니터',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '✅ EQL 웹훅 연결 테스트 성공',
      color: COLORS.test,
      description: '이 메시지는 수동 연결 테스트입니다. 예약 실행에서는 상품 변동이 있을 때만 알림을 보냅니다.',
      fields: [{ name: '선택 브랜드', value: brands || '없음' }],
      timestamp: new Date().toISOString()
    }]
  };
}

export function buildErrorPayload(config, failures, message) {
  return {
    username: 'EQL 브랜드 모니터',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '⚠️ EQL 모니터 확인 실패',
      color: COLORS.error,
      description: `${failures}회 연속으로 확인하지 못했습니다.`,
      fields: [{ name: '오류', value: String(message).slice(0, 900) }],
      timestamp: new Date().toISOString()
    }]
  };
}

function buildProductEmbed(event, config) {
  const { product, detectedAt, changes, types } = event;
  const primary = choosePrimaryType(types);
  const priceLines = [];
  if (product.originalPrice !== null && product.originalPrice !== undefined && product.originalPrice !== product.currentPrice) {
    priceLines.push(`정상가: ${formatWon(product.originalPrice)}`);
  }
  priceLines.push(`판매가: ${formatWon(product.currentPrice)}`);
  if (product.discountRate !== null && product.discountRate !== undefined) {
    priceLines.push(`할인율: ${formatPercent(product.discountRate)}`);
  }

  const fields = [
    { name: '브랜드', value: product.brand || 'EQL', inline: true },
    { name: '품번', value: formatProductCodes(product), inline: true },
    { name: '금액', value: priceLines.join('\n'), inline: true },
    { name: '재고', value: buildStockSummary(product), inline: false },
    { name: '변경 내용', value: changes.join('\n').slice(0, 1024), inline: false },
    { name: '상품 URL', value: product.url || '확인 불가', inline: false },
    { name: '확인 시간', value: formatKoreanTime(detectedAt, config.timezone), inline: false }
  ];

  return {
    title: `${iconFor(primary)} ${titleFor(primary)} · ${product.name}`.slice(0, 256),
    url: product.url || undefined,
    color: COLORS[primary] || COLORS.stock,
    thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
    fields,
    footer: { text: '변동이 있을 때만 전송됩니다.' },
    timestamp: detectedAt
  };
}


function formatProductCodes(product) {
  const codes = (product.productCodes || []).filter(Boolean);
  if (codes.length) return codes.slice(0, 5).join(' / ');
  return product.id || '확인 불가';
}

function buildStockSummary(product) {
  const lines = [];
  if (product.stockQuantity !== null && product.stockQuantity !== undefined) {
    lines.push(`전체 공개 재고: ${Math.max(0, Math.trunc(product.stockQuantity)).toLocaleString('ko-KR')}개`);
  } else {
    lines.push(`전체 상태: ${product.soldOut === true ? '품절' : product.soldOut === false ? '판매 가능' : product.stockStatus || '확인 불가'}`);
  }

  const options = (product.options || []).slice(0, 30);
  if (options.length) {
    lines.push('', '옵션별 상태');
    for (const option of options) {
      const status = option.stockQuantity !== null && option.stockQuantity !== undefined
        ? `${Math.max(0, Math.trunc(option.stockQuantity))}개`
        : option.soldOut === true ? '품절' : option.soldOut === false ? '판매 가능' : option.stockStatus || '확인 불가';
      lines.push(`${option.name}: ${status}`);
    }
  }
  const result = lines.join('\n');
  return result.length > 1024 ? `${result.slice(0, 1000)}\n…` : result;
}

function choosePrimaryType(types) {
  for (const type of ['new', 'restock', 'soldout', 'stock', 'price']) {
    if (types.includes(type)) return type;
  }
  return 'stock';
}

function iconFor(type) {
  return ({ new: '🆕', restock: '🟢', soldout: '🔴', stock: '📦', price: '💰' })[type] || '📦';
}

function titleFor(type) {
  return ({
    new: 'EQL 새 상품 등록',
    restock: 'EQL 재입고',
    soldout: 'EQL 품절 상태 변경',
    stock: 'EQL 재고 변경',
    price: 'EQL 금액 변경'
  })[type] || 'EQL 상품 변경';
}
