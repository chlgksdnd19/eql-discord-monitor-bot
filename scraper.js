import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  extractDetailDom,
  extractDomCard,
  extractProductsFromJson,
  finalizeProduct,
  mergeProducts,
  mergeTwoProducts,
  normalizeProductId,
  normalizeProductUrl
} from './extractors.js';
import { ensureDir, nowIso, sleep } from './utils.js';

export async function scrapeEql(config, state, debugDir) {
  ensureDir(debugDir);
  const browser = await chromium.launch({ headless: true });
  const apiLog = [];
  const products = [];
  const failedBrands = [];

  try {
    for (const brand of config.brands) {
      let brandProducts = [];
      let lastError = null;

      for (let attempt = 1; attempt <= config.brandRetryCount; attempt += 1) {
        const context = await createBrowserContext(browser, config);
        try {
          brandProducts = await scrapeBrand(context, brand, config, apiLog, debugDir);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          console.warn(`${brand.name} 수집 실패 (${attempt}/${config.brandRetryCount}): ${error.message}`);
          apiLog.push({
            type: 'brand-error',
            brand: brand.name,
            attempt,
            message: error.message
          });
        } finally {
          await context.close().catch(() => {});
        }

        if (attempt < config.brandRetryCount) {
          await sleep(config.brandRetryDelayMs * attempt);
        }
      }

      if (lastError) {
        failedBrands.push({ brand: brand.name, message: lastError.message });
      } else {
        products.push(...brandProducts.slice(0, config.maxProductsPerBrand));
      }

      await sleep(config.brandDelayMs + Math.floor(Math.random() * 1200));
    }

    const mergedList = mergeProducts(products);
    const detailTargets = selectDetailTargets(mergedList, state, config);
    const detailProducts = [];

    if (detailTargets.length) {
      const detailContext = await createBrowserContext(browser, config);
      try {
        for (const target of detailTargets) {
          try {
            const detail = await scrapeProductDetail(detailContext, target.url, target.brand, config, apiLog, debugDir);
            if (detail) detailProducts.push(detail);
          } catch (error) {
            console.warn(`상세 확인 실패 (${target.url}): ${error.message}`);
          }
          await sleep(config.requestDelayMs + Math.floor(Math.random() * 500));
        }
      } finally {
        await detailContext.close().catch(() => {});
      }
    }

    const detailIds = new Set(detailProducts.map((detail) => detail.id));
    const finalProducts = mergeProducts([...mergedList, ...detailProducts]).map((product) => ({
      ...finalizeProduct(product, product.brand),
      detailCheckedAt: detailIds.has(product.id) ? nowIso() : null
    }));

    fs.writeFileSync(path.join(debugDir, 'api-map.json'), `${JSON.stringify(apiLog, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(debugDir, 'products-sample.json'), `${JSON.stringify(finalProducts.slice(0, 30), null, 2)}\n`, 'utf8');

    return {
      products: finalProducts,
      detailTargetCount: detailTargets.length,
      apiCount: apiLog.length,
      failedBrands,
      collectedAt: nowIso()
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function createBrowserContext(browser, config) {
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: config.timezone,
    viewport: { width: 1440, height: 1200 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
  });
  await context.setExtraHTTPHeaders({
    'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6'
  });
  return context;
}

async function scrapeBrand(context, brand, config, apiLog, debugDir) {
  const all = [];
  let emptyPages = 0;

  for (let pageNumber = 1; pageNumber <= config.maxPagesPerBrand; pageNumber += 1) {
    const page = await context.newPage();
    const responses = [];
    attachJsonCollector(page, responses, apiLog);
    const url = withPageNumber(brand.url, pageNumber);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(config.pageWaitMs);
      await detectBlockedPage(page);
      await progressiveScroll(page, 5);
      await expandProductList(page, config.maxProductsPerBrand, config.loadMoreClicksPerBrand || 12);
      await page.waitForTimeout(900);

      const jsonProducts = responses.flatMap((entry) => extractProductsFromJson(entry.data, brand.name));
      const domRaw = await page.locator('a[href*="/product/"][href*="/detail"]').evaluateAll((anchors) => anchors.map((anchor) => {
        let container = anchor.closest('li') || anchor.closest('[class*="product"]') || anchor.parentElement || anchor;
        if ((container.querySelectorAll?.('a[href*="/product/"][href*="/detail"]')?.length || 0) > 1) {
          container = anchor.parentElement || anchor;
          for (let index = 0; index < 5 && container.parentElement; index += 1) {
            const parent = container.parentElement;
            const productLinks = parent.querySelectorAll?.('a[href*="/product/"][href*="/detail"]')?.length || 0;
            if (productLinks > 1) break;
            container = parent;
          }
        }
        const image = anchor.querySelector('img') || container.querySelector?.('img');
        return {
          href: anchor.href || anchor.getAttribute('href'),
          id: anchor.href || anchor.getAttribute('href'),
          name: image?.alt || anchor.getAttribute('aria-label') || anchor.getAttribute('title'),
          text: container.innerText || anchor.innerText || '',
          imageUrl: image?.currentSrc || image?.src || image?.getAttribute('data-src')
        };
      }));
      const domProducts = domRaw.map((raw) => extractDomCard(raw, brand.name)).filter(Boolean);
      const pageProducts = mergeProducts([...jsonProducts, ...domProducts]);
      const productAnchorCount = await page.locator('a[href*="/product/"][href*="/detail"]').count();
      console.log(`${brand.name} DOM 상품 링크 ${productAnchorCount}개, JSON 후보 ${jsonProducts.length}개`);
      if (!pageProducts.length) {
        await saveDebug(page, debugDir, `zero-${brand.code}-page-${pageNumber}`);
      }
      const before = new Set(all.map((product) => product.id));
      const added = pageProducts.filter((product) => !before.has(product.id));
      all.push(...pageProducts);

      console.log(`${brand.name} ${pageNumber}페이지: ${pageProducts.length}개 추출, ${added.length}개 신규 ID`);
      emptyPages = added.length ? 0 : emptyPages + 1;
      if (emptyPages >= 2 || mergeProducts(all).length >= config.maxProductsPerBrand) break;
    } catch (error) {
      await saveDebug(page, debugDir, `brand-${brand.code}-page-${pageNumber}`);
      if (pageNumber === 1) throw error;
      console.warn(`${brand.name} ${pageNumber}페이지 확인 중단: ${error.message}`);
      break;
    } finally {
      await page.close().catch(() => {});
    }
    await sleep(config.requestDelayMs);
  }

  return mergeProducts(all).map((product) => ({ ...product, brand: product.brand || brand.name }));
}

async function scrapeProductDetail(context, productUrl, brandHint, config, apiLog, debugDir) {
  const page = await context.newPage();
  const responses = [];
  attachJsonCollector(page, responses, apiLog);
  const id = normalizeProductId(productUrl);

  try {
    await page.goto(normalizeProductUrl(productUrl, id), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(config.pageWaitMs);
    await detectBlockedPage(page);
    await progressiveScroll(page, 3);

    const jsonProducts = responses
      .flatMap((entry) => extractProductsFromJson(entry.data, brandHint))
      .filter((product) => product.id === id);

    const raw = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const headings = [...document.querySelectorAll('h1,h2,h3,[class*="product-name"],[class*="god-name"]')]
        .map((element) => element.textContent?.trim())
        .filter(Boolean);
      const image = document.querySelector('main img, [class*="product"] img, img');
      const optionElements = [...document.querySelectorAll('button, li, option, [role="option"], [class*="option"], [class*="size"]')];
      const options = optionElements
        .map((element) => ({ text: element.textContent?.trim() || '' }))
        .filter((item) => item.text && item.text.length <= 120)
        .filter((item) => /SOLD\s*OUT|품절|재입고|품절\s*임박|^\d{2,3}(?:\.5)?$|^[A-Z]{1,4}$|FREE/i.test(item.text));
      return {
        url: location.href,
        id: location.href,
        name: headings[0] || image?.alt || null,
        text: bodyText,
        imageUrl: image?.currentSrc || image?.src || null,
        options
      };
    });

    const domProduct = extractDetailDom(raw, brandHint);
    let merged = domProduct;
    for (const product of jsonProducts) merged = mergeTwoProducts(merged, product);
    return finalizeProduct(merged, brandHint);
  } catch (error) {
    await saveDebug(page, debugDir, `product-${id || 'unknown'}`);
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

function selectDetailTargets(products, state, config) {
  const map = new Map(products.map((product) => [product.id, product]));
  for (const url of config.detailProductUrls) {
    const id = normalizeProductId(url);
    if (!id) continue;
    const existing = map.get(id);
    map.set(id, existing || {
      id,
      name: `EQL 상품 ${id}`,
      brand: 'EQL',
      url: normalizeProductUrl(url, id)
    });
  }

  const list = [...map.values()].filter((product) => product.url).sort((a, b) => a.id.localeCompare(b.id));
  const limit = Math.max(0, Number(config.detailChecksPerRun || 0));
  if (!limit) return [];

  const pinnedIds = new Set(config.detailProductUrls.map(normalizeProductId).filter(Boolean));
  const pinned = list.filter((product) => pinnedIds.has(product.id));
  const newProducts = list.filter((product) => !state.products?.[product.id] && !pinnedIds.has(product.id));
  const normal = list.filter((product) => state.products?.[product.id] && !pinnedIds.has(product.id));
  const selected = [...pinned];

  for (const product of newProducts) {
    if (selected.length >= Math.max(limit, pinned.length)) break;
    selected.push(product);
  }

  const cursor = Math.max(0, Number(state.detailCursor || 0));
  for (let index = 0; selected.length < Math.max(limit, pinned.length) && index < normal.length; index += 1) {
    selected.push(normal[(cursor + index) % normal.length]);
  }

  return mergeProducts(selected);
}

function withPageNumber(url, pageNumber) {
  const parsed = new URL(url);
  parsed.searchParams.set('page', String(pageNumber));
  parsed.searchParams.set('excludeSoldoutGodYn', 'N');
  return parsed.href;
}

function attachJsonCollector(page, output, apiLog) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!/(^|\.)eqlstore\.com/i.test(new URL(url).hostname)) return;
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json')) return;
      const length = Number(response.headers()['content-length'] || 0);
      if (length > 12_000_000) return;
      const data = await response.json().catch(() => null);
      if (!data) return;
      output.push({ url, data });
      if (!apiLog.some((entry) => entry.url === url)) {
        apiLog.push({ url, status: response.status(), contentType });
      }
    } catch {
      // DOM parsing remains as fallback when a response body is unavailable.
    }
  });
}

async function expandProductList(page, maxProducts, maxClicks) {
  let stableRounds = 0;
  for (let round = 0; round < maxClicks; round += 1) {
    const before = await page.locator('a[href*="/product/"][href*="/detail"]').count();
    if (before >= maxProducts) break;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);

    const buttons = page.getByRole('button', { name: /^더 보기$/ });
    const buttonCount = await buttons.count();
    let increased = false;
    for (let index = 0; index < buttonCount; index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(900);
      const afterClick = await page.locator('a[href*="/product/"][href*="/detail"]').count();
      if (afterClick > before) {
        increased = true;
        break;
      }
    }

    const after = await page.locator('a[href*="/product/"][href*="/detail"]').count();
    if (after > before || increased) {
      stableRounds = 0;
      continue;
    }
    stableRounds += 1;
    if (stableRounds >= 2) break;
  }
}

async function progressiveScroll(page, rounds) {
  for (let index = 0; index < rounds; index += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.max(800, Math.floor(window.innerHeight * 0.9))));
    await page.waitForTimeout(450);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
}

async function detectBlockedPage(page) {
  const title = await page.title().catch(() => '');
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const sample = `${title} ${body.slice(0, 3000)}`;
  if (/CAPTCHA|비정상적인 접근|접근이 제한|Too Many Requests|서비스 이용이 제한|Access Denied/i.test(sample)) {
    throw new Error(`EQL 접근 제한 페이지가 감지되었습니다: ${title || '제목 없음'}`);
  }
}

async function saveDebug(page, debugDir, name) {
  ensureDir(debugDir);
  await page.screenshot({ path: path.join(debugDir, `${name}.png`), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '');
  if (html) fs.writeFileSync(path.join(debugDir, `${name}.html`), html, 'utf8');
}
