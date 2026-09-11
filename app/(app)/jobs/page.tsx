import { JobsMonitor } from "@/components/JobsMonitor";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Processing" };

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ batchId?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Processing" description="Live status of background parsing jobs. Failed CVs can be retried individually or in bulk." />
      </div>
      <JobsMonitor initialBatchId={sp.batchId} />
    </div>
  );
}
