import { DriveConnect } from "@/components/DriveConnect";

export const dynamic = "force-dynamic";
export const metadata = { title: "Google Drive" };

export default async function GoogleDrivePage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Google Drive</h1>
        <p className="text-sm text-gray-500">Connect a Drive folder and new CVs are detected and parsed automatically.</p>
      </div>
      <DriveConnect flash={{ connected: sp.connected === "1", error: sp.error }} />
    </div>
  );
}
