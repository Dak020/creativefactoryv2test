import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { PageHeader } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { VIDEO_DEFAULTS } from "@/lib/constants";
import { formatBytes } from "@/lib/db";
import { AiProviderSettings } from "@/components/AiProviderSettings";
import { PasswordSettings } from "@/components/PasswordSettings";
import { TelegramSettings } from "@/components/TelegramSettings";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Creative Factory" },
      { name: "description", content: "Account, render defaults and AI provider configuration." },
      { property: "og:title", content: "Settings — Creative Factory" },
      { property: "og:description", content: "Manage your Creative Factory workspace." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: counts } = useQuery({
    queryKey: ["settings-counts", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const [projects, media, hooks, videos] = await Promise.all([
        supabase.from("projects").select("id"),
        supabase.from("media_assets").select("id"),
        supabase.from("hooks").select("id"),
        supabase.from("generated_videos").select("id"),
      ]);
      return {
        projects: projects.data?.length ?? 0,
        media: media.data?.length ?? 0,
        hooks: hooks.data?.length ?? 0,
        videos: videos.data?.length ?? 0,
      };
    },
  });

  // Real storage usage: walk this user's folder in both buckets and add up the
  // object sizes reported by Storage.
  const { data: storage, isLoading: storageLoading } = useQuery({
    queryKey: ["settings-storage", user?.id],
    enabled: !!user?.id,
    // Uploads and deletes happen on other pages, so always re-read Storage
    // when this page is opened or refocused rather than serving a stale total.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      async function bucketUsage(bucket: string) {
        let offset = 0;
        let bytes = 0;
        let files = 0;
        let thumbBytes = 0;
        for (;;) {
          const { data, error } = await supabase.storage
            .from(bucket)
            .list(user!.id, { limit: 100, offset });
          if (error || !data?.length) break;
          for (const obj of data) {
            const size = Number((obj.metadata as { size?: number } | null)?.size ?? 0);
            const isThumb = obj.name.endsWith(".jpg") || obj.name.endsWith(".jpeg");
            if (isThumb) thumbBytes += size;
            else {
              bytes += size;
              files += 1;
            }
          }
          if (data.length < 100) break;
          offset += 100;
        }
        return { bytes, files, thumbBytes };
      }
      const [media, renders] = await Promise.all([bucketUsage("media"), bucketUsage("renders")]);
      return { media, renders, total: media.bytes + media.thumbBytes + renders.bytes + renders.thumbBytes };
    },
  });

  const quota = 1024 * 1024 * 1024; // 1 GB soft workspace capacity
  const usedPct = storage ? Math.min(100, Math.round((storage.total / quota) * 100)) : 0;


  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Account and production defaults." />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="panel space-y-4 p-6">
          <h2 className="text-sm font-semibold">Account</h2>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Signed in as</Label>
            <p className="text-sm">{user?.email ?? "—"}</p>
          </div>
          <Button
            variant="outline"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/auth" });
            }}
          >
            Sign out
          </Button>
        </section>

        <section className="panel space-y-4 p-6">
          <h2 className="text-sm font-semibold">Workspace</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            {[
              ["Projects", counts?.projects ?? 0],
              ["Media clips", counts?.media ?? 0],
              ["Hooks", counts?.hooks ?? 0],
              ["Videos", counts?.videos ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-display text-xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="panel space-y-4 p-6 lg:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Storage</h2>
            <p className="text-xs text-muted-foreground">
              {storageLoading ? "Reading usage…" : `${formatBytes(storage?.total ?? 0)} of ${formatBytes(quota)} used`}
            </p>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${usedPct}%` }} />
          </div>
          <dl className="grid gap-4 sm:grid-cols-3">
            {[
              ["Source clips", storage?.media.bytes ?? 0, `${storage?.media.files ?? 0} files`],
              ["Generated renders", storage?.renders.bytes ?? 0, `${storage?.renders.files ?? 0} files`],
              [
                "Thumbnails",
                (storage?.media.thumbBytes ?? 0) + (storage?.renders.thumbBytes ?? 0),
                "posters",
              ],
            ].map(([label, bytes, sub]) => (
              <div key={String(label)}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-display text-xl font-semibold tabular-nums">{formatBytes(Number(bytes))}</dd>
                <p className="text-[11px] text-muted-foreground">{sub}</p>
              </div>
            ))}
          </dl>
        </section>

        <section className="panel space-y-3 p-6">
          <h2 className="text-sm font-semibold">Render defaults</h2>
          <dl className="space-y-2 text-sm">
            {[
              ["Duration", `${VIDEO_DEFAULTS.duration}s`],
              ["Aspect ratio", VIDEO_DEFAULTS.aspect],
              ["Resolution", `${VIDEO_DEFAULTS.width}×${VIDEO_DEFAULTS.height}`],
              ["Container", VIDEO_DEFAULTS.container.toUpperCase()],
              ["Overlay", "Black text on white box, top safe area"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-border pb-2 last:border-0">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <TelegramSettings />

        <PasswordSettings />

        <AiProviderSettings />
      </div>
    </div>
  );
}
