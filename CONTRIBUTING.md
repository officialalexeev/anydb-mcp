# Contributing to AnyDB MCP

Thank you for your interest in contributing! We welcome pull requests, bug reports, and feature requests.

## Development Setup

1.  **Fork and Clone** the repository.
2.  **Install Dependencies:**
    ```bash
    npm install
    ```
3.  **Run Tests:**
    Ensure everything is working before you start.
    ```bash
    npm test
    ```

## Adding a New Database Adapter

To add support for a new database (e.g., Cassandra, MSSQL):

1.  Create a new file in `src/adapters/` (e.g., `mssql.js`).
2.  Extend the `BaseAdapter` class.
3.  Implement `connect`, `execute`, and `close` methods.
4.  Register the new adapter in `src/core/registry.js`.
5.  Add unit tests in `__tests__/`.

## Pull Request Process

1.  Create a feature branch (`git checkout -b feature/amazing-feature`).
2.  Commit your changes (`git commit -m 'Add some amazing feature'`).
3.  Push to the branch (`git push origin feature/amazing-feature`).
4.  Open a Pull Request.

## Coding Standards

-   Use ES Modules (`import`/`export`).
-   Ensure all tests pass.
-   Keep dependencies to a minimum.
