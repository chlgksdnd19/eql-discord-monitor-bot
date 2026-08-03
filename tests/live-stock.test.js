import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEqlStockHtml, applyLiveStock } from '../src/live-stock.js';

const html = `
<html><body>
<div>사이즈</div>
<ul>
<li><button>225</button></li>
<li><button>230</button></li>
<li><button>235</button><span>재입고 알림 신청</span></li>
<li><button>245</button><span>품절 임박 (3)</span></li>
<li><button>265</button><span>품절 임박 (2)</span></li>
<li><button>270</button><span>품절 임박 (1)</span></li>
</ul>
<div>총 상품 금액</div>
</body></html>`;

test('EQL 공개 옵션 재고를 파싱한다', () => {
  const stock = parseEqlStockHtml(html);
  assert.equal(stock.options.length, 6);
  assert.equal(stock.options.find((item) => item.name === '235').soldOut, true);
  assert.equal(stock.options.find((item) => item.name === '245').stockQuantity, 3);
  assert.equal(stock.options.find((item) => item.name === '225').minimumQuantity, 6);
  assert.equal(stock.exactQuantity, false);
  assert.equal(stock.minimumQuantity, 18);
});

test('실시간 재고를 상품 데이터에 적용한다', () => {
  const parsed = parseEqlStockHtml(html);
  const product = applyLiveStock({ id: 'GQEZ', soldOut: false, options: [] }, { ok: true, checkedAt: '2026-08-03T00:00:00Z', url: 'https://m.eqlstore.com/product/GQEZ/detail', ...parsed });
  assert.equal(product.options.length, 6);
  assert.equal(product.stockMinimumQuantity, 18);
  assert.equal(product.liveStock.ok, true);
});
