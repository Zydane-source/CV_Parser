import { DriveConnect } from "@/components/DriveConnect";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Google Drive" };

export default async function GoogleDrivePage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Google Drive" description="Connect a Drive folder and new CVs are detected and parsed automatically." />
      </div>
      <DriveConnect flash={{ connected: sp.connected === "1", error: sp.error }} />
    </div>
  );
}
