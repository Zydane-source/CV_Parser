import { getSettings } from "@/lib/settings";
import { CandidatesTable } from "@/components/CandidatesTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "Candidates" };

export default async function CandidatesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const [settings, sp] = await Promise.all([getSettings(), searchParams]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Candidates</h1>
        <p className="text-sm text-gray-500">Search, filter, review and correct extracted candidate information.</p>
      </div>
      <CandidatesTable threshold={settings.confidenceThreshold} initialStatus={sp.status} />
    </div>
  );
}
