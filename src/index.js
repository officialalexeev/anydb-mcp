#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdapterRegistry, TimeoutError, DEFAULT_TIMEOUT } from './core/registry.js';
import { maskUri, describeQuery, log, logQueryDetail, isDebugEnabled } from './core/logging.js';
import { installShutdownHandlers } from './core/connection-cache.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

const registry = new AdapterRegistry();
registry.cache.start();
installShutdownHandlers(registry.cache, log);

const server = new Server({
  name: "anydb-mcp",
  version,
}, {
  capabilities: { tools: {} },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "db_query",
      description:
        "Executes a query against any database. Automatically detects type from URI. " +
        "Runs read-only by default: writes and destructive statements are rejected " +
        "unless readOnly is set to false. Always returns an array; non-SELECT " +
        "statements return a single status object. For MongoDB use the action " +
        "argument to choose between find, count, distinct, aggregate, insert, " +
        "update and delete.",
      inputSchema: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description: "Connection string (e.g., postgres://user:pass@host:5432/db, mysql://..., sqlite:///path.db, mongodb://..., redis://...)"
          },
          query: {
            type: "string",
            description: "SQL, MongoDB filter (JSON), MongoDB aggregation pipeline (JSON array), or Redis command. One statement only."
          },
          collection: {
            type: "string",
            description: "Required for MongoDB: the collection to query."
          },
          action: {
            type: "string",
            enum: ["find", "count", "distinct", "aggregate", "explain", "insert", "update", "delete"],
            description: "MongoDB only. Defaults to find. insert, update and delete require readOnly: false."
          },
          update: {
            type: "string",
            description: "MongoDB only. The update document (JSON) for the update action, for example {\"$set\":{\"seen\":true}}."
          },
          field: {
            type: "string",
            description: "MongoDB only. The field name for the distinct action."
          },
          sort: {
            type: "string",
            description: "MongoDB only. Sort document (JSON) for find, for example {\"createdAt\":-1}."
          },
          projection: {
            type: "string",
            description: "MongoDB only. Fields to return for find (JSON), for example {\"name\":1,\"email\":1}."
          },
          upsert: {
            type: "boolean",
            description: "MongoDB only. For the update action, insert the document when no match is found."
          },
          allowWriteStages: {
            type: "boolean",
            description: "MongoDB only. Permit the $out and $merge aggregation stages, which replace a collection."
          },
          limit: {
            type: "number",
            description: "MongoDB only: maximum documents to return (default 50, max 1000)."
          },
          readOnly: {
            type: "boolean",
            description: "Defaults to true. Set to false to allow writes and destructive statements."
          },
          timeout: {
            type: "number",
            description: `Query timeout in milliseconds (default: ${DEFAULT_TIMEOUT}ms). Must be between 1 and 86400000.`
          }
        },
        required: ["uri", "query"],
        additionalProperties: false
      }
    },
    {
      name: "db_schema",
      description:
        "Describes the structure of a database: tables and their columns for SQL, " +
        "collections with their indexes for MongoDB, keyspace statistics for Redis. " +
        "Call this before writing a query so table and column names are not guessed. " +
        "This tool only ever runs read-only introspection statements.",
      inputSchema: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description: "Connection string, same schemes as db_query."
          },
          table: {
            type: "string",
            description: "SQL only: describe just this table."
          },
          collection: {
            type: "string",
            description: "MongoDB only: describe just this collection."
          },
          timeout: {
            type: "number",
            description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}ms).`
          }
        },
        required: ["uri"],
        additionalProperties: false
      }
    }
  ],
}));

const QUERY_OPTION_KEYS = [
  'collection', 'action', 'update', 'field', 'sort', 'projection',
  'upsert', 'allowWriteStages', 'limit', 'readOnly', 'timeout',
];
const SCHEMA_OPTION_KEYS = ['table', 'collection', 'timeout'];

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  return request.params.name === 'db_schema'
    ? handleSchema(args)
    : handleQuery(args);
});

async function handleQuery(args) {
  const { uri, query } = args;

  // Logging has to tolerate the same malformed input the handler rejects, or a
  // missing field turns into an internal error before formatError is reached.
  if (typeof uri === 'string') {
    log('db_query', {
      uri: maskUri(uri),
      query: describeQuery(query),
      timeout: args.timeout ?? 'default',
      readOnly: args.readOnly !== false
    });
  } else {
    log('db_query', { uri: `<${typeof uri}>`, error: 'missing or non-string uri' });
  }

  if (typeof uri === 'string') logQueryDetail(uri, query);

  try {
    const data = await registry.run(uri, query, pickOptions(args, QUERY_OPTION_KEYS));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: formatError(error, uri) }],
      isError: true
    };
  }
}

async function handleSchema(args) {
  const { uri } = args;

  if (typeof uri === 'string') {
    log('db_schema', { uri: maskUri(uri), timeout: args.timeout ?? 'default' });
  } else {
    log('db_schema', { uri: `<${typeof uri}>`, error: 'missing or non-string uri' });
  }

  try {
    const data = await registry.describe(uri, pickOptions(args, SCHEMA_OPTION_KEYS));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: formatError(error, uri) }],
      isError: true
    };
  }
}

/** Copy across only the arguments the tool understands. */
function pickOptions(args, keys) {
  const options = {};
  for (const key of keys) {
    if (args[key] !== undefined) options[key] = args[key];
  }
  return options;
}

/**
 * Turn any thrown value into a message an agent can act on: what went wrong,
 * and what to try next.
 */
function formatError(error, uri) {
  const message = error && error.message ? error.message : String(error);
  const scheme = typeof uri === 'string' && uri.includes('://')
    ? uri.slice(0, uri.indexOf('://'))
    : 'database';

  let suggestion;
  if (error instanceof TimeoutError) {
    suggestion = `The server did not respond within the timeout. Narrow the query, add a LIMIT, or raise the "timeout" argument.`;
  } else if (/Read-only mode/i.test(message)) {
    suggestion = `The statement was not executed. If the write is genuinely intended, retry with readOnly: false.`;
  } else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    suggestion = `The ${scheme} server could not be reached. Check the host, port, and that the service is running.`;
  } else if (/Access denied|insufficient privilege|ETIMEDOUT.*auth|password authentication/i.test(message)) {
    suggestion = `Authentication or permissions were rejected. Check the credentials in the URI and the grants for that user.`;
  } else if (/does not exist|Unknown database|Unknown table/i.test(message)) {
    suggestion = `The referenced object does not exist. Inspect the schema before retrying.`;
  } else if (isDebugEnabled()) {
    suggestion = `See stderr for the full stack trace.`;
  } else {
    suggestion = `Check the ${scheme} syntax and that the object exists. Set ANYDB_DEBUG=1 for a full stack trace.`;
  }

  return `DATABASE_ERROR: ${message}\nSUGGESTION: ${suggestion}`;
}

const transport = new StdioServerTransport();
await server.connect(transport);
log('server ready', {
  version,
  debug: isDebugEnabled(),
  cache: registry.cache.enabled
    ? `${registry.cache.maxEntries} conn, ${registry.cache.idleTtlMs}ms idle`
    : 'off'
});
