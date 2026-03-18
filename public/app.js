const elements = {
  lastScan: document.querySelector("#lastScan"),
  productCount: document.querySelector("#productCount"),
  autopostStatus: document.querySelector("#autopostStatus"),
  productList: document.querySelector("#productList"),
  queueList: document.querySelector("#queueList"),
  channelName: document.querySelector("#channelName"),
  channelId: document.querySelector("#channelId"),
  botStatus: document.querySelector("#botStatus"),
  channelTone: document.querySelector("#channelTone"),
  autopostMode: document.querySelector("#autopostMode"),
  autopostInterval: document.querySelector("#autopostInterval"),
  usdToRubRate: document.querySelector("#usdToRubRate"),
  markupPercent: document.querySelector("#markupPercent"),
  savePricingButton: document.querySelector("#savePricingButton"),
  sourceList: document.querySelector("#sourceList"),
  uiMessage: document.querySelector("#uiMessage"),
  filterSummary: document.querySelector("#filterSummary"),
  sourceFilter: document.querySelector("#sourceFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  minDiscountFilter: document.querySelector("#minDiscountFilter"),
  sizesOnlyFilter: document.querySelector("#sizesOnlyFilter"),
  scanButton: document.querySelector("#scanButton"),
  importMacysButton: document.querySelector("#importMacysButton"),
  autopostButton: document.querySelector("#autopostButton"),
  testPostButton: document.querySelector("#testPostButton")
};

const filters = {
  sourceId: "all",
  status: "all",
  minDiscount: 0,
  sizesOnly: false
};

elements.scanButton.addEventListener("click", async () => {
  await runImportAction(elements.scanButton, "/api/import-nike", "Импорт из Nike", "Товары из Nike обновлены в админке.");
});

elements.importMacysButton.addEventListener("click", async () => {
  await runImportAction(
    elements.importMacysButton,
    "/api/import-macys",
    "Импорт из Macy's",
    "Товары из Macy's обновлены в админке."
  );
});

elements.autopostButton.addEventListener("click", async () => {
  elements.autopostButton.disabled = true;

  try {
    await fetch("/api/toggle-autopost", { method: "POST" });
    await loadState();
    showMessage("Режим автопостинга обновлён.");
  } finally {
    elements.autopostButton.disabled = false;
  }
});

elements.testPostButton.addEventListener("click", async () => {
  elements.testPostButton.disabled = true;
  elements.testPostButton.textContent = "Отправка...";

  try {
    const response = await fetch("/api/test-post", { method: "POST" });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось отправить тестовый пост");
    }

    showMessage("Тестовый пост отправлен в канал.");
    await loadState();
  } catch (error) {
    showMessage(error.message || "Ошибка отправки", "error");
  } finally {
    elements.testPostButton.disabled = false;
    elements.testPostButton.textContent = "Тестовый пост";
  }
});

elements.savePricingButton.addEventListener("click", async () => {
  elements.savePricingButton.disabled = true;

  try {
    const response = await fetch("/api/pricing-settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        usdToRubRate: Number(elements.usdToRubRate.value),
        markupPercent: Number(elements.markupPercent.value)
      })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось сохранить расчёт");
    }

    await loadState();
    showMessage("Расчёт цены сохранён.");
  } catch (error) {
    showMessage(error.message || "Ошибка сохранения", "error");
  } finally {
    elements.savePricingButton.disabled = false;
  }
});

elements.sourceFilter.addEventListener("change", () => {
  filters.sourceId = elements.sourceFilter.value;
  loadState();
});

elements.statusFilter.addEventListener("change", () => {
  filters.status = elements.statusFilter.value;
  loadState();
});

elements.minDiscountFilter.addEventListener("input", () => {
  filters.minDiscount = Number(elements.minDiscountFilter.value) || 0;
  loadState();
});

elements.sizesOnlyFilter.addEventListener("change", () => {
  filters.sizesOnly = elements.sizesOnlyFilter.checked;
  loadState();
});

await loadState();

