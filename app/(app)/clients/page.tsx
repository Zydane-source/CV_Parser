import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ClientManager } from "@/components/admin/ClientManager";
import { ClientActivity } from "@/components/admin/ClientActivity";
import { SignupRequests } from "@/components/admin/SignupRequests";

export const dynamic = "force-dynamic";

/**
 * Clients — platform owner only.
 *
 * Gated here as well as in the API. The route check is what actually protects
 * the data; this one exists so that someone without the role sees the dashboard
 * rather than an empty page that fails its first fetch.
 */
export default async function ClientsPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OWNER") redirect("/");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clients"
        description="Every client account, how it joined, and the CVs each has fetched. Click a client for its day-by-day history."
      />
      {/* Waiting requests first: they are the only thing here that needs a decision. */}
      <SignupRequests />
      <ClientManager />
      <ClientActivity />
    </div>
  );
}
