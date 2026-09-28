# Тесты

## Запуск

```bash
npm test
npm run test:coverage
npm run verify:package
```

`verify:package` — не повтор `npm test`. Модульные тесты идут по рабочему дереву,
где действует `allowScripts` самого пакета, поэтому не видят поломок, которые
проявляются только после установки. Скрипт пакует тарболл, ставит его в пустой
каталог и запускает установленный сервер как потребитель.

## Состав

Модульные тесты, по одному файлу на модуль:

| Файл | Что проверяет |
|------|---------------|
| `test_base_adapter.test.js` | `withTimeout`, `TimeoutError`, интерфейс `BaseAdapter` |
| `test_timeout_handling.test.js` | `callbackWithTimeout` и снятие таймера |
| `test_registry.test.js` | `AdapterRegistry`: валидация, роутинг, кэш соединений |
| `test_safety.test.js` | Проверка read-only для SQL, Redis и MongoDB |
| `test_connection_cache.test.js` | LRU, TTL, проверка живости, вытеснение |
| `test_schema.test.js` | `db_schema` для пяти адаптеров |
| `test_logging.test.js` | Маскирование URI, отсутствие утечки в лог |
| `test_mysql_adapter.test.js` | Пул, `MAX_EXECUTION_TIME`, разбор ошибок |
| `test_postgres_adapter.test.js` | `statement_timeout` на одном соединении, SQLSTATE |
| `test_sqlite_adapter.test.js` | Событие `error`, `interrupt`, разбор пути |
| `test_redis_adapter.test.js` | Разбор команды, единый путь отправки |
| `test_mongodb_actions.test.js` | Все восемь действий, включая агрегацию |
| `test_mongodb_adapter.test.js` | Жизненный цикл соединения |
| `registry_integration.test.js` | Соответствие схем и протоколов в реестре |
| `server_e2e.test.js` | Сервер как дочерний процесс, оба инструмента |

## Замечания

- Адаптеры принимают драйвер через конструктор, поэтому тесты подменяют его и не
  требуют запущенной базы.
- `server_e2e.test.js` запускает настоящий сервер и работает на SQLite в памяти.
  Благодаря кэшу соединений `:memory:` сохраняет данные между вызовами, поэтому
  в этом файле доступны записи с `readOnly: false`.
- Живая проверка на PostgreSQL, MySQL и MongoDB не автоматизирована: она требует
  доступного сервера, поэтому в CI их нет.
- `test_safety.test.js` проверяет разбор литералов отдельно для каждого диалекта.
  Обратный слэш экранирует кавычку только в MySQL; PostgreSQL и SQLite работают
  с `standard_conforming_strings`, где `\` обычный символ. Если это различие
  убрать, `SELECT 'a\'; DROP TABLE t; --'` снова пройдёт проверку.
