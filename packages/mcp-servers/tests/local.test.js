const path = require('path');
const fs = require('fs/promises');
const { LocalTools } = require('../src/local/index');

describe('LocalTools', () => {
  const testDir = path.resolve(__dirname, 'test_sandbox');
  let tools;

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    tools = new LocalTools(testDir);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('writeFile should create a file with content', async () => {
    await tools.writeFile('hello.txt', 'Hello World');
    const content = await fs.readFile(path.join(testDir, 'hello.txt'), 'utf8');
    expect(content).toBe('Hello World');
  });

  test('readFile should read existing file', async () => {
    const readBack = await tools.readFile('hello.txt');
    expect(readBack).toBe('Hello World');
  });

  test('listDirectory should list created file', async () => {
    const files = await tools.listDirectory('.');
    expect(files.some(f => f.name === 'hello.txt')).toBe(true);
  });

  test('runShellCommand (allowed) should return output', async () => {
    // echo test
    const result = await tools.runShellCommand('echo test');
    expect(result.stdout.trim()).toBe('test');
  });

  test('runShellCommand should block "vi"', async () => {
    await expect(tools.runShellCommand('vi test.txt'))
      .rejects.toThrow(/blocked/);
  });

  test('runShellCommand should block "rm -rf /"', async () => {
    await expect(tools.runShellCommand('rm -rf /'))
      .rejects.toThrow(/blocked/);
  });
});
