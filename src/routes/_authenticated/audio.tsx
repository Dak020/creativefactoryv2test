import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/ui-kit";
import { AudioLibraryPanel } from "@/components/AudioLibraryPanel";

export const Route = createFileRoute("/_authenticated/audio")({
  head: () => ({
    meta: [
      { title: "Audio Library — Creative Factory" },
      {
        name: "description",
        content:
          "Browse trending TikTok sounds, import your own, and bake audio into your renders.",
      },
      { property: "og:title", content: "Audio Library — Creative Factory" },
      {
        property: "og:description",
        content: "Trending global and USA sounds, your saved favorites, and custom imports.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AudioPage,
});

function AudioPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Audio Library"
        description="Trending sounds to bake into your renders — or let the VA auto-pick the top track."
      />
      <div className="grid gap-6">
        <AudioLibraryPanel />
      </div>
    </div>
  );
}
