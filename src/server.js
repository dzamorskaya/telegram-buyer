import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const rootDir = resolve(process.cwd());
const publicDir = join(rootDir, "public");
const dataPath = join(rootDir, "data", "state.json");

loadEnvFile();
ensureDataFile();

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST?.trim() || "0.0.0.0";
const appName = process.env.APP_NAME?.trim() || "Telegram Buyer";
const adminUsername = process.env.ADMIN_USERNAME?.trim() || "buyer";
const adminPassword = process.env.ADMIN_PASSWORD?.trim() || "buyer-access-2026";
const nikeCatalogUrl = "https://www.nike.com/w/womens-shoes-5e1x6zy7ok";
const macysCatalogUrl = "https://www.macys.com/shop/womens?id=118";
const importBatchSize = 48;
const macysCatalogPages = 4;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (!isAuthorized(request)) {
      response.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Telegram Buyer Admin"'
      });
      response.end("Нужен логин и пароль.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      const state = withRuntimeState(readState());
      return json(response, 200, state);
    }

    if (request.method === "POST" && url.pathname === "/api/import-nike") {
      const nextState = withRuntimeState(readState());
      nextState.lastScanAt = new Date().toISOString();
      const importResult = await fetchNikeProducts({
        skippedProductUrls: nextState.skippedProductUrls,
        offset: 0
      });
      nextState.products = importResult.products;
      nextState.importState = {
        ...nextState.importState,
        lastSourceId: "nike",
        nikeOffset: importResult.nextOffset
      };
      nextState.queue = normalizeQueue(nextState.queue, nextState.products);
      writeState(nextState);
      return json(response, 200, nextState);
    }

    if (request.method === "POST" && url.pathname === "/api/import-macys") {
      const nextState = withRuntimeState(readState());
      nextState.lastScanAt = new Date().toISOString();
      const importResult = await fetchMacysProducts({
        skippedProductUrls: nextState.skippedProductUrls,
        pageStart: 1
      });
      nextState.products = importResult.products;
      nextState.importState = {
        ...nextState.importState,
        lastSourceId: "macys",
        macysPageStart: importResult.nextPageStart
      };
      nextState.queue = normalizeQueue(nextState.queue, nextState.products);
      writeState(nextState);
      return json(response, 200, nextState);
    }

    if (request.method === "POST" && url.pathname === "/api/load-more") {
      const nextState = withRuntimeState(readState());
      const sourceId = nextState.importState?.lastSourceId;

      if (!sourceId) {
        return json(response, 400, { error: "Сначала запусти импорт магазина." });
      }

      let importResult;

      if (sourceId === "nike") {
        importResult = await fetchNikeProducts({
          skippedProductUrls: [
            ...nextState.skippedProductUrls,
            ...nextState.products.map((product) => product.productUrl)
          ],
          offset: nextState.importState?.nikeOffset || 0
        });
        nextState.importState = {
          ...nextState.importState,
          nikeOffset: importResult.nextOffset
        };
      } else if (sourceId === "macys") {
        importResult = await fetchMacysProducts({
          skippedProductUrls: [
            ...nextState.skippedProductUrls,
            ...nextState.products.map((product) => product.productUrl)
          ],
          pageStart: nextState.importState?.macysPageStart || 1
        });
        nextState.importState = {
          ...nextState.importState,
          macysPageStart: importResult.nextPageStart
        };
      } else {
        return json(response, 400, { error: "Для этого источника загрузка ещё не подключена." });
      }

      nextState.lastScanAt = new Date().toISOString();
      nextState.products = dedupeProductsByUrl([...nextState.products, ...importResult.products]);
      nextState.queue = normalizeQueue(nextState.queue, nextState.products);
      writeState(nextState);
      return json(response, 200, nextState);
    }

    if (request.method === "POST" && url.pathname === "/api/toggle-autopost") {
      const nextState = withRuntimeState(readState());
      nextState.autopost.enabled = !nextState.autopost.enabled;
      nextState.autopost.updatedAt = new Date().toISOString();
      writeState(nextState);
      return json(response, 200, nextState);
    }

    if (request.method === "POST" && url.pathname === "/api/test-post") {
      const state = withRuntimeState(readState());
      const result = await sendTelegramMessage(
        state.channel.id,
        buildTestPost(state.products[0])
      );
      state.channel.lastPostAt = new Date().toISOString();
      state.channel.lastTelegramMessageId = result.message_id ?? null;
      writeState(state);
      return json(response, 200, { ok: true, result });
    }

    if (request.method === "POST" && url.pathname === "/api/pricing-settings") {
      const body = await readJsonBody(request);
      const nextState = withRuntimeState(readState());
      nextState.pricing = {
        usdToRubRate: sanitizeNumber(body.usdToRubRate, nextState.pricing.usdToRubRate),
        deliveryRub: 0,
        markupPercent: sanitizeNumber(body.markupPercent, nextState.pricing.markupPercent)
      };
      writeState(nextState);
      return json(response, 200, withRuntimeState(nextState));
    }

    if (request.method === "POST" && url.pathname === "/api/product-action") {
      const body = await readJsonBody(request);
      const nextState = withRuntimeState(readState());
      const product = nextState.products.find((item) => item.id === body.productId);

      if (!product) {
        return json(response, 404, { error: "Товар не найден" });
      }

      if (body.action === "queue") {
        product.status = "queued";
        nextState.queue = normalizeQueue([...nextState.queue, product.id], nextState.products);
        writeState(nextState);
        return json(response, 200, nextState);
      }

      if (body.action === "skip") {
        product.status = "skipped";
        nextState.skippedProductUrls = normalizeSkippedProductUrls([
          ...(Array.isArray(nextState.skippedProductUrls) ? nextState.skippedProductUrls : []),
          product.productUrl
        ]);
        nextState.queue = normalizeQueue(
          nextState.queue.filter((id) => id !== product.id),
          nextState.products
        );
        writeState(nextState);
        return json(response, 200, nextState);
      }

      if (body.action === "publish") {
        const result = await sendTelegramMessage(
          nextState.channel.id,
          buildChannelPost(product)
        );
        product.status = "published";
        product.publishedAt = new Date().toISOString();
        nextState.channel.lastPostAt = product.publishedAt;
        nextState.channel.lastTelegramMessageId = result.message_id ?? null;
        nextState.queue = normalizeQueue(
          nextState.queue.filter((id) => id !== product.id),
          nextState.products
        );
        writeState(nextState);
        return json(response, 200, nextState);
      }

      return json(response, 400, { error: "Неизвестное действие" });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveFile(response, join(publicDir, "index.html"));
    }

    if (request.method === "GET") {
      return serveFile(response, join(publicDir, url.pathname));
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: toErrorMessage(error) });
  }
});

