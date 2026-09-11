import Link from "next/link";
import { Upload } from "lucide-react";
import { getSettings } from "@/lib/settings";
import { CandidatesTable } from "@/components/CandidatesTable";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Candidates" };

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const [settings, sp] = await Promise.all([getSettings(), searchParams]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Candidates"
        description="Search, filter, review and correct extracted candidate information."
        actions={
          <Link href="/upload" className="btn-primary">
            <Upload size={15} /> Upload CVs
          </Link>
        }
      />
      <CandidatesTable threshold={settings.confidenceThreshold} initialStatus={sp.status} initialQ={sp.q} />
    </div>
  );
}
