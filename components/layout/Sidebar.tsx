"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Cloud,
  FileText,
  LayoutDashboard,
  LogOut,
  Settings,
  Upload,
  Users,
  X,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { Avatar, cx } from "@/components/ui";

/**
 * Primary navigation.
 *
 * Grouped rather than a flat list: "Intake" is the daily work, "Configure" is
 * occasional. Six undifferentiated links make every destination look equally
 * likely, which is exactly what a recruiter does not need at nine in the morning.
 */
const GROUPS: Array<{ label: string | null; items: Array<{ href: string; label: string; icon: typeof Users }> }> = [
  {
    label: null,
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Intake",
    items: [
      { href: "/upload", label: "Upload CVs", icon: Upload },
      { href: "/candidates", label: "Candidates", icon: Users },
      { href: "/jobs", label: "Processing", icon: Activity },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/google-drive", label: "Google Drive", icon: Cloud },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({
  user,
  open,
  onClose,
}: {
  user: { name: string; email: string; role: string };
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  // Navigating on mobile should close the drawer; otherwise the new page is
  // hidden behind the menu the user just used.
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const logout = async () => {
    setSigningOut(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <>
      {/* Scrim, mobile only. */}
      <div
        className={cx(
          "fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-[1px] transition-opacity duration-200 lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />

      <aside
        id="app-sidebar"
        aria-label="Main navigation"
        className={cx(
          "fixed inset-y-0 left-0 z-50 flex w-[var(--sidebar-w)] flex-col border-r border-[var(--border)] bg-white",
          "transition-transform duration-200 ease-out lg:translate-x-0",
          open ? "translate-x-0 shadow-[var(--shadow-overlay)]" : "-translate-x-full lg:shadow-none",
        )}
      >
        <div className="flex h-[var(--header-h)] items-center gap-2.5 border-b border-[var(--border)] px-4">
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="CV Parser home">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white shadow-[var(--shadow-card)]">
              <FileText size={16} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[0.8125rem] font-semibold text-ink-900">CV Parser</span>
              <span className="block truncate text-[0.6875rem] leading-tight text-ink-500">Recruitment intake</span>
            </span>
          </Link>
          <button type="button" onClick={onClose} className="btn-tertiary btn-sm ml-auto lg:hidden" aria-label="Close navigation">
            <X size={16} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {GROUPS.map((group, gi) => (
            <div key={group.label ?? gi} className={cx(gi > 0 && "mt-5")}>
              {group.label && (
                <div className="mb-1.5 px-3 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-ink-400">{group.label}</div>
              )}
              <ul className="space-y-0.5">
                {group.items.map(({ href, label, icon: Icon }) => {
                  const active = isActivePath(pathname, href);
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        aria-current={active ? "page" : undefined}
                        className={cx(
                          "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-100",
                          active ? "bg-brand-50 text-brand-700" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
                        )}
                      >
                        {/* A bar as well as a tint: the active item stays obvious
                            for anyone who cannot separate those two colours. */}
                        {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-brand-600" aria-hidden />}
                        <Icon size={16} className={active ? "text-brand-600" : "text-ink-400 group-hover:text-ink-600"} />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-[var(--border)] p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <Avatar name={user.name} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.8125rem] font-medium text-ink-900">{user.name}</div>
              <div className="truncate text-[0.6875rem] text-ink-500">{user.email}</div>
            </div>
          </div>
          <button onClick={logout} disabled={signingOut} className="btn-tertiary btn-sm mt-1 w-full justify-start">
            <LogOut size={14} /> {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </aside>
    </>
  );
}
