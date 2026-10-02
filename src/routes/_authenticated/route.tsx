import { useState } from "react";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Clapperboard, Menu } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AppSidebar } from "@/components/AppSidebar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { RenderWorker } from "@/components/RenderWorker";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  return (
    <div className="flex h-screen w-full overflow-x-hidden bg-background">
      <RenderWorker />
      <div className="hidden lg:block">
        <AppSidebar />
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {/* Mobile navigation: the sidebar is hidden below lg, so give phones a
            header with a drawer holding the exact same nav. */}
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur lg:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[248px] max-w-[85vw] p-0">
              <AppSidebar onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary">
              <Clapperboard className="size-3.5 text-primary-foreground" />
            </div>
            <span className="truncate font-display text-sm font-semibold capitalize">
              {pathname.split("/").filter(Boolean)[0] ?? "Dashboard"}
            </span>
          </div>
        </header>

        <div className="mx-auto w-full max-w-[1400px] min-w-0 px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
