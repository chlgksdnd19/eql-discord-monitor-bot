import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProducts, productToEmbed } from '../src/search.js';

const state = {
  lastCheckedAt: '2026-08-03T06:00:00.000Z',
  products: {
    GM0012345678901: {
      id: 'GM0012345678901',
      name: 'GEL-KAYANO 14 1203A537-100',
      brand: 'ASICS',
      productCodes: ['1203A537-100'],
      currentPrice: 189000,
      originalPrice: 199000,
      discountRate: 5,
      soldOut: false,
      options: [{ id: '260', name: '260', soldOut: false, stockQuantity: 2 }],
      url: 'https://www.eqlstore.com/product/GM0012345678901/detail'
    }
  }
};

test('제조사 품번을 하이픈 유무와 관계없이 찾는다', () => {
  assert.equal(searchProducts(state, '1203A537100')[0]?.id, 'GM0012345678901');
});

test('EQL 상품번호로 찾는다', () => {
  assert.equal(searchProducts(state, 'GM0012345678901')[0]?.id, 'GM0012345678901');
});

test('검색 임베드에 가격과 재고가 포함된다', () => {
  const embed = productToEmbed(state.products.GM0012345678901, state);
  assert.match(embed.fields.find((field) => field.name === '금액').value, /189,000원/);
  assert.match(embed.fields.find((field) => field.name === '재고').value, /260: 2개/);
});

test('숫자형 아식스 품번도 하이픈 유무와 관계없이 찾는다', () => {
  const numericState = {
    products: {
      GP9026020423225: {
        id: 'GP9026020423225',
        name: '[아식스 본사]매직 스피드 5 112611103-100',
        brand: 'ASICS',
        productCodes: ['112611103-100']
      }
    }
  };
  assert.equal(searchProducts(numericState, '112611103100')[0]?.id, 'GP9026020423225');
});

test('실시간 공개 재고는 최소 수량과 옵션별 수량을 표시한다', () => {
  const product = {
    ...state.products.GM0012345678901,
    stockQuantity: null,
    stockMinimumQuantity: 9,
    stockQuantityExact: false,
    options: [
      { id: '225', name: '225', soldOut: false, stockQuantity: null, minimumQuantity: 6, stockStatus: '6개 이상' },
      { id: '245', name: '245', soldOut: false, stockQuantity: 3, minimumQuantity: 3, stockStatus: '3개' }
    ],
    liveStock: { ok: true, checkedAt: '2026-08-03T06:00:00.000Z' }
  };
  const embed = productToEmbed(product, state);
  const stock = embed.fields.find((field) => field.name === '재고').value;
  assert.match(stock, /최소 재고: 9개 이상/);
  assert.match(stock, /225: 6개 이상/);
  assert.match(stock, /245: 3개/);
});
