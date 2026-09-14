import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, PageHeader } from "@/components/ui";
import { ClientActivity } from "@/components/admin/ClientActivity";
import { UserManager } from "@/components/admin/UserManager";

export const dynamic = "force-dynamic";

/**
 * One client, for the platform owner: CVs fetched by date and time, then the
 * people who can sign in to it.
 */
export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OWNER") redirect("/");

  const { id } = await params;
  const ws = await prisma.workspace.findUnique({ where: { id }, select: { id: true, name: true, slug: true, isActive: true, createdAt: true } });
  if (!ws) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/clients" className="btn-tertiary btn-sm -ml-2 mb-2">
          <ArrowLeft size={14} /> All clients
        </Link>
        <PageHeader
          title={ws.name}
          description={`Handle ${ws.slug} · client since ${ws.createdAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`}
          actions={<Badge tone={ws.isActive ? "success" : "neutral"}>{ws.isActive ? "Active" : "Suspended"}</Badge>}
        />
      </div>

      <ClientActivity workspaceId={ws.id} />

      <div>
        <h2 className="text-section-title mb-3">People</h2>
        <UserManager workspaceId={ws.id} />
      </div>
    </div>
  );
}