server.listen(port, host, () => {
  console.log(`${appName} running at http://${host}:${port}`);
});

function isAuthorized(request) {
  const header = request.headers.authorization;

  if (!header || !header.startsWith("Basic ")) {
    return false;
  }

  const encoded = header.slice(6).trim();

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex === -1) {
      return false;
    }

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    return username === adminUsername && password === adminPassword;
  } catch {
    return false;
  }
}

function serveFile(response, filePath) {
  if (!existsSync(filePath)) {
    return json(response, 404, { error: "File not found" });
  }

  const body = readFileSync(filePath);
  const mimeType = mimeTypes[extname(filePath)] || "application/octet-stream";
  response.writeHead(200, { "Content-Type": mimeType });
  response.end(body);
}

function ensureDataFile() {
  const dataDir = join(rootDir, "data");

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (!existsSync(dataPath)) {
    writeState({
      channel: {
        name: "Buyer Deals",
        id: process.env.TELEGRAM_CHANNEL_ID || "@replace_me",
        tone: "Коротко, по делу, с выгодой для подписчика",
        botReady: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID),
        lastPostAt: null,
        lastTelegramMessageId: null
      },
      autopost: {
        enabled: process.env.AUTOPOST_ENABLED === "true",
        intervalMin: Number(process.env.AUTOPOST_INTERVAL_MIN || 180),
        updatedAt: null
      },
      pricing: createDefaultPricing(),
      sources: createDefaultSources(),
      importState: {
        lastSourceId: null,
        nikeOffset: 0,
        macysPageStart: 1
      },
      skippedProductUrls: [],
      queue: [],
      lastScanAt: null,
      products: []
    });
  }
}

