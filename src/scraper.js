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
      const outcome = await collectBrandWithRetries(browser, brand, config, apiLog, debugDir);
      if (!outcome.ok) {
        failedBrands.push({ brand: brand.name, code: brand.code, message: outcome.error });
        continue;
      }
      products.push(...outcome.products.slice(0, config.maxProductsPerBrand));
    }

    const mergedList = mergeProducts(products);
    const skipDetailChecks = config.runMode === 'inspect-api' || !state.initialized || config.runMode === 'reset-baseline';
    const detailTargets = skipDetailChecks ? [] : selectDetailTargets(mergedList, state, config);
    console.log(`상세 확인 대상: ${detailTargets.length}개${skipDetailChecks ? ' (현재 모드에서는 상세 조회 생략)' : ''}`);

    const detailProducts = [];
    for (const target of detailTargets) {
      try {
        const detail = await scrapeProductDetailWithRetry(browser, target, config, apiLog, debugDir);
        if (detail) detailProducts.push(detail);
      } catch (error) {
        console.warn(`상세 확인 실패 (${target.url}): ${error.message}`);
      }
    }

    const detailIds = new Set(detailProducts.map((detail) => detail.id));
    const finalProducts = mergeProducts([...mergedList, ...detailProducts]).map((product) => ({
      ...finalizeProduct(product, product.brand),
      detailCheckedAt: detailIds.has(product.id) ? nowIso() : null
    }));

    fs.writeFileSync(path.join(debugDir, 'api-map.json'), `${JSON.stringify(apiLog, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(debugDir, 'products-sample.json'), `${JSON.stringify(finalProducts.slice(0, 40), null, 2)}\n`, 'utf8');

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

async function collectBrandWithRetries(browser, brand, config, apiLog, debugDir) {
  const candidates = uniqueStrings([brand.mobileUrl, brand.url]);
  let lastError = null;

  for (let attempt = 1; attempt <= config.brandRetryCount; attempt += 1) {
    const candidateUrl = candidates[(attempt - 1) % candidates.length];
    const context = await createBrowserContext(browser, config, new URL(candidateUrl).hostname);
    try {
      const brandProducts = await scrapeBrand(context, brand, candidateUrl, config, apiLog, debugDir);
      if (brandProducts.length < brand.minimumProducts) {
        throw new Error(`상품이 ${brandProducts.length}개만 추출되어 안전 기준(${brand.minimumProducts}개)에 미달했습니다.`);
      }
      return { ok: true, products: brandProducts, error: null };
    } catch (error) {
      lastError = error;
      console.warn(`${brand.name} 수집 실패 (${attempt}/${config.brandRetryCount}, ${new URL(candidateUrl).hostname}): ${error.message}`);
      apiLog.push({
        type: 'brand-error',
        brand: brand.name,
        code: brand.code,
        attempt,
        host: new URL(candidateUrl).hostname,
        message: error.message
      });
    } finally {
      await context.close().catch(() => {});
    }

    if (attempt < config.brandRetryCount) await sleep(config.brandRetryDelayMs * attempt);
  }

  return { ok: false, products: [], error: lastError?.message || '알 수 없는 수집 오류' };
}

async function createBrowserContext(browser, config, hostname) {
  const mobile = hostname.startsWith('m.');
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: config.timezone,
    viewport: mobile ? { width: 430, height: 932 } : { width: 1440, height: 1200 },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    userAgent: mobile
      ? 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  });
  await context.setExtraHTTPHeaders({
    'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
    'cache-control': 'no-cache',
    pragma: 'no-cache'
  });
  return context;
}

async function scrapeBrand(context, brand, baseUrl, config, apiLog, debugDir) {
  const all = [];
  let emptyPages = 0;

  for (let pageNumber = 1; pageNumber <= config.maxPagesPerBrand; pageNumber += 1) {
    const page = await context.newPage();
    const responses = [];
    attachJsonCollector(page, responses, apiLog);
    const url = withPageNumber(baseUrl, pageNumber);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(config.pageWaitMs);
      await detectBlockedPage(page);
      await waitForProductLinks(page);
      await progressiveScroll(page, 4);
      await expandProductList(page, config.maxProductsPerBrand, config.loadMoreClicksPerBrand);
      await page.waitForTimeout(700);
      await detectBlockedPage(page);

      const jsonProducts = responses
        .flatMap((entry) => extractProductsFromJson(entry.data, brand.name))
        .filter((product) => matchesBrandProduct(product, brand));

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

      const matchedRaw = domRaw.filter((raw) => matchesBrandRaw(raw, brand));
      const domProducts = matchedRaw.map((raw) => extractDomCard(raw, brand.name)).filter(Boolean);
      const pageProducts = mergeProducts([...jsonProducts, ...domProducts]);
      const productAnchorCount = await page.locator('a[href*="/product/"][href*="/detail"]').count();
      console.log(`${brand.name} DOM 상품 링크 ${productAnchorCount}개, 브랜드 일치 ${matchedRaw.length}개, JSON 후보 ${jsonProducts.length}개`);

      if (!pageProducts.length) await saveDebug(page, debugDir, `zero-${brand.code}-page-${pageNumber}`);

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

  return mergeProducts(all)
    .filter((product) => matchesBrandProduct(product, brand))
    .map((product) => ({ ...product, brand: brand.name }));
}

async function scrapeProductDetailWithRetry(browser, target, config, apiLog, debugDir) {
  const id = normalizeProductId(target.url || target.id);
  if (!id) throw new Error('상품 ID를 확인할 수 없습니다.');

  const urls = uniqueStrings([
    `https://m.eqlstore.com/product/${id}/detail`,
    normalizeProductUrl(target.url, id)
  ]);
  let lastError = null;

  for (let attempt = 0; attempt < urls.length; attempt += 1) {
    const url = urls[attempt];
    const context = await createBrowserContext(browser, config, new URL(url).hostname);
    try {
      return await scrapeProductDetail(context, url, target.brand, config, apiLog, debugDir);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < urls.length) await sleep(Math.min(5000, config.requestDelayMs + 1200));
    } finally {
      await context.close().catch(() => {});
    }
  }

  throw lastError || new Error('상품 상세 정보를 확인하지 못했습니다.');
}

