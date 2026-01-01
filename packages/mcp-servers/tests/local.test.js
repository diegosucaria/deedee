const { LocalTools } = require('../src/local/index');
const fs = require('fs/promises');
const path = require('path');

// We will test against the local filesystem of the test runner (tmp dir)
// to avoid mocking everything and ensuring real file ops work.

describe('LocalTools', () => {
  let tools;
  let tmpDir;

  beforeAll(async () => {
    tmpDir = path.join(__dirname, 'tmp_test');
    await fs.mkdir(tmpDir, { recursive: true });
    tools = new LocalTools(tmpDir);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('writeFile and readFile', async () => {
    const filename = 'hello.txt';
    const content = 'Hello World';

    await tools.writeFile(filename, content);
    const readBack = await tools.readFile(filename);

    expect(readBack).toBe(content);
  });

  test('listDirectory', async () => {
    const files = await tools.listDirectory('.');
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hello.txt', type: 'file' })
    ]));
  });

  test('runShellCommand: allowed command (echo)', async () => {
    const res = await tools.runShellCommand('echo test');
    expect(res.stdout.trim()).toBe('test');
  });

  test('runShellCommand: blocked command (fake_interactive)', async () => {
    await expect(tools.runShellCommand('nano file.txt'))
      .rejects.toThrow(/not allowed/);
  });

  test('runShellCommand: error handling (ls non-existent)', async () => {
    const res = await tools.runShellCommand('ls non_existent_file');
    expect(res.error).toBe(true);
    expect(res.stderr).toContain('No such file');
  });
});
