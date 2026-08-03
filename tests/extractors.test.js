import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProductsFromJson, mergeTwoProducts } from '../src/extractors.js';

test('EQL 형태의 JSON에서 상품과 옵션 재고를 추출한다', () => {
  const fixture = {
    data: {
      godList: [{
        godNo: 'GM0026040750345',
        godNm: '[아식스 본사]젤 카야노 14',
        brndNm: 'ASICS',
        rtp: 189000,
        salePrc: 151200,
        dcRt: 20,
        modelNo: '1203A537-100',
        soldOutYn: 'N',
        godImg: '//cdn.eqlstore.com/test.jpg',
        options: [
          { itmNo: '255', itmNm: '255', stockQty: 1, soldOutYn: 'N' },
          { itmNo: '260', itmNm: '260', stockQty: 0, soldOutYn: 'Y' }
        ]
      }]
    }
  };
  const products = extractProductsFromJson(fixture, 'ASICS');
  assert.equal(products.length, 1);
  assert.equal(products[0].id, 'GM0026040750345');
  assert.equal(products[0].currentPrice, 151200);
  assert.equal(products[0].discountRate, 20);
  assert.equal(products[0].soldOut, false);
  assert.deepEqual(products[0].productCodes, ['1203A537-100']);
  assert.equal(products[0].options.length, 2);
  assert.equal(products[0].options[1].soldOut, true);
});

test('상세 응답이 목록 정보보다 우선하며 기존 값을 합친다', () => {
  const list = {
    id: 'GM0026040750345', name: '상품', brand: 'ASICS', currentPrice: 100000,
    soldOut: false, stockQuantity: null, options: [], url: 'https://www.eqlstore.com/product/GM0026040750345/detail'
  };
  const detail = {
    id: 'GM0026040750345', currentPrice: 90000, stockQuantity: 2,
    options: [{ id: '260', name: '260', soldOut: false, stockQuantity: 2 }]
  };
  const merged = mergeTwoProducts(list, detail);
  assert.equal(merged.currentPrice, 90000);
  assert.equal(merged.stockQuantity, 2);
  assert.equal(merged.options.length, 1);
});

test('숫자로만 구성된 아식스 품번도 검색 코드로 보존한다', () => {
  const products = extractProductsFromJson({
    items: [{
      godNo: 'GP9026020423225',
      godNm: '[아식스 본사]매직 스피드 5 112611103-100',
      salePrice: 209000,
      soldOutYn: 'N'
    }]
  }, 'ASICS');

  assert.equal(products.length, 1);
  assert.ok(products[0].productCodes.includes('112611103-100'));
});
