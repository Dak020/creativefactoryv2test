import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  Clapperboard,
  CalendarClock,
  LayoutDashboard,
  FolderKanban,
  Film,
  Quote,
  Music,
  AtSign,
  MessageSquareText,
  BarChart3,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const items = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Studio", url: "/studio", icon: Clapperboard },
  { title: "Projects", url: "/projects", icon: FolderKanban },
  { title: "Schedule", url: "/schedule", icon: CalendarClock },

  { title: "Media Library", url: "/media", icon: Film },
  { title: "Hook Library", url: "/hooks", icon: Quote },
  { title: "Caption Library", url: "/captions", icon: MessageSquareText },
  { title: "Audio Library", url: "/audio", icon: Music },
  { title: "Accounts", url: "/accounts", icon: AtSign },
  { title: "Performance", url: "/performance", icon: BarChart3 },
  { title: "Settings", url: "/settings", icon: Settings },
] as const;

export function AppSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Icon-only rail when collapsed, persisted so it doesn't reset every load.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("sidebar-collapsed") === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  async function signOut() {
    // Drop every cached row before the session goes away so the next account
    // never sees the previous user's projects, media, hooks or renders.
    onNavigate?.();
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }


  return (
    <aside
      className={`sticky top-0 flex h-screen max-w-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ${
        collapsed ? "w-[68px]" : "w-[248px]"
      }`}
    >
      <div className={`flex items-center gap-2.5 px-5 py-5 ${collapsed ? "justify-center px-0" : ""}`}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary">
          <Clapperboard className="size-4 text-primary-foreground" />
        </div>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate font-display text-sm font-semibold">Creative Factory</p>
            <p className="truncate text-[11px] text-muted-foreground">Short-form production</p>
          </div>
        )}
      </div>

      <nav className={`flex-1 space-y-1 py-2 ${collapsed ? "px-2" : "px-3"}`}>
        <TooltipProvider delayDuration={200}>
          {items.map((item) => {
            const active = pathname === item.url || pathname.startsWith(`${item.url}/`);
            const link = (
              <Link
                key={item.url}
                to={item.url}
                onClick={onNavigate}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  collapsed ? "justify-center px-0" : ""
                } ${
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                }`}
              >
                <item.icon className={active ? "size-4 shrink-0 text-primary" : "size-4 shrink-0"} />
                {!collapsed && item.title}
              </Link>
            );
            if (!collapsed) return link;
            return (
              <Tooltip key={item.url}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.title}</TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <Button
          variant="ghost"
          size="icon"
          className="mb-1 size-8 w-full justify-center"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
        <div className={`flex items-center gap-2 rounded-lg px-2 py-2 ${collapsed ? "justify-center px-0" : ""}`}>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-raised text-xs font-semibold uppercase">
            {user?.email?.[0] ?? "?"}
          </div>
          {!collapsed && <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{user?.email ?? "—"}</p>}
          {!collapsed && (
            <Button variant="ghost" size="icon" className="size-8" onClick={signOut} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          )}
        </div>
        {collapsed && (
          <Button variant="ghost" size="icon" className="mt-1 size-8 w-full justify-center" onClick={signOut} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        )}
      </div>
    </aside>
  );
}

