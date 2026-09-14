import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { UserManager } from "@/components/admin/UserManager";

export const dynamic = "force-dynamic";

/**
 * Team — an administrator managing their own client.
 *
 * A platform owner with no workspace of their own is sent to /clients instead:
 * "your team" has nothing to show them.
 */
export default async function TeamPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role === "OWNER" && !user.workspaceId) redirect("/clients");
  if (user.role !== "ADMIN" && user.role !== "OWNER") redirect("/");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description={
          user.workspaceName
            ? `Who can sign in to ${user.workspaceName} and what they are allowed to do.`
            : "Who can sign in and what they are allowed to do."
        }
      />
      <UserManager />
    </div>
  );
}
