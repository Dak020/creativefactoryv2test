import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { connectTelegramFn, disconnectTelegramFn, getTelegramLinkFn } from "@/lib/telegram.functions";

export function TelegramSettings() {
  const qc = useQueryClient();
  const getLink = useServerFn(getTelegramLinkFn);
  const connect = useServerFn(connectTelegramFn);
  const disconnect = useServerFn(disconnectTelegramFn);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  const { data } = useQuery({ queryKey: ["telegram-link"], queryFn: () => getLink(), refetchInterval: url ? 4000 : false });

  async function onConnect() {
    setBusy(true);
    try {
      const res = await connect({ data: { origin: window.location.origin } });
      setUrl(res.url);
      window.open(res.url, "_blank");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await disconnect();
      setUrl(null);
      qc.invalidateQueries({ queryKey: ["telegram-link"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel space-y-3 p-6">
      <h2 className="text-sm font-semibold">Telegram VA</h2>
      <p className="text-xs text-muted-foreground">
        Chat with your assistant from Telegram: /status, /clips, /trends, /schedule.
      </p>
      {data?.linked ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm">Connected ✅</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={onDisconnect}>Disconnect</Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Button disabled={busy} onClick={onConnect}>{busy ? "Preparing…" : "Connect Telegram"}</Button>
          {url && (
            <p className="text-xs text-muted-foreground">
              Telegram didn't open? <a className="underline" href={url} target="_blank" rel="noreferrer">Open the bot</a> and tap Start.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
