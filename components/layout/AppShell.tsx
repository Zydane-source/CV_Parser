"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu, Search } from "lucide-react";
import { Sidebar } from "./Sidebar";

/**
 * The application shell: fixed sidebar, sticky header, scrolling content.
 *
 * The header exists because the product had none — every page rendered its own
 * title inside the content well, so there was no persistent place for the
 * things that belong to the app rather than the page.
 *
 * It carries only controls that actually work. Search routes to the candidates
 * page, which is the one search the backend implements; there is no bell icon,
 * because there are no notifications to show behind it.
 */
const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, "Dashboard"],
  [/^\/upload/, "Upload CVs"],
  [/^\/candidates\/[^/]+$/, "Candidate"],
  [/^\/candidates/, "Candidates"],
  [/^\/jobs/, "Processing"],
  [/^\/google-drive/, "Google Drive"],
  [/^\/settings/, "Settings"],
];

function titleFor(pathname: string): string {
  return TITLES.find(([re]) => re.test(pathname))?.[1] ?? "CV Parser";
}

export function AppShell({
  user,
  children,
}: {
  user: { name: string; email: string; role: string };
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const [q, setQ] = useState("");
  const pathname = usePathname();
  const router = useRouter();

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    router.push(term ? `/candidates?q=${encodeURIComponent(term)}` : "/candidates");
  };

  return (
    <div className="min-h-screen">
      <Sidebar user={user} open={navOpen} onClose={() => setNavOpen(false)} />

      <div className="lg:pl-[var(--sidebar-w)]">
        <header className="sticky top-0 z-30 flex h-[var(--header-h)] items-center gap-3 border-b border-[var(--border)] bg-white/85 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="btn-tertiary btn-sm -ml-1 lg:hidden"
            aria-label="Open navigation"
            aria-controls="app-sidebar"
            aria-expanded={navOpen}
          >
            <Menu size={18} />
          </button>

          <h2 className="truncate text-sm font-semibold text-ink-900 lg:hidden">{titleFor(pathname)}</h2>

          <form onSubmit={submitSearch} role="search" className="ml-auto hidden w-full max-w-sm lg:ml-0 lg:block">
            <label htmlFor="global-search" className="sr-only">
              Search candidates
            </label>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
              <input
                id="global-search"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search candidates by name, phone or role…"
                className="field h-9 py-0 pl-9 text-[0.8125rem]"
              />
            </div>
          </form>

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <span className="hidden text-right sm:block">
              <span className="block text-[0.8125rem] font-medium leading-tight text-ink-900">{user.name}</span>
              <span className="block text-[0.6875rem] leading-tight text-ink-500">{user.role.toLowerCase()}</span>
            </span>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-[88rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
