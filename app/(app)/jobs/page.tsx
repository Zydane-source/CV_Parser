import { JobsMonitor } from "@/components/JobsMonitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Processing" };

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ batchId?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Processing</h1>
        <p className="text-sm text-gray-500">Live status of background parsing jobs. Failed CVs can be retried individually or in bulk.</p>
      </div>
      <JobsMonitor initialBatchId={sp.batchId} />
    </div>
  );
}
