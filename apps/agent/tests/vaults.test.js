const fs = require('fs');
const path = require('path');
const VaultManager = require('../src/vault-manager');

// Mock data directory
const TEST_DATA_DIR = path.join(__dirname, 'test_data_vaults');

describe('VaultManager', () => {
    let vaultManager;

    beforeEach(async () => {
        // Cleanup and init
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
        }
        vaultManager = new VaultManager(TEST_DATA_DIR);
        await vaultManager.initialize();
    });

    afterEach(() => {
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
        }
    });

    test('should initialize and create default vaults', async () => {
        const vaults = await vaultManager.listVaults();
        expect(vaults.length).toBeGreaterThanOrEqual(2);
        const ids = vaults.map(v => v.id);
        expect(ids).toContain('health');
        expect(ids).toContain('finance');
    });

    test('should create a new vault', async () => {
        const id = await vaultManager.createVault('travel');
        expect(id).toBe('travel');

        const vaults = await vaultManager.listVaults();
        expect(vaults.map(v => v.id)).toContain('travel');

        expect(fs.existsSync(path.join(TEST_DATA_DIR, 'vaults/travel/index.md'))).toBe(true);
    });

    test('should read and write vault pages', async () => {
        await vaultManager.createVault('notes');
        const content = '# My Notes\nHello World';

        await vaultManager.updateVaultPage('notes', 'index.md', content);
        const readBack = await vaultManager.readVaultPage('notes', 'index.md');
        expect(readBack).toBe(content);

        // New page
        await vaultManager.updateVaultPage('notes', 'todo.md', '- Item 1');
        const todo = await vaultManager.readVaultPage('notes', 'todo.md');
        expect(todo).toBe('- Item 1');
    });

    test('should add file to vault', async () => {
        await vaultManager.createVault('docs');

        // Create dummy source file
        const sourceFile = path.join(TEST_DATA_DIR, 'source.txt');
        fs.writeFileSync(sourceFile, 'Source content');

        const targetPath = await vaultManager.addToVault('docs', sourceFile, 'renamed.txt');

        expect(targetPath).toContain('vaults/docs/files/renamed.txt');
        expect(fs.existsSync(targetPath)).toBe(true);
        expect(fs.readFileSync(targetPath, 'utf8')).toBe('Source content');

        const files = await vaultManager.listVaultFiles('docs');
        expect(files).toContain('renamed.txt');
    });

    test('should sanitize vault names', async () => {
        const id = await vaultManager.createVault('My Cool Stuff!');
        expect(id).toBe('my-cool-stuff');
        expect(fs.existsSync(path.join(TEST_DATA_DIR, 'vaults/my-cool-stuff'))).toBe(true);
    });

    test('should delete a vault', async () => {
        await vaultManager.createVault('temp-vault');
        expect(fs.existsSync(path.join(TEST_DATA_DIR, 'vaults/temp-vault'))).toBe(true);

        const result = await vaultManager.deleteVault('temp-vault');
        expect(result).toBe(true);
        expect(fs.existsSync(path.join(TEST_DATA_DIR, 'vaults/temp-vault'))).toBe(false);
    });

    test('should throw error when deleting non-existent vault', async () => {
        await expect(vaultManager.deleteVault('non-existent')).rejects.toThrow("Vault 'non-existent' does not exist.");
    });

    test('should read a specific file from vault', async () => {
        await vaultManager.createVault('research');
        const sourceFile = path.join(TEST_DATA_DIR, 'source.txt');
        fs.writeFileSync(sourceFile, 'Important data');

        await vaultManager.addToVault('research', sourceFile, 'data.txt');

        const content = await vaultManager.readVaultFile('research', 'data.txt');
        expect(content).toBe('Important data');

        const nonExistent = await vaultManager.readVaultFile('research', 'missing.txt');
        expect(nonExistent).toBeNull();
    });

    test('should prevent vault path traversal', async () => {
        await vaultManager.createVault('secure');
        // This should just read 'passwd' from inside the vault (which doesn't exist) 
        // effectively sanitizing the path, rather than throwing/reading real /etc/passwd
        const content = await vaultManager.readVaultFile('secure', '../../../../etc/passwd');

        // Since it sanitizes to just 'passwd' inside the vault, it should return null (file not found)
        // proving it didn't traverse. 
        expect(content).toBeNull();
    });

    test('should delete a vault file', async () => {
        await vaultManager.createVault('files-test');
        const sourceFile = path.join(TEST_DATA_DIR, 'source.txt');
        fs.writeFileSync(sourceFile, 'Delete me');
        await vaultManager.addToVault('files-test', sourceFile, 'to-delete.txt');

        const result = await vaultManager.deleteVaultFile('files-test', 'to-delete.txt');
        expect(result).toBe(true);
        expect(fs.existsSync(path.join(TEST_DATA_DIR, 'vaults/files-test/files/to-delete.txt'))).toBe(false);
    });

    test('should throw error when deleting non-existent file', async () => {
        await vaultManager.createVault('files-test-2');
        await expect(vaultManager.deleteVaultFile('files-test-2', 'missing.txt'))
            .rejects.toThrow("File 'missing.txt' not found");
    });
});
