export class BaseAdapter {
  async connect(uri) { throw new Error("connect() не реализован"); }
  async execute(query, options) { throw new Error("execute() не реализован"); }
  async close() { throw new Error("close() не реализован"); }
}