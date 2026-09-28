# Build, Test, and Publish Guide

This document provides instructions for building, testing, and publishing the `anydb-mcp` package.

## Prerequisites

- Node.js 20.19 or higher
- npm (v9 or higher)
- Git

## 1. Development Setup

Install dependencies:
```bash
npm install
```

## 2. Testing

Run the full test suite (Unit + Integration):
```bash
npm test
```

Generate test coverage report:
```bash
npm test -- --coverage
```

## 3. Preparation for Release

Before publishing, ensure the following:

1.  **Update Version:**
    Update the version in `package.json`.
    ```bash
    npm version patch # or minor, major
    ```

2.  **Clean Project:**
    Ensure `.npmignore` and `.gitignore` are correctly configured to exclude unnecessary files (tests, logs, dev configs).

3.  **Run Tests:**
    Ensure all tests pass on the clean build.

## 4. Publishing to npm

1.  **Login to npm:**
    If you haven't logged in on this machine:
    ```bash
    npm login
    ```

2.  **Publish:**
    ```bash
    npm publish
    ```
    *Note: If the package name is scoped (e.g., `@username/anydb-mcp`), use `npm publish --access public`.*

## 5. Post-Publish Verification

Verify the package is available and works correctly:

```bash
npm view anydb-mcp version
```

To confirm the package starts, run it and send a tool list over stdio. It is an
MCP server, not a CLI, so it has no `--version` flag and will wait on stdin.

## 6. Git Workflow

Push changes to the repository:

```bash
git add .
git commit -m "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```
