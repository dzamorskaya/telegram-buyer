# Telegram Buyer

Каркас проекта для байера с понятной админкой и заготовкой под автопостинг в Telegram.

## Что уже есть

- локальная админка в браузере;
- список товаров-кандидатов;
- настройки канала и автопостинга;
- API-заготовки под поиск товаров, генерацию постов и публикацию.

## Запуск

```bash
cd /Users/dasha/Documents/Playground/telegram-buyer
npm start
```

После запуска открой:

[http://localhost:3001](http://localhost:3001)

## Постоянная ссылка

Для постоянного доступа проект подготовлен под `Render`.

Что нужно:

1. Загрузить проект в GitHub.
2. Создать в Render новый `Blueprint` или `Web Service`.
3. Подтянуть репозиторий с проектом.
4. Указать переменные окружения:
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHANNEL_ID`
5. После деплоя Render выдаст постоянную ссылку вида `https://...onrender.com`

В проект уже добавлен файл [render.yaml](/Users/dasha/Documents/Playground/telegram-buyer/render.yaml), поэтому Render может поднять сервис с готовыми настройками.

## Следующий этап

Дальше можно подключить реальные источники товаров, Telegram Bot API и OpenAI для генерации постов.
