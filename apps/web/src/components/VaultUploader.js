'use client';
import { useState } from 'react';
import { uploadVaultFile } from '@/app/actions';
import { useRouter } from 'next/navigation';

export default function VaultUploader({ vaultId }) {
    const [uploading, setUploading] = useState(false);
    const router = useRouter();

    const handleUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        const formData = new FormData();
        formData.append('file', file);

        // We can ask for summary too? Logic simplified for now.
        // Server creates summary automatically on ingestion? 
        // Agent tool `addToVault` requires summary.
        // VaultManager logic: createVaultFile -> just saves. 
        // Agent logic: `addToVault` tool calls `ingestFile`.
        // Wait, the API `/v1/vaults/:id/files` just calls `vaults.addToVault(id, path, originalName)`.
        // `VaultManager.addToVault` copies file. 
        // Does it trigger context update/summary? 
        // `VaultManager` has `ingestFile`? No.
        // `VaultExecutor` has `addToVault` tool which DOES update wiki.
        // But the API calls `agent.vaults.addToVault` directly (in `routes/vaults.js`).
        // `VaultManager` (in `src/vault-manager.js`) needs to be checked.

        // If `VaultManager.addToVault` is low-level file copy, then the "AI moves file and summarizes" part is skipped.
        // Review `VaultManager.addToVault` implementation from previous context.
        // If it's just file copy, we are missing the "Auto-Context/Summary" feature for UI uploads.
        // For now, let's implement basic upload.

        try {
            const res = await uploadVaultFile(vaultId, formData);
            if (!res.success) {
                alert('Upload failed: ' + res.error);
            } else {
                router.refresh(); // Refresh file list
            }
        } catch (err) {
            alert('Upload error: ' + err.message);
        } finally {
            setUploading(false);
            e.target.value = null; // Reset input
        }
    };

    return (
        <div className="flex items-center gap-2">
            <label className={`cursor-pointer px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {uploading ? 'Uploading...' : 'Upload File'}
                <input type="file" className="hidden" onChange={handleUpload} disabled={uploading} />
            </label>
        </div>
    );
}
