import { getSettings } from "@/lib/settings";
import { UploadDropzone } from "@/components/UploadDropzone";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload CVs" };

export default async function UploadPage() {
  const settings = await getSettings();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Upload CVs</h1>
        <p className="text-sm text-gray-500">Single, multiple or bulk upload. Files are queued and parsed in the background – one failed CV never blocks the rest.</p>
      </div>
      <UploadDropzone maxFileSizeMb={settings.maxFileSizeMb} maxFilesPerRequest={settings.maxFilesPerRequest} />
    </div>
  );
}