async function scrapeProductDetail(context, productUrl, brandHint, config, apiLog, debugDir) {
  const page = await context.newPage();
  const responses = [];
  attachJsonCollector(page, responses, apiLog);
  const id = normalizeProductId(productUrl);

  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(config.pageWaitMs);
    await detectBlockedPage(page);
    await progressiveScroll(page, 2);

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
    await saveDebug(page, debugDir, `product-${id || 'unknown'}-${new URL(productUrl).hostname.replace(/\W/g, '-')}`);
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
      brand: config.brands[0]?.name || 'EQL',
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
  parsed.searchParams.set('productPage', String(pageNumber));
  parsed.searchParams.set('sort', 'NEW_GOD');
  parsed.searchParams.set('excludeSoldoutGodYn', 'N');
  parsed.searchParams.set('_monitorTs', String(Math.floor(Date.now() / 300000)));
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
      if (!apiLog.some((entry) => entry.url === url)) apiLog.push({ url, status: response.status(), contentType });
    } catch {
      // DOM parsing remains as fallback.
    }
  });
}

async function waitForProductLinks(page) {
  await page.locator('a[href*="/product/"][href*="/detail"]').first().waitFor({ state: 'attached', timeout: 9000 }).catch(() => {});
}

async function expandProductList(page, maxProducts, maxClicks) {
  let stableRounds = 0;
  for (let round = 0; round < maxClicks; round += 1) {
    const before = await page.locator('a[href*="/product/"][href*="/detail"]').count();
    if (before >= maxProducts * 2) break;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(550);

    const buttons = page.getByRole('button', { name: /^더 보기$/ });
    const buttonCount = await buttons.count();
    let clicked = false;
    for (let index = 0; index < buttonCount; index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click({ timeout: 5000 }).catch(() => {});
      clicked = true;
      await page.waitForTimeout(750);
      break;
    }

    const after = await page.locator('a[href*="/product/"][href*="/detail"]').count();
    if (after > before) {
      stableRounds = 0;
      continue;
    }
    stableRounds += 1;
    if (!clicked || stableRounds >= 2) break;
  }
}

async function progressiveScroll(page, rounds) {
  for (let index = 0; index < rounds; index += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.max(800, Math.floor(window.innerHeight * 0.9))));
    await page.waitForTimeout(350);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
}

async function detectBlockedPage(page) {
  const title = await page.title().catch(() => '');
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const sample = `${title} ${body.slice(0, 5000)}`;
  if (/CAPTCHA|비정상적인 접근|접근이 제한|Too Many Requests|서비스 이용이 제한|Access Denied/i.test(sample)) {
    throw new Error(`EQL 접근 제한 페이지가 감지되었습니다: ${title || '제목 없음'}`);
  }
}

function matchesBrandRaw(raw, brand) {
  const key = compactText(`${raw?.name || ''} ${raw?.text || ''}`);
  return brand.matchKeys.some((matchKey) => matchKey && key.includes(matchKey));
}

function matchesBrandProduct(product, brand) {
  const key = compactText(`${product?.brand || ''} ${product?.name || ''}`);
  return brand.matchKeys.some((matchKey) => matchKey && key.includes(matchKey));
}

function compactText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^A-Z0-9가-힣]/g, '');
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

async function saveDebug(page, debugDir, name) {
  ensureDir(debugDir);
  await page.screenshot({ path: path.join(debugDir, `${name}.png`), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '');
  if (html) fs.writeFileSync(path.join(debugDir, `${name}.html`), html, 'utf8');
}
