import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { UserManager } from "@/components/admin/UserManager";

export const dynamic = "force-dynamic";

/**
 * Team — an administrator managing their own client.
 *
 * The platform owner is sent to /clients instead: they have no workspace of
 * their own, so "your team" has nothing to show them.
 */
export default async function TeamPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role === "OWNER") redirect("/clients");
  if (user.role !== "ADMIN") redirect("/");

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
