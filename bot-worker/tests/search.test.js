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
