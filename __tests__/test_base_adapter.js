const { BaseAdapter } = require('../src/core/base-adapter.js');

// Mock-класс для тестирования абстрактного класса
class ConcreteAdapter extends BaseAdapter {}

describe('BaseAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new ConcreteAdapter();
  });

  test('connect should throw error when called', async () => {
    await expect(adapter.connect('mock-uri')).rejects.toThrow('connect() не реализован');
  });

  test('execute should throw error when called', async () => {
    await expect(adapter.execute('SELECT * FROM table')).rejects.toThrow('execute() не реализован');
  });

  test('close should throw error when called', async () => {
    await expect(adapter.close()).rejects.toThrow('close() не реализован');
  });
});