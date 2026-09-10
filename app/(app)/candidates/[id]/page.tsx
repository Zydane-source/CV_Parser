import { getSettings } from "@/lib/settings";
import { CandidateDetail } from "@/components/CandidateDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Candidate" };

export default async function CandidatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const [{ id }, sp, settings] = await Promise.all([params, searchParams, getSettings()]);
  return <CandidateDetail id={id} threshold={settings.confidenceThreshold} startEditing={sp.edit === "1"} />;
}
