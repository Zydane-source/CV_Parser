import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getSession();
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Settings" description="Extraction, Google Drive, Google Sheets, processing, file limits, retries and confidence threshold." />
      </div>
      <SettingsForm isAdmin={user?.role === "ADMIN"} />
    </div>
  );
}
