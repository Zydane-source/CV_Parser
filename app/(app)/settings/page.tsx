import { getSession } from "@/lib/auth";
import { SettingsForm } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getSession();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500">LLM, Google Drive, Google Sheets, processing, file limits, retries and confidence threshold.</p>
      </div>
      <SettingsForm isAdmin={user?.role === "ADMIN"} />
    </div>
  );
}
