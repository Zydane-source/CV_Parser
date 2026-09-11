import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";

export const dynamic = "force-dynamic";

/**
 * The session is resolved on the server and handed to the shell, so the only
 * client component in the chrome is the one that needs interactivity (the mobile
 * drawer and the search box). Pages themselves stay server components.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  return (
    <>
      {/* First stop for keyboard users: skip the nav, reach the content. */}
      <a href="#main" className="sr-only-focusable z-50 m-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white">
        Skip to content
      </a>
      <AppShell user={user}>{children}</AppShell>
    </>
  );
}
