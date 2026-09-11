import Link from "next/link";
import { Cloud } from "lucide-react";
import { getSettings } from "@/lib/settings";
import { UploadDropzone } from "@/components/UploadDropzone";
import { WorkerBanner } from "@/components/WorkerBanner";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload CVs" };

export default async function UploadPage() {
  const settings = await getSettings();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Upload CVs"
        description="Single, multiple or bulk. Files are queued and parsed in the background — one failed CV never blocks the rest."
        actions={
          <Link href="/google-drive" className="btn-secondary">
            <Cloud size={15} /> Import from Drive
          </Link>
        }
      />
      <WorkerBanner />
      <UploadDropzone maxFileSizeMb={settings.maxFileSizeMb} maxFilesPerRequest={settings.maxFilesPerRequest} />
    </div>
  );
}
