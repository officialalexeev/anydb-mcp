# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-04-13

### Added
- **Query timeout system** — multi-layer protection against hanging database queries
  - Global operation timeout (`timeout` parameter in `db_query`)
  - Database connection timeout (5 seconds by default)
  - Query execution timeout (30 seconds by default)
- **`TimeoutError` class** — specialized error for timeout operations
- **`withTimeout()` utility** — Promise wrapper with timeout support
- **`callbackWithTimeout()` utility** — wrapper for callback-based operations
- **AbortController** for SQLite operations
- **Database-specific timeout handling** for each adapter:
  - PostgreSQL: `SET statement_timeout`
  - MySQL: `timeout` parameter in query
  - MongoDB: `maxTimeMS()` in query
  - SQLite: Promise.race with AbortController
  - Redis: `socket.timeout` in configuration

### Changed
- All adapters now accept `timeout` parameter in constructor
- `AdapterRegistry.run()` wraps entire operation in global timeout
- MCP server now returns human-readable messages on timeouts
- Improved connection error handling for all adapters

### Documentation
- Added timeout configuration guide (`docs/timeout-configuration.md`)

### Tests
- Added `test_timeout_handling.js` — 8 tests for timeout utilities
- Updated all adapter tests to work with new constructors
- Added timeout error handling tests for each database
- Total tests: **78 passed, 3 skipped**

---

## [1.0.0] — 2026-04-XX

### Added
- Initial release of AnyDB MCP Server
- Support for 5 databases: PostgreSQL, MySQL, SQLite, MongoDB, Redis
- Adapter pattern for universal interface
- Dependency Injection for testability
- Zero-config approach
- CI/CD via GitHub Actions
- 59 unit tests
