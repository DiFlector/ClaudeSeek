# 🤖 Anthropic-to-DeepSeek Bridge

> Прокси-сервер, превращающий DeepSeek Chat в полностью совместимый с Anthropic API endpoint.

[![Bun](https://img.shields.io/badge/Bun-1.3.5-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![DeepSeek](https://img.shields.io/badge/DeepSeek-API-4A6FA5?logo=deepseek)](https://deepseek.com)

## ✨ Возможности

- 🔄 **Полная совместимость с Anthropic API** — используйте DeepSeek как замену Claude
- 🛠️ **Поддержка инструментов (Tool Use)** — конвертация JSON-ответов в tool_use блоки
- 📡 **Streaming** — SSE-события в реальном времени
- 💾 **Управление сессиями** — сохранение истории диалогов
- 🔐 **Защита API ключа** — опциональная аутентификация через x-api-key
- ⚡ **Высокая производительность** — асинхронная обработка запросов

## 🚀 Быстрый старт

### Установка

```bash
# Клонируйте репозиторий
git clone <repo-url>
cd deepaude

# Установите зависимости
bun install
```

### Настройка

Создайте файл `.env`:

```env
DEEPSEEK_TOKEN=your_deepseek_token_here
PORT=4141
PROXY_API_KEY=optional_secret_key
```

### Запуск

```bash
# Запуск сервера
bun run index.ts

# Или с горячей перезагрузкой
bun --watch run index.ts
```

Сервер запустится на `http://localhost:4141` (или вашем порту)

## 📡 API

### POST /v1/messages

Полностью совместимый с Anthropic Messages API endpoint.

#### Пример запроса:

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_key" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 1000,
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ]
  }'
```

#### Пример с инструментами:

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 1000,
    "messages": [
      {"role": "user", "content": "What's the weather in Tokyo?"}
    ],
    "tools": [
      {
        "name": "get_weather",
        "description": "Get weather for a location",
        "input_schema": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          }
        }
      }
    ]
  }'
```

#### Streaming:

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'
```

### GET /health

Проверка статуса сервиса.

## 🏗️ Архитектура

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Claude     │────▶│   Bridge     │────▶│  DeepSeek   │
│  SDK        │◀────│  (this       │◀────│  API        │
└─────────────┘     └──────────────┘     └─────────────┘
```

Бридж выполняет:
1. Конвертацию Anthropic-формата в промпт DeepSeek
2. Обработку streaming-ответов
3. Парсинг tool calls из текстовых ответов
4. Управление сессиями и историей

## 🔧 Конфигурация

| Переменная | Описание | Значение по умолчанию |
|------------|----------|----------------------|
| `DEEPSEEK_TOKEN` | Токен API DeepSeek | **Обязателен** |
| `PORT` | Порт сервера | `4141` |
| `PROXY_API_KEY` | API ключ для аутентификации | `null` |

## 📁 Структура проекта

```
deepaude/
├── index.ts           # Основной сервер
├── src/
│   ├── client/        # DeepSeek клиент
│   ├── services/      # WASM и PoW сервисы
│   ├── utils/         # Утилиты (логгер, память, производительность)
│   └── config/        # Конфигурации
├── wasm/              # WebAssembly модули
├── data/              # Данные
└── package.json
```

## 🧪 Совместимость

| Anthropic фича | Поддержка |
|----------------|-----------|
| Messages API | ✅ Полная |
| Streaming | ✅ Полная |
| Tool Use | ✅ Полная |
| System prompts | ✅ Полная |
| Multi-turn conversations | ✅ Полная |
| Vision | ⏳ Планируется |

## 🐛 Отладка

Логи сервера выводятся в консоль. Для детальной отладки:

```bash
# Включение verbose логов
DEEPSEEK_DEBUG=true bun run index.ts
```

## 📋 TODO

- Рефакторинг монолита — разбить index.ts на модульные компоненты (маршрутизация, конвертация промптов, обработка стриминга, управление сессиями)
- Продвинутое логирование — внедрить структурное логирование с уровнями (debug/info/error) и ротацией файлов
- Автоматические повторные запросы (retry) — при временных сбоях DeepSeek API с экспоненциальной задержкой
- Кэширование ответов — для повторяющихся запросов с учетом TTL и инвалидацией по контексту
- Метрики и мониторинг — экспорт метрик в Prometheus (латентность, количество запросов, ошибки)
- Валидация входных схем — строгая проверка Anthropic-запросов через Zod или JSON Schema
- Тестирование — юнит-тесты для конвертеров и интеграционные тесты с реальным API

## 🤝 Вклад

PR и Issues приветствуются!
*P. s. Данное `README.md` было написано Deepseek'ом через Claude Code используя данный мост.*

## 📄 Лицензия

MIT

---

⭐ Поставьте звезду, если проект оказался полезен!
