const { AdapterRegistry } = require('../src/core/registry.js');

// Эти тесты требуют запущенных экземпляров баз данных
// Для настоящего интеграционного тестирования
describe('Integration Tests', () => {
  let registry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  // Заглушка для тестирования PostgreSQL (требует запущенный PostgreSQL)
  describe.skip('PostgreSQL Integration', () => {
    test('should connect and query PostgreSQL database', async () => {
      const uri = process.env.POSTGRES_TEST_URI || 'postgres://username:password@localhost:5432/testdb';
      const query = 'SELECT 1 as test_value';

      const result = await registry.run(uri, query);

      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty('test_value');
      expect(result[0].test_value).toBe(1);
    });
  });

  // Заглушка для тестирования MongoDB (требует запущенный MongoDB)
  describe.skip('MongoDB Integration', () => {
    test('should connect and query MongoDB database', async () => {
      const uri = process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/testdb';
      const query = '{}'; // Пустой фильтр для получения документов
      const options = { collection: 'test_collection' };

      // Создаем тестовую коллекцию и документ перед тестом

      const result = await registry.run(uri, query, options);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  // Заглушка для тестирования SQLite (пропускаем из-за особенностей SQLite в памяти)
  describe.skip('SQLite Integration', () => {
    test('should connect and query SQLite database', async () => {
      // Используем временную базу данных в памяти
      const uri = 'sqlite://:memory:';
      const createTableQuery = `
        CREATE TABLE test_table (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
      `;
      const insertQuery = "INSERT INTO test_table (name) VALUES ('test_record');";
      const selectQuery = 'SELECT * FROM test_table';

      // Сначала создаем таблицу
      await expect(registry.run(uri, createTableQuery)).resolves.toBeDefined();

      // Затем вставляем данные
      await expect(registry.run(uri, insertQuery)).resolves.toBeDefined();

      // Затем выполняем запрос на выборку
      const result = await registry.run(uri, selectQuery);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('name');
      expect(result[0].name).toBe('test_record');
    });
  });

  // Комплексный тест: проверка правильности выбора адаптера по URI
  test('should correctly route to appropriate adapter based on URI protocol', () => {
    expect(registry.extractProtocol('postgres://test')).toBe('postgres');
    expect(registry.extractProtocol('postgresql://test')).toBe('postgresql');
    expect(registry.extractProtocol('mongodb://test')).toBe('mongodb');
    expect(registry.extractProtocol('sqlite://test')).toBe('sqlite');
    expect(registry.extractProtocol('redis://test')).toBe('redis');
    expect(registry.extractProtocol('mysql://test')).toBe('mysql');
  });
});