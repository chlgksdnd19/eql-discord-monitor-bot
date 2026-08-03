const DEFAULT_MIN_AVAILABLE = 6;

export async function fetchLiveStock(product, fetchImpl = fetch) {
  const urls = liveUrls(product?.url);
  let lastError = '상품 URL이 없습니다.';

  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'ko-KR,ko;q=0.9,en;q=0.7',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        },
        cache: 'no-store'
      });

      if (!response.ok) {
        lastError = `EQL 응답 오류 ${response.status}`;
        continue;
      }

      const html = await response.text();
      if (looksBlocked(html)) {
        lastError = 'EQL 접근 제한 페이지가 반환되었습니다.';
        continue;
      }

      const parsed = parseEqlStockHtml(html);
      if (!parsed.options.length) {
        lastError = '상품 페이지에서 옵션 재고를 찾지 못했습니다.';
        continue;
      }

      return {
        ok: true,
        url,
        checkedAt: new Date().toISOString(),
        ...parsed
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    error: lastError,
    options: []
  };
}

export function parseEqlStockHtml(html) {
  const text = htmlToText(html);
  const segment = optionSegment(text);
  const options = parseOptionLines(segment.split('\n'));

  const minimumQuantity = options.reduce((sum, option) => {
    if (option.soldOut) return sum;
    if (Number.isFinite(option.stockQuantity)) return sum + option.stockQuantity;
    return sum + (option.minimumQuantity || DEFAULT_MIN_AVAILABLE);
  }, 0);
  const exactQuantity = options.every((option) => option.soldOut || Number.isFinite(option.stockQuantity));
  const soldOut = options.length > 0 && options.every((option) => option.soldOut === true);

  return {
    options,
    soldOut,
    stockQuantity: exactQuantity ? minimumQuantity : null,
    minimumQuantity,
    exactQuantity,
    stockStatus: soldOut
      ? '품절'
      : exactQuantity
        ? `${minimumQuantity}개`
        : `최소 ${minimumQuantity}개 이상`
  };
}

export function applyLiveStock(product, live) {
  if (!live?.ok) {
    return {
      ...product,
      liveStock: {
        ok: false,
        checkedAt: live?.checkedAt || new Date().toISOString(),
        error: live?.error || '실시간 재고 확인 실패'
      }
    };
  }

  return {
    ...product,
    soldOut: live.soldOut,
    stockQuantity: live.stockQuantity,
    stockMinimumQuantity: live.minimumQuantity,
    stockQuantityExact: live.exactQuantity,
    stockStatus: live.stockStatus,
    options: live.options,
    detailCheckedAt: live.checkedAt,
    liveStock: {
      ok: true,
      checkedAt: live.checkedAt,
      sourceUrl: live.url,
      exactQuantity: live.exactQuantity,
      minimumQuantity: live.minimumQuantity
    }
  };
}

function liveUrls(rawUrl) {
  if (!rawUrl) return [];
  try {
    const url = new URL(rawUrl);
    const desktop = new URL(url.href);
    desktop.hostname = 'www.eqlstore.com';
    const mobile = new URL(url.href);
    mobile.hostname = 'm.eqlstore.com';
    return [...new Set([mobile.href, desktop.href])];
  } catch {
    return [];
  }
}

function looksBlocked(html) {
  const text = String(html || '');
  return /접근\s*제한|Access\s*Denied|Request\s*blocked|비정상적인\s*접근|서비스\s*이용이\s*제한/i.test(text);
}

function htmlToText(html) {
  let text = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:button|li|div|p|span|label|option|ul|ol|section|article|dd|dt|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/\r/g, '')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text;
}

function decodeEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === '#') {
      const hex = key[1] === 'x';
      const number = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    }
    return Object.hasOwn(named, key) ? named[key] : match;
  });
}

