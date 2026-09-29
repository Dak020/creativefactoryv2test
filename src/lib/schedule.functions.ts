import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Connected TikTok accounts + caption templates, fetched together for the schedule dialog. */
export const listScheduleOptionsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [accounts, captions] = await Promise.all([
      context.supabase
        .from("social_accounts")
        .select("id, account_handle, display_name, avatar_url, status, driver")
        .eq("platform", "tiktok")
        .eq("status", "connected")
        .order("created_at", { ascending: true }),
      context.supabase
        .from("captions_library")
        .select("id, title, body, hashtags, is_favorite")
        .order("is_favorite", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);
    if (accounts.error) throw new Error(accounts.error.message);
    if (captions.error) throw new Error(captions.error.message);
    return { accounts: accounts.data ?? [], captions: captions.data ?? [] };
  });

export type ScheduleInput = {
  videoId: string;
  socialAccountId: string;
  /** A caption-library template id. When set, `caption` is ignored. */
  captionId?: string | null;
  /** Free-text caption (or fallback when no template is picked). */
  caption?: string | null;
  /** ISO timestamp. Omit or pass a past time to publish immediately. */
  scheduledFor?: string | null;
};

/** Builds the final caption text for a video, resolving a template when given. */
async function buildCaption(
  context: { supabase: any; userId: string },
  input: { captionId?: string | null; caption?: string | null },
  hookText: string,
) {
  let caption = "";
  if (input.captionId) {
    const capRes = await context.supabase
      .from("captions_library")
      .select("id, user_id, body, hashtags")
      .eq("id", input.captionId)
      .maybeSingle();
    if (capRes.error) throw new Error(capRes.error.message);
    const template = capRes.data;
    if (!template || template.user_id !== context.userId)
      throw new Error("Caption template not found.");
    caption = template.body.split("{hook}").join(hookText);
    if (template.hashtags?.length) {
      caption += `\n\n${template.hashtags.map((h: string) => `#${h}`).join(" ")}`;
    }
  } else if (input.caption && input.caption.trim()) {
    caption = input.caption.split("{hook}").join(hookText);
  }
  caption = caption.trim();
  if (!caption) throw new Error("Write a caption or pick a template.");
  if (caption.length > 2200)
    throw new Error("Caption is too long (TikTok allows 2200 characters).");
  return caption;
}

/** A long-lived signed URL the posting API (or our own server) can fetch the rendered file from. */
async function signRenderUrl(supabase: any, path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const { data, error } = await supabase.storage
    .from("renders")
    .createSignedUrl(path, 60 * 60 * 24 * 7);
  if (error || !data?.signedUrl) {
    throw new Error("The rendered file could not be prepared for posting.");
  }
  return data.signedUrl;
}

/**
 * Makes sure a directly-connected TikTok account's access token is still
 * good, refreshing it (and persisting the new pair) if it's expired or
 * about to be. Returns the access token to use for the publish call.
 */
async function ensureFreshAccessToken(
  context: { supabase: any },
  account: {
    id: string;
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: string | null;
  },
): Promise<string> {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  const stillGood = account.access_token && expiresAt > Date.now() + 60_000;
  if (stillGood) return account.access_token!;

  if (!account.refresh_token) {
    throw new Error(
      "This account's TikTok session expired and there's no refresh token — reconnect it.",
    );
  }
  const { refreshTokens } = await import("@/lib/social/tiktok.server");
  const tokens = await refreshTokens(account.refresh_token);
  await context.supabase
    .from("social_accounts")
    .update({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresAt,
      scopes: tokens.scope,
    })
    .eq("id", account.id);
  return tokens.accessToken;
}

