'use client';
import { useRouter } from 'next/navigation';
import { createVault } from '@/app/actions';

export default function VaultList({ vaults }) {
    const router = useRouter();

    const handleCreate = async () => {
        const topic = prompt("Enter topic for new vault (e.g., 'Health', 'Travel')");
        if (!topic) return;

        const res = await createVault(topic);
        if (res.success) {
            // Refresh or Navigate? 
            // revalidatePath in action handles list refresh? 
            // Wait, revalidatePath happens on server, but client needs to see new data. 
            // If this is a Client Component iterating props passed from Server Page, we need router.refresh()
            router.refresh();
        } else {
            alert("Failed to create: " + res.error);
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
                    className="flex flex-col p-6 bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:border-blue-300 transition-all cursor-pointer"
                >
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-xl font-bold text-gray-800 capitalize">{vault.id}</h3>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full">
                            {vault.filesCount || 0} files
                        </span>
                    </div>
                    <p className="text-sm text-gray-500 line-clamp-3">
                        {/* Summary snippet? Not provided by API list endpoint yet usually. */}
                        Click to view knowledge base.
                    </p>
                </div>
            ))}
        </div>
    );
}