function createDefaultSources() {
  return [
    { id: "asos", name: "ASOS US", url: "https://www.asos.com/us", type: "fashion", enabled: true },
    { id: "calvin-klein", name: "Calvin Klein US", url: "https://www.calvinklein.us/en", type: "fashion", enabled: true },
    { id: "footlocker", name: "Foot Locker", url: "https://www.footlocker.com", type: "sneakers", enabled: true },
    { id: "goat", name: "GOAT", url: "https://www.goat.com", type: "resale", enabled: true },
    { id: "guess-factory", name: "Guess Factory", url: "https://www.guessfactory.com/us/en/home/", type: "fashion", enabled: true },
    { id: "jomashop", name: "Jomashop", url: "https://www.jomashop.com", type: "watches", enabled: true },
    { id: "journeys", name: "Journeys", url: "https://www.journeys.com", type: "shoes", enabled: true },
    { id: "karl", name: "Karl US", url: "https://www.karl.com/us-en", type: "fashion", enabled: true },
    { id: "lacoste", name: "Lacoste US", url: "https://www.lacoste.com/us", type: "fashion", enabled: true },
    { id: "macys", name: "Macy's", url: "https://www.macys.com", type: "department", enabled: true },
    { id: "nike", name: "Nike", url: "https://www.nike.com", type: "sneakers", enabled: true },
    { id: "nordstrom", name: "Nordstrom", url: "https://www.nordstrom.com", type: "department", enabled: true },
    { id: "nordstrom-rack", name: "Nordstrom Rack", url: "https://www.nordstromrack.com", type: "outlet", enabled: true },
    { id: "novelship", name: "Novelship", url: "https://novelship.com", type: "resale", enabled: true },
    { id: "snipes", name: "Snipes USA", url: "https://www.snipesusa.com", type: "streetwear", enabled: true },
    { id: "stockx", name: "StockX", url: "https://stockx.com", type: "resale", enabled: true },
    { id: "tommy", name: "Tommy Hilfiger US", url: "https://usa.tommy.com/en", type: "fashion", enabled: true }
  ];
}

function createDefaultPricing() {
  return {
    usdToRubRate: 87,
    deliveryRub: 0,
    markupPercent: 30
  };
}

function readState() {
  return JSON.parse(readFileSync(dataPath, "utf8"));
}

function writeState(state) {
  writeFileSync(dataPath, JSON.stringify(state, null, 2));
}

function withRuntimeState(state) {
  const runtimeChannelId = process.env.TELEGRAM_CHANNEL_ID?.trim();
  const runtimeBotReady = Boolean(
    process.env.TELEGRAM_BOT_TOKEN?.trim() && runtimeChannelId
  );
  const currentSources = Array.isArray(state.sources) ? state.sources : [];
  const mergedSources = createDefaultSources().map((source) => {
    const saved = currentSources.find((item) => item.id === source.id);
    return saved ? { ...source, ...saved } : source;
  });
  const products = migrateProducts(Array.isArray(state.products) ? state.products : [], mergedSources);
  const pricing = {
    ...createDefaultPricing(),
    ...(state.pricing || {})
  };
  const enrichedProducts = products.map((product) => withComputedPricing(product, pricing));

  return {
    ...state,
    channel: {
      ...state.channel,
      id: runtimeChannelId || state.channel.id,
      botReady: runtimeBotReady
    },
    sources: mergedSources,
    pricing,
    importState: normalizeImportState(state.importState),
    skippedProductUrls: normalizeSkippedProductUrls(state.skippedProductUrls),
    queue: normalizeQueue(Array.isArray(state.queue) ? state.queue : [], enrichedProducts),
    products: enrichedProducts
  };
}

function migrateProducts(products, sources) {
  if (products.length === 0) {
    return [];
  }

  return products.map((product, index) => {
    if (product.sourceId && product.sourceName && product.productUrl) {
      return {
        ...product,
        imageUrl: product.imageUrl || "",
        sizes: Array.isArray(product.sizes) ? product.sizes : [],
        weightKg: sanitizeNumber(product.weightKg, estimateWeightKg(product.category)),
        weightSource: product.weightSource || "estimate",
        publishedAt: product.publishedAt || null
      };
    }

    const fallbackSource =
      sources.find((source) => source.name === product.source) ||
      sources.find((source) => source.id === product.sourceId) ||
      sources[0];

    return {
      id: product.id || `product-${index + 1}`,
      title: product.title || "Без названия",
      sourceId: fallbackSource?.id || "unknown",
      sourceName: fallbackSource?.name || product.source || "Неизвестный источник",
      productUrl: fallbackSource?.url || "",
      imageUrl: product.imageUrl || "",
      weightKg: sanitizeNumber(product.weightKg, estimateWeightKg(product.category)),
      weightSource: product.weightSource || "estimate",
      price: product.price ?? 0,
      oldPrice: product.oldPrice ?? product.price ?? 0,
      currency: product.currency || process.env.DEFAULT_CURRENCY || "USD",
      status: product.status || "review",
      category: product.category || "general",
      sizes: Array.isArray(product.sizes) ? product.sizes : [],
      sizeNote: product.sizeNote || "Уточнить размеры",
      availability: product.availability || "unknown",
      lastCheckedAt: product.lastCheckedAt || new Date().toISOString(),
      marginNote: product.marginNote || "",
      publishedAt: product.publishedAt || null,
      draftPost: product.draftPost || ""
    };
  });
}