function optionSegment(text) {
  const totalIndex = text.lastIndexOf('총 상품 금액');
  const end = totalIndex >= 0 ? totalIndex : text.length;
  const startWindow = Math.max(0, end - 6000);
  let segment = text.slice(startWindow, end);
  const markers = ['사이즈', '옵션'];
  let markerIndex = -1;
  for (const marker of markers) markerIndex = Math.max(markerIndex, segment.lastIndexOf(marker));
  if (markerIndex >= 0) segment = segment.slice(markerIndex + 2);
  return segment;
}

function parseOptionLines(rawLines) {
  const lines = rawLines.map(cleanLine).filter(Boolean);
  const options = [];
  let pending = null;

  const flush = () => {
    if (!pending) return;
    options.push(makeAvailable(pending));
    pending = null;
  };

  for (const line of lines) {
    const sameLine = line.match(/^(.{1,40}?)\s+(재입고\s*알림\s*신청|SOLD\s*OUT|품절|품절\s*임박\s*\(\s*(\d+)\s*\))$/i);
    if (sameLine && isOptionName(sameLine[1])) {
      flush();
      options.push(makeOption(sameLine[1], sameLine[2], sameLine[3]));
      continue;
    }

    const low = line.match(/^품절\s*임박\s*\(\s*(\d+)\s*\)$/i);
    if (low && pending) {
      options.push(makeOption(pending, line, low[1]));
      pending = null;
      continue;
    }

    if (/^(?:재입고\s*알림\s*신청|SOLD\s*OUT|품절)$/i.test(line) && pending) {
      options.push(makeOption(pending, line, null));
      pending = null;
      continue;
    }

    if (isOptionName(line)) {
      flush();
      pending = line;
      continue;
    }

    if (isStopLine(line)) break;
  }
  flush();

  const seen = new Set();
  return options.filter((option) => {
    const key = option.name.toUpperCase().replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeOption(name, status, count) {
  const cleanName = cleanLine(name);
  if (/재입고|SOLD\s*OUT|^품절$/i.test(status)) {
    return {
      id: cleanName,
      name: cleanName,
      soldOut: true,
      stockQuantity: 0,
      minimumQuantity: 0,
      stockQuantityExact: true,
      stockStatus: '품절'
    };
  }
  const quantity = Number(count);
  return {
    id: cleanName,
    name: cleanName,
    soldOut: false,
    stockQuantity: Number.isFinite(quantity) ? quantity : null,
    minimumQuantity: Number.isFinite(quantity) ? quantity : DEFAULT_MIN_AVAILABLE,
    stockQuantityExact: Number.isFinite(quantity),
    stockStatus: Number.isFinite(quantity) ? `${quantity}개` : `${DEFAULT_MIN_AVAILABLE}개 이상`
  };
}

function makeAvailable(name) {
  const cleanName = cleanLine(name);
  return {
    id: cleanName,
    name: cleanName,
    soldOut: false,
    stockQuantity: null,
    minimumQuantity: DEFAULT_MIN_AVAILABLE,
    stockQuantityExact: false,
    stockStatus: `${DEFAULT_MIN_AVAILABLE}개 이상`
  };
}

function isOptionName(value) {
  const text = cleanLine(value);
  if (!text || text.length > 30 || /\s{2,}/.test(text)) return false;
  if (/^(?:사이즈|옵션|선택|닫기|구매하기|바로 구매하기|장바구니에 담기|총 상품 금액|재입고 알림 신청|품절)$/i.test(text)) return false;
  if (/^\d{2,4}(?:\.\d+)?$/.test(text)) return true;
  if (/^(?:FREE|F|OS|ONE\s*SIZE|XS|S|M|L|XL|XXL|XXXL|[XSML]{1,4}\/[XSML]{1,4})$/i.test(text)) return true;
  if (/^[A-Z0-9]{1,8}(?:[-_/.][A-Z0-9]{1,8}){0,2}$/i.test(text) && /[A-Z]/i.test(text)) return true;
  return false;
}

function isStopLine(value) {
  return /^(?:총 상품 금액|장바구니에 담기|바로 구매하기|예약판매 문구|배송 정보)$/i.test(cleanLine(value));
}

function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