async function loadState() {
  const response = await fetch("/api/state");
  const state = await response.json();

  elements.lastScan.textContent = state.lastScanAt ? formatDate(state.lastScanAt) : "Еще не было";
  elements.productCount.textContent = String(state.products.length);
  elements.autopostStatus.textContent = state.autopost.enabled ? "ON" : "OFF";
  elements.channelName.textContent = state.channel.name;
  elements.channelId.textContent = state.channel.id;
  elements.botStatus.textContent = state.channel.botReady ? "подключен" : "не подключен";
  elements.channelTone.textContent = state.channel.tone;
  elements.autopostMode.textContent = state.autopost.enabled ? "Автоматический режим включен" : "Ручной режим";
  elements.autopostInterval.textContent = String(state.autopost.intervalMin);
  elements.usdToRubRate.value = String(state.pricing.usdToRubRate);
  elements.markupPercent.value = String(state.pricing.markupPercent);
  elements.sourceFilter.innerHTML = '<option value="all">Все</option>';
  elements.sourceList.innerHTML = "";
  elements.productList.innerHTML = "";
  elements.queueList.innerHTML = "";

  for (const source of state.sources) {
    const item = document.createElement("a");
    item.className = "source-item";
    item.href = source.url;
    item.target = "_blank";
    item.rel = "noreferrer";
    item.innerHTML = `
      <div>
        <strong>${source.name}</strong>
        <p>${source.type}</p>
      </div>
      <span class="source-state ${source.enabled ? "is-on" : "is-off"}">${source.enabled ? "ON" : "OFF"}</span>
    `;
    elements.sourceList.append(item);

    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.name;
    if (filters.sourceId === source.id) {
      option.selected = true;
    }
    elements.sourceFilter.append(option);
  }

  elements.statusFilter.value = filters.status;
  elements.minDiscountFilter.value = String(filters.minDiscount);
  elements.sizesOnlyFilter.checked = filters.sizesOnly;

  const filteredProducts = state.products
    .filter((product) => matchesFilters(product))
    .sort((left, right) => discountPercent(right.price, right.oldPrice) - discountPercent(left.price, left.oldPrice));

  elements.filterSummary.textContent = `Показано ${filteredProducts.length} из ${state.products.length} товаров`;

  if (filteredProducts.length === 0) {
    elements.productList.innerHTML = '<p class="queue-empty">По текущим фильтрам подходящих товаров нет.</p>';
  }

  for (const product of filteredProducts) {
    const card = document.createElement("article");
    card.className = "product";
    card.innerHTML = `
      <div class="product-media">
        ${
          product.imageUrl
            ? `<img src="${product.imageUrl}" alt="${product.title}" loading="lazy" />`
            : `<div class="product-placeholder">Нет фото</div>`
        }
      </div>
      <div class="product-top">
        <div>
          <p class="product-source">${product.sourceName}</p>
          <h4>${product.title}</h4>
        </div>
        <span class="status status-${product.status}">${product.status}</span>
      </div>
      <div class="product-metrics">
        <div>
          <p class="price">${formatRub(product.pricing.clientPriceRub)}</p>
          <p class="subprice">Товар: ${product.currency} ${product.price} · Доставка: ${product.pricing.shippingUsd} USD · Твой процент: ${product.pricing.markupUsd} USD</p>
        </div>
        <p class="discount">-${discountPercent(product.price, product.oldPrice)}%</p>
      </div>
      <div class="product-tags">
        <span>${product.category}</span>
        <span>${formatAvailability(product.availability)}</span>
        <span>вес: ${product.weightKg} кг (${product.weightSource === "estimate" ? "оценка" : "источник"})</span>
        <span>${product.sizes?.length ? `размеры: ${product.sizes.join(", ")}` : product.sizeNote}</span>
      </div>
      <p class="note">${product.marginNote}</p>
      <div class="draft">${buildChannelPreview(product)}</div>
      <div class="product-actions">
        <button class="small-button queue-action" data-id="${product.id}">В очередь</button>
        <button class="small-button publish-action" data-id="${product.id}">Опубликовать</button>
        <button class="small-button muted-button skip-action" data-id="${product.id}">Пропустить</button>
      </div>
      <div class="product-footer">
        <a href="${product.productUrl}" target="_blank" rel="noreferrer">Открыть товар</a>
        <span>Проверено: ${formatDate(product.lastCheckedAt)}</span>
      </div>
    `;
    elements.productList.append(card);
  }

  const queuedProducts = state.queue
    .map((id) => state.products.find((product) => product.id === id))
    .filter(Boolean);

  if (queuedProducts.length === 0) {
    elements.queueList.innerHTML = '<p class="queue-empty">Пока очередь пустая.</p>';
  } else {
    for (const product of queuedProducts) {
      const item = document.createElement("article");
      item.className = "queue-item";
      item.innerHTML = `
        <div>
          <strong>${product.title}</strong>
          <p>${product.sourceName} · ${formatRub(product.pricing.clientPriceRub)} · ${product.weightKg} кг</p>
        </div>
        <button class="small-button publish-action" data-id="${product.id}">Опубликовать</button>
      `;
      elements.queueList.append(item);
    }
  }

  bindProductActions();
}