function normalizeQueue(queue, products) {
  const ids = new Set(products.map((product) => product.id));
  return [...new Set(queue)].filter((id) => ids.has(id));
}

function normalizeSkippedProductUrls(urls) {
  if (!Array.isArray(urls)) {
    return [];
  }

  return [...new Set(urls.filter((url) => typeof url === "string" && url.trim()))];
}

function normalizeImportState(importState) {
  return {
    lastSourceId: importState?.lastSourceId || null,
    nikeOffset: sanitizeNumber(importState?.nikeOffset, 0),
    macysPageStart: sanitizeNumber(importState?.macysPageStart, 1)
  };
}

function dedupeProductsByUrl(products) {
  const seen = new Set();
  return products.filter((product) => {
    if (!product?.productUrl || seen.has(product.productUrl)) {
      return false;
    }

    seen.add(product.productUrl);
    return true;
  });
}

function withComputedPricing(product, pricing) {
  const weightKg = sanitizeNumber(product.weightKg, estimateWeightKg(product.category));
  const shippingRateUsdPerKg = weightKg > 5 ? 18 : 20;
  const shippingUsd = roundMoney(weightKg * shippingRateUsdPerKg);
  const markupUsd = roundMoney(product.price * (pricing.markupPercent / 100));
  const subtotalUsd = product.price + shippingUsd + markupUsd;
  const sourcePriceRub = roundMoney(product.price * pricing.usdToRubRate);
  const shippingRub = roundMoney(shippingUsd * pricing.usdToRubRate);
  const markupRub = roundMoney(markupUsd * pricing.usdToRubRate);
  const costPriceRub = roundMoney(sourcePriceRub + shippingRub);
  const clientPriceRub = roundMoney(subtotalUsd * pricing.usdToRubRate);
  const profitRub = markupRub;

  return {
    ...product,
    weightKg,
    pricing: {
      sourcePriceRub,
      costPriceRub,
      clientPriceRub,
      profitRub,
      shippingUsd,
      shippingRub,
      markupUsd,
      markupRub,
      shippingRateUsdPerKg
    }
  };
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN не задан в .env");
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error(data.description || "Telegram API error");
    }

    return data.result;
  } catch (error) {
    const details =
      error instanceof Error && error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : toErrorMessage(error);

    throw new Error(details);
  }
}

function buildTestPost(product) {
  if (!product) {
    return "Тестовый пост из Telegram Buyer. Товары пока не загружены.";
  }

  return [
    "Тестовый пост из Telegram Buyer",
    "",
    buildChannelPost(product),
    "",
    "Если пост пришел в канал, значит интеграция работает."
  ].join("\n");
}

function buildChannelPost(product) {
  return [
    product.title,
    product.sourceName,
    product.sizes?.length ? `Размеры: ${product.sizes.join(", ")}` : "Размеры уточняются",
    `Цена: ${formatRub(product.pricing?.clientPriceRub || 0)}`,
    "Для заказа пишите в личные сообщения."
  ].join("\n");
}

