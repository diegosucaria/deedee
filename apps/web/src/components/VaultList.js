'use client';
import { useRouter } from 'next/navigation';
import { createVault, deleteVault } from '@/app/actions';

export default function VaultList({ vaults }) {
    const router = useRouter();

    const handleCreate = async () => {
        const topic = prompt("Enter topic for new vault (e.g., 'Health', 'Travel')");
        if (!topic) return;

        const res = await createVault(topic);
        if (res.success) {
            router.refresh();
        } else {
            alert("Failed to create: " + res.error);
        }
    };

    const handleDelete = async (e, id) => {
        e.stopPropagation(); // Prevent card click
        if (!confirm(`Are you sure you want to permanently delete the vault "${id}" and all its files?`)) {
            return;
        }

        const res = await deleteVault(id);
        if (res.success) {
            router.refresh();
        } else {
            alert("Failed to delete: " + res.error);
        }
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Create Card */}
            <div
                onClick={handleCreate}
                className="flex flex-col items-center justify-center p-8 bg-dashed border-2 border-gray-300 border-dashed rounded-xl hover:border-blue-500 hover:bg-blue-50 cursor-pointer transition-all group"
            >
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3 group-hover:bg-blue-100 transition-colors">
                    <span className="text-2xl text-gray-400 group-hover:text-blue-500">+</span>
                </div>
                <span className="font-medium text-gray-500 group-hover:text-blue-600">Create New Vault</span>
            </div>

            {/* Existing Vaults */}
            {vaults.map((vault) => (
                <div
                    key={vault.id}
                    onClick={() => router.push(`/vaults/${vault.id}`)}
                    className="relative flex flex-col p-6 bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:border-blue-300 transition-all cursor-pointer group"
                >
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-xl font-bold text-gray-800 capitalize">{vault.id}</h3>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full">
                            {vault.filesCount || 0} files
                        </span>
                    </div>
                    <p className="text-sm text-gray-500 line-clamp-3 mb-2">
                        Click to view knowledge base.
                    </p>

                    {/* Delete Button (Visible on Hover) */}
                    <button
                        onClick={(e) => handleDelete(e, vault.id)}
                        className="absolute top-2 right-2 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete Vault"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                        </svg>
                    </button>
                </div>
            ))}
        </div>
    );
}
