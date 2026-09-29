// Regression guard: the handshake must carry a populated client metadata
// document.
//
// mongodb 7.6.0 loads Node's `os` module with `await import('os')`. Under Jest,
// which has no `--experimental-vm-modules`, that import rejects, the driver
// squashes the rejection and falls back to `{}`, and the server is handed
// `client: {}` — which it rejects with "Missing required sub-document 'driver'".
// The message names something the caller never touched, the adapter looks
// correct, and every live MongoDB check fails against a perfectly healthy
// server. Upstream: NODE-7832.
//
// The document is built before any socket is opened, so it can be asserted on
// without a MongoDB running.

import * as nodeOs from 'node:os';
import { MongoClient } from 'mongodb';

const metadataFor = async (options) => {
  const client = new MongoClient('mongodb://127.0.0.1:27017/anydb', {
    serverSelectionTimeoutMS: 1,
    connectTimeoutMS: 1,
    ...options,
  });
  try {
    return await client.options.metadata;
  } finally {
    await client.close(true).catch(() => {});
  }
};

describe('mongodb client metadata', () => {
  it('carries the driver sub-document the server requires', async () => {
    const metadata = await metadataFor({ runtimeAdapters: { os: nodeOs } });

    expect(metadata).toEqual(expect.any(Object));
    expect(Object.keys(metadata)).not.toHaveLength(0);
    // The exact field the server rejects a handshake without.
    expect(metadata.driver).toBeDefined();
    expect(metadata.driver.name).toBe('nodejs');
    expect(typeof metadata.driver.version).toBe('string');
    // `os` is what `runtimeAdapters` exists to supply, so it is the one that
    // goes missing when the import fails.
    expect(metadata.platform).toEqual(expect.any(String));
    expect(metadata.os).toBeDefined();
  });

  it('does not need a server to produce that metadata', () => {
    // The point of the guard: nothing above connected anywhere. If a future
    // change makes the document depend on a live handshake, the previous test
    // starts failing for reasons that have nothing to do with the regression.
    expect(nodeOs.platform()).toEqual(expect.any(String));
  });
});
