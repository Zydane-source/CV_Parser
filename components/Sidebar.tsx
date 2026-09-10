"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { LayoutDashboard, Upload, Users, Activity, Cloud, Settings, LogOut, FileText } from "lucide-react";
import { api } from "@/lib/client/api";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/upload", label: "Upload CVs", icon: Upload },
  { href: "/candidates", label: "Candidates", icon: Users },
  { href: "/jobs", label: "Processing", icon: Activity },
  { href: "/google-drive", label: "Google Drive", icon: Cloud },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ user }: { user: { name: string; email: string; role: string } }) {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
          <FileText size={18} />
        </div>
        <div>
          <div className="text-sm font-semibold text-gray-900">CV Parser</div>
          <div className="text-[11px] text-gray-500">Recruitment intake</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-gray-200 px-4 py-4">
        <div className="truncate text-sm font-medium text-gray-900">{user.name}</div>
        <div className="truncate text-xs text-gray-500">{user.email}</div>
        <button onClick={logout} className="mt-3 flex items-center gap-2 text-xs font-medium text-gray-500 hover:text-gray-900">
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </aside>
  );
}