function matchesFilters(product) {
  if (filters.sourceId !== "all" && product.sourceId !== filters.sourceId) {
    return false;
  }

  if (filters.status !== "all" && product.status !== filters.status) {
    return false;
  }

  if (discountPercent(product.price, product.oldPrice) < filters.minDiscount) {
    return false;
  }

  if (filters.sizesOnly && !(product.sizes && product.sizes.length > 0)) {
    return false;
  }

  return true;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function discountPercent(price, oldPrice) {
  if (!oldPrice || oldPrice <= price) {
    return 0;
  }

  return Math.round(((oldPrice - price) / oldPrice) * 100);
}

function formatAvailability(value) {
  switch (value) {
    case "in_stock":
      return "в наличии";
    case "check_shipping":
      return "проверить доставку";
    default:
      return "статус уточняется";
  }
}

function formatRub(value) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(value);
}

function buildChannelPreview(product) {
  return [
    product.title,
    product.sourceName,
    product.sizes?.length ? `Размеры: ${product.sizes.join(", ")}` : "Размеры уточняются",
    `Цена: ${formatRub(product.pricing.clientPriceRub)}`,
    "Для заказа пишите в личные сообщения."
  ].join("\n");
}

function bindProductActions() {
  document.querySelectorAll(".queue-action").forEach((button) => {
    button.addEventListener("click", () => runProductAction(button, "queue"));
  });

  document.querySelectorAll(".publish-action").forEach((button) => {
    button.addEventListener("click", () => runProductAction(button, "publish"));
  });

  document.querySelectorAll(".skip-action").forEach((button) => {
    button.addEventListener("click", () => runProductAction(button, "skip"));
  });
}

async function runProductAction(button, action) {
  const productId = button.dataset.id;
  button.disabled = true;

  try {
    const response = await fetch("/api/product-action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ productId, action })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось выполнить действие");
    }

    await loadState();
    showMessage(actionLabel(action));
  } catch (error) {
    showMessage(error.message || "Ошибка действия", "error");
  } finally {
    button.disabled = false;
  }
}

async function runImportAction(button, url, idleLabel, successMessage) {
  button.disabled = true;
  button.textContent = "Импорт...";
  showMessage(`Запускаю ${idleLabel.toLowerCase()}...`);

  try {
    const response = await fetch(url, { method: "POST" });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось импортировать товары");
    }

    await loadState();
    showMessage(successMessage);
  } catch (error) {
    showMessage(error.message || "Ошибка импорта", "error");
  } finally {
    button.disabled = false;
    button.textContent = idleLabel;
  }
}

function showMessage(text, tone = "info") {
  elements.uiMessage.textContent = text;
  elements.uiMessage.className = `ui-message is-${tone}`;
}

function actionLabel(action) {
  switch (action) {
    case "queue":
      return "Товар добавлен в очередь.";
    case "publish":
      return "Товар опубликован в Telegram.";
    case "skip":
      return "Товар пропущен и больше не будет мешать в импорте.";
    default:
      return "Действие выполнено.";
  }
}