async function fetchNikeProducts({ skippedProductUrls = [], offset = 0 } = {}) {
  const response = await fetch(nikeCatalogUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 TelegramBuyer/1.0",
      Accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(30000)
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Nike import failed: status ${response.status}`);
  }

  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );

  if (!nextDataMatch) {
    throw new Error("Nike import failed: __NEXT_DATA__ not found");
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  const groupings =
    nextData?.props?.pageProps?.initialState?.Wall?.productGroupings;
  const skippedSet = new Set(normalizeSkippedProductUrls(skippedProductUrls));

  if (!Array.isArray(groupings) || groupings.length === 0) {
    throw new Error("Nike import failed: products not found");
  }

  const allProducts = groupings
    .flatMap((grouping) => grouping.products || [])
    .filter((product) => product?.copy?.title && product?.pdpUrl?.url)
    .filter((product) => !skippedSet.has(product.pdpUrl.url));

  const slice = allProducts.slice(offset, offset + importBatchSize);
  const products = await Promise.all(slice.map((product) => mapNikeProduct(product)));

  if (products.length === 0) {
    throw new Error("Nike import failed: empty product list");
  }

  return {
    products,
    nextOffset: offset + slice.length
  };
}

async function fetchMacysProducts({ skippedProductUrls = [], pageStart = 1 } = {}) {
  const skippedSet = new Set(normalizeSkippedProductUrls(skippedProductUrls));
  const products = [];
  let nextPageStart = pageStart;

  for (
    let pageIndex = pageStart;
    pageIndex < pageStart + macysCatalogPages && products.length < importBatchSize;
    pageIndex += 1
  ) {
    const pageProducts = await fetchMacysCatalogPage(pageIndex, skippedSet);
    nextPageStart = pageIndex + 1;

    for (const product of pageProducts) {
      if (products.length >= importBatchSize) {
        break;
      }

      if (products.some((item) => item.productUrl === product.productUrl)) {
        continue;
      }

      products.push(product);
    }
  }

  if (products.length === 0) {
    throw new Error("Macy's import failed: empty product list");
  }

  const sizedProducts = await Promise.all(
    products.map(async (product) => {
      const sizes = await fetchMacysSizes(product.productUrl);

      return {
        ...product,
        sizes,
        sizeNote: sizes.length > 0 ? sizes.join(", ") : "Размеры пока не найдены в Macy's"
      };
    })
  );

  return {
    products: sizedProducts,
    nextPageStart
  };
}

async function fetchMacysCatalogPage(pageIndex, skippedSet) {
  const pageUrl = `${macysCatalogUrl}&Pageindex=${pageIndex}`;
  const response = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 TelegramBuyer/1.0",
      Accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(30000)
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Macy's import failed: status ${response.status}`);
  }

  const nuxtMatch = html.match(
    /<script type="application\/json" data-nuxt-data="nuxt-app"[^>]*>([\s\S]*?)<\/script>/
  );

  if (!nuxtMatch) {
    return [];
  }

  const text = nuxtMatch[1];
  const productPattern =
    /\{"product":\d+\},\{"id":\d+,"identifier":\d+,"detail":\d+,"relationships":\d+,"imagery":\d+,"availability":\d+,"traits":\d+,"pricing":\d+(?:,"meta":\d+)?\},\{"productUrl":\d+,"productId":\d+\},"([^"]+)",\{"name":\d+,[^}]*\},"([^"]+)"([\s\S]*?)(?=\{"product":\d+\},\{"id":\d+,"identifier":\d+)/g;
  const pageProducts = [];
  let match;

  while ((match = productPattern.exec(text))) {
    const productUrl = match[1];
    const title = match[2];
    const segment = match[3];
    const fullProductUrl = `https://www.macys.com${productUrl}`;
    const imagePath = segment.match(/"(\d\/optimized\/[^"]+?\.(?:tif|jpg|jpeg|png))"/)?.[1];
    const prices = [...segment.matchAll(/"\$([0-9,.]+)"/g)].map((item) =>
      Number(item[1].replace(/,/g, ""))
    );

    if (!productUrl || !title || prices.length === 0 || skippedSet.has(fullProductUrl)) {
      continue;
    }

    const currentPrice = Math.min(...prices);
    const oldPrice = Math.max(...prices);

    pageProducts.push({
      id: `macys-${slugify(productUrl)}`,
      title,
      sourceId: "macys",
      sourceName: "Macy's",
      productUrl: fullProductUrl,
      imageUrl: imagePath
        ? enhanceImageUrl(`https://slimages.macysassets.com/is/image/MCY/products/${imagePath}`)
        : "",
      weightKg: estimateWeightKg("fashion"),
      weightSource: "estimate",
      price: currentPrice,
      oldPrice,
      currency: "USD",
      status: oldPrice > currentPrice ? "ready" : "review",
      category: inferMacysCategory(productUrl, title),
      sizes: [],
      sizeNote: "Размеры загружаются из карточки Macy's",
      availability: "in_stock",
      lastCheckedAt: new Date().toISOString(),
      marginNote: `Импортировано из Macy's · страница ${pageIndex}`,
      publishedAt: null,
      draftPost: [
        title,
        `Цена: USD ${currentPrice}` + (oldPrice > currentPrice ? ` вместо USD ${oldPrice}` : ""),
        "Проверить наличие в Macy's перед публикацией."
      ].join("\n")
    });
  }

  return pageProducts;
}

async function mapNikeProduct(product) {
  const title = product.copy?.title?.trim() || "Nike Product";
  const subtitle = product.copy?.subTitle?.trim() || "Nike";
  const currentPrice = Number(product.prices?.currentPrice || 0);
  const initialPrice = Number(product.prices?.initialPrice || currentPrice);
  const discount = currentPrice > 0 && initialPrice > currentPrice
    ? Math.round(((initialPrice - currentPrice) / initialPrice) * 100)
    : 0;
  const badge = product.badgeLabel?.trim();
  const sizes = await fetchNikeSizes(product.pdpUrl.url);

  return {
    id: `nike-${slugify(product.productCode || title)}`,
    title,
    sourceId: "nike",
    sourceName: "Nike",
    productUrl: product.pdpUrl.url,
    imageUrl: enhanceImageUrl(
      product.colorwayImages?.portraitURL ||
        product.colorwayImages?.squarishURL ||
        ""
    ),
    weightKg: estimateWeightKg(product.productType),
    weightSource: "estimate",
    price: currentPrice,
    oldPrice: initialPrice,
    currency: product.prices?.currency || "USD",
    status: discount >= 20 ? "ready" : "review",
    category: String(product.productType || "general").toLowerCase(),
    sizes,
    sizeNote: sizes.length > 0 ? sizes.join(", ") : "Размеры смотреть в карточке Nike",
    availability: "in_stock",
    lastCheckedAt: new Date().toISOString(),
    marginNote: badge ? `Маркер Nike: ${badge}` : `Категория: ${subtitle}`,
    publishedAt: null,
    draftPost: [
      title,
      `${subtitle}`,
      `Цена: ${product.prices?.currency || "USD"} ${currentPrice}` +
        (initialPrice > currentPrice ? ` вместо ${product.prices?.currency || "USD"} ${initialPrice}` : ""),
      badge ? `Маркер: ${badge}` : "Проверить размеры и доставку перед публикацией."
    ].join("\n")
  };
}

async function fetchNikeSizes(productUrl) {
  try {
    const response = await fetch(productUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 TelegramBuyer/1.0",
        Accept: "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );

    if (!nextDataMatch) {
      return [];
    }

    const sizeMatches = [...nextDataMatch[1].matchAll(/"localizedLabel":"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((label) => /^W\s/.test(label));

    return [...new Set(sizeMatches)].slice(0, 8);
  } catch {
    return [];
  }
}

async function fetchMacysSizes(productUrl) {
  try {
    const response = await fetch(productUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 TelegramBuyer/1.0",
        Accept: "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const sizeMatches = [...html.matchAll(/"size":"([^"]+)"/g)]
      .map((match) => normalizeMacysSizeLabel(decodeHtmlEntities(match[1]).trim()))
      .filter(Boolean)
      .filter((label) => !/^(default)$/i.test(label));

    return [...new Set(sizeMatches)].slice(0, 12);
  } catch {
    return [];
  }
}

function loadEnvFile() {
  const envPath = join(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeMacysSizeLabel(label) {
  if (!label) {
    return "";
  }

  if (/^(no size|one size|one size fits all)$/i.test(label)) {
    return "One size";
  }

  return label;
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function formatRub(value) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function sanitizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function estimateWeightKg(category) {
  const normalized = String(category || "").toLowerCase();

  if (normalized.includes("footwear") || normalized.includes("sneaker") || normalized.includes("shoe")) {
    return 1.2;
  }

  if (normalized.includes("bag")) {
    return 1;
  }

  if (normalized.includes("denim") || normalized.includes("apparel") || normalized.includes("clothing")) {
    return 0.8;
  }

  return 1;
}

function inferMacysCategory(productUrl, title) {
  const source = `${productUrl} ${title}`.toLowerCase();

  if (source.includes("sneaker") || source.includes("shoe") || source.includes("sandal")) {
    return "footwear";
  }

  if (source.includes("bag") || source.includes("tote") || source.includes("satchel")) {
    return "bags";
  }

  if (source.includes("bracelet") || source.includes("ring") || source.includes("jewelry")) {
    return "accessories";
  }

  return "fashion";
}

function enhanceImageUrl(url) {
  if (!url) {
    return "";
  }

  if (url.includes("static.nike.com") && url.includes("/t_default/")) {
    return url.replace("/t_default/", "/t_PDP_1728_v1/f_auto,q_auto:eco/");
  }

  if (url.includes("slimages.macysassets.com/is/image/MCY/products/")) {
    return `${url}?wid=1400&fmt=jpeg&qlt=90`;
  }

  return url;
}