/** Sends one queued row to the connected account's posting driver and records the outcome. */
async function dispatchRow(
  context: { supabase: any; userId: string },
  rowId: string,
): Promise<{ id: string; status: string; error?: string }> {
  const { data: row, error } = await context.supabase
    .from("scheduled_posts")
    .select("id, user_id, caption, scheduled_for, status, generated_video_id, social_account_id")
    .eq("id", rowId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || row.user_id !== context.userId) throw new Error("Scheduled post not found.");

  const [videoRes, acctRes] = await Promise.all([
    context.supabase
      .from("generated_videos")
      .select("id, output_url")
      .eq("id", row.generated_video_id)
      .maybeSingle(),
    context.supabase
      .from("social_accounts")
      .select(
        "id, driver, profile_identifier, account_handle, status, access_token, refresh_token, token_expires_at",
      )
      .eq("id", row.social_account_id)
      .maybeSingle(),
  ]);
  const video = videoRes.data;
  const account = acctRes.data;

  async function fail(message: string) {
    await context.supabase
      .from("scheduled_posts")
      .update({ status: "failed", error_message: message })
      .eq("id", row.id);
    return { id: row.id as string, status: "failed", error: message };
  }

  if (!video?.output_url) return fail("The rendered video file is missing.");
  if (!account) return fail("The TikTok account was removed.");
  if (account.status !== "connected") return fail(`@${account.account_handle} needs reconnecting.`);

  await context.supabase.from("scheduled_posts").update({ status: "posting" }).eq("id", row.id);

  try {
    const videoUrl = await signRenderUrl(video.output_url);

    if (account.driver === "tiktok") {
      // Direct TikTok posting has no "hold and publish later" concept — it
      // publishes as soon as we call it. Without a background dispatcher
      // that waits for `scheduled_for`, this always posts now.
      const accessToken = await ensureFreshAccessToken(context, account);
      const { publishVideo } = await import("@/lib/social/tiktok.server");
      const result = await publishVideo({ accessToken, videoUrl, caption: row.caption });
      await context.supabase
        .from("scheduled_posts")
        .update({
          status: "published",
          upload_post_job_id: result.publishId,
          error_message: null,
          published_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      return { id: row.id as string, status: "published" };
    }

    // Legacy driver: accounts connected before the switch to direct TikTok
    // posting still go through Upload-Post, which can genuinely hold a post
    // until `scheduledDate`.
    const { publishVideo } = await import("@/lib/social/upload-post.server");
    const result = await publishVideo({
      profile: account.profile_identifier,
      videoUrl,
      caption: row.caption,
      scheduledDate: row.scheduled_for,
    });
    const status = result.scheduled ? "scheduled" : "published";
    await context.supabase
      .from("scheduled_posts")
      .update({
        status,
        upload_post_job_id: result.jobId,
        error_message: null,
        published_at: result.scheduled ? null : new Date().toISOString(),
      })
      .eq("id", row.id);
    return { id: row.id as string, status };
  } catch (e) {
    return fail((e as Error).message);
  }
}

export const createScheduledPostFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ScheduleInput) => input)
  .handler(async ({ data, context }) => {
    const videoRes = await context.supabase
      .from("generated_videos")
      .select("id, user_id, project_id, hook_text, output_url")
      .eq("id", data.videoId)
      .maybeSingle();
    if (videoRes.error) throw new Error(videoRes.error.message);
    const video = videoRes.data;
    if (!video || video.user_id !== context.userId) throw new Error("Video not found.");
    if (!video.output_url) throw new Error("This video has no rendered output to post.");

    const acctRes = await context.supabase
      .from("social_accounts")
      .select("id, user_id, status, account_handle")
      .eq("id", data.socialAccountId)
      .eq("platform", "tiktok")
      .maybeSingle();
    if (acctRes.error) throw new Error(acctRes.error.message);
    const account = acctRes.data;
    if (!account || account.user_id !== context.userId) throw new Error("Account not found.");
    if (account.status !== "connected") {
      throw new Error(
        `@${account.account_handle} is not connected. Reconnect it on the Accounts page.`,
      );
    }

    const when = data.scheduledFor ? new Date(data.scheduledFor) : new Date();
    if (Number.isNaN(when.getTime())) throw new Error("Pick a valid date and time.");

    const caption = await buildCaption(context, data, video.hook_text ?? "");

    const insRes = await context.supabase
      .from("scheduled_posts")
      .insert({
        user_id: context.userId,
        generated_video_id: video.id,
        project_id: video.project_id,
        social_account_id: account.id,
        caption,
        scheduled_for: when.toISOString(),
        status: "queued",
      })
      .select("id")
      .single();
    if (insRes.error) throw new Error(insRes.error.message);

    // Dispatch immediately. Legacy (Upload-Post) accounts can genuinely hold
    // the post until `scheduledFor`; directly-connected TikTok accounts have
    // no such hold and publish right away regardless of the chosen time,
    // since nothing here waits for it yet. One row = one request, so
    // batches stay sequential.
    const outcome = await dispatchRow(context, insRes.data.id);
    return { id: insRes.data.id as string, status: outcome.status, error: outcome.error ?? null };
  });

