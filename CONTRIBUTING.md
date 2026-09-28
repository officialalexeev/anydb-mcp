# Contributing

## Setup

```bash
npm install
npm test
```

Node 20.19 or newer is required; that floor comes from the drivers, not a
preference.

## Adding a database

1. Create `src/adapters/<name>.js` extending `BaseAdapter`.
2. Implement `connect(uri)`, `execute(query, options)` and `close()`.
3. Implement `isHealthy()` and `abort()`. `isHealthy()` is what the connection
   cache calls before handing a connection out, so a driver that can check its
   own state should report it there rather than by pinging. `abort()` has to stop
   the in-flight statement; a connection that survives being aborted must not
   be reusable, so set a flag that `isHealthy()` reads.
4. Implement `describe(options)` in `src/core/schema.js` and delegate to it
   from the adapter.
5. Add the scheme to the mapping in `src/core/registry.js`.
6. If the database is not SQL, add it to `inspectQuery` in `src/core/safety.js`
   along with its tests. A protocol the guard does not recognise fails closed.
7. Add a test file named `__tests__/test_<name>_adapter.test.js` and pass the
   driver into the constructor, so the tests need no running server.

## Tests

- One file per module, `*.test.js`.
- Assert on observable behaviour, not on internal calls, except where the call
  itself is the contract (a specific SQL statement, a specific argument).
- A comment should say why an assertion matters. If it only restates the
  assertion, delete it.

## Pull requests

```bash
git checkout -b <short-branch-name>
git commit -m '<what changed>'
git push origin <short-branch-name>
```

CI runs the suite on Node 20, 22 and 24, and fails on a high-severity advisory
in the production dependencies.