/** Everything in the queue, newest scheduled time first. */
export const listScheduledPostsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("scheduled_posts")
      .select(
        "id, caption, scheduled_for, status, error_message, published_at, post_url, created_at, social_accounts(account_handle, display_name), generated_videos(hook_text, output_url)",
      )
      .order("scheduled_for", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { posts: data ?? [] };
  });

/** Finished renders that can be queued, with the accounts they were already sent to. */
export const listSchedulableVideosFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("generated_videos")
      .select("id, hook_text, output_url, created_at, project_id, projects(name)")
      .not("output_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(120);
    if (error) throw new Error(error.message);

    const ids = (data ?? []).map((v: { id: string }) => v.id);
    const posted: Record<string, number> = {};
    if (ids.length) {
      const { data: rows } = await context.supabase
        .from("scheduled_posts")
        .select("generated_video_id, status")
        .in("generated_video_id", ids);
      for (const r of rows ?? []) {
        if (!r.generated_video_id || r.status === "cancelled" || r.status === "failed") continue;
        posted[r.generated_video_id] = (posted[r.generated_video_id] ?? 0) + 1;
      }
    }
    return {
      videos: (data ?? []).map((v: any) => ({
        id: v.id as string,
        hook_text: (v.hook_text ?? null) as string | null,
        output_url: v.output_url as string,
        created_at: v.created_at as string,
        project_name: (v.projects?.name ?? null) as string | null,
        queued_count: posted[v.id] ?? 0,
      })),
    };
  });

/** Cancels a pending post here and, for legacy accounts, at Upload-Post. */
export const cancelScheduledPostFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("scheduled_posts")
      .select("id, user_id, status, upload_post_job_id, social_accounts(driver)")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row || row.user_id !== context.userId) throw new Error("Scheduled post not found.");
    if (row.status === "published") throw new Error("This one is already live on TikTok.");

    // Direct TikTok posts publish immediately on dispatch, so there's never
    // a remotely-held job to cancel for them — only Upload-Post genuinely
    // holds a scheduled post server-side. `upload_post_job_id` on a
    // tiktok-driver row is actually a TikTok publish_id, not an Upload-Post
    // job, so it must never be sent to Upload-Post's cancel endpoint.
    const driver = (row as any).social_accounts?.driver ?? "upload_post";
    if (row.upload_post_job_id && driver !== "tiktok") {
      const { cancelScheduledJob } = await import("@/lib/social/upload-post.server");
      await cancelScheduledJob(row.upload_post_job_id);
    }
    await context.supabase
      .from("scheduled_posts")
      .update({ status: "cancelled", error_message: null })
      .eq("id", row.id);
    return { ok: true };
  });

/** Removes a queue row entirely (history clean-up). */
export const deleteScheduledPostFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("scheduled_posts").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Re-sends a post that failed. */
export const retryScheduledPostFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const outcome = await dispatchRow(context, data.id);
    return { status: outcome.status, error: outcome.error ?? null };
  });
