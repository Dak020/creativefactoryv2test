/**
 * Server-only TikTok Content Posting API v2 client.
 * Talks to TikTok directly — no third-party posting service, no subscription.
 */

const OAUTH_BASE = "https://open.tiktokapis.com/v2";
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";

export const TIKTOK_SCOPES = "user.info.basic,video.upload,video.publish";

export function tiktokConfigured(): boolean {
  return Boolean(process.env["TIKTOK_CLIENT_KEY"] && process.env["TIKTOK_CLIENT_SECRET"]);
}

function clientKey(): string {
  const v = process.env["TIKTOK_CLIENT_KEY"];
  if (!v) throw new Error("TikTok is not set up yet. Add the TikTok client key first.");
  return v;
}

function clientSecret(): string {
  const v = process.env["TIKTOK_CLIENT_SECRET"];
  if (!v) throw new Error("TikTok is not set up yet. Add the TikTok client secret first.");
  return v;
}

export function authorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_key: clientKey(),
    scope: TIKTOK_SCOPES,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type TikTokTokens = {
  openId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TikTokTokens> {
  const res = await fetch(`${OAUTH_BASE}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`TikTok returned an unreadable response: ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed["error"]) {
    const detail = parsed["error_description"] || parsed["error"] || text.slice(0, 250);
    throw new Error(`TikTok sign-in failed: ${detail}`);
  }
  return {
    openId: String(parsed["open_id"] ?? ""),
    accessToken: String(parsed["access_token"] ?? ""),
    refreshToken: String(parsed["refresh_token"] ?? ""),
    expiresAt: new Date(Date.now() + Number(parsed["expires_in"] ?? 86400) * 1000).toISOString(),
    scope: String(parsed["scope"] ?? ""),
  };
}

export function exchangeCode(code: string, redirectUri: string) {
  return tokenRequest({
    client_key: clientKey(),
    client_secret: clientSecret(),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
}

export function refreshTokens(refreshToken: string) {
  return tokenRequest({
    client_key: clientKey(),
    client_secret: clientSecret(),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export type TikTokProfile = {
  openId: string;
  displayName: string | null;
  avatarUrl: string | null;
  username: string | null;
};

async function apiGet(path: string, accessToken: string) {
  const res = await fetch(`${OAUTH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`TikTok returned an unreadable response: ${text.slice(0, 200)}`);
  }
  const err = parsed?.["error"];
  if (!res.ok || (err && err.code && err.code !== "ok")) {
    const detail = err?.message || err?.code || text.slice(0, 250);
    console.error(`[tiktok] ${path} failed [${res.status}]: ${text.slice(0, 400)}`);
    throw new Error(`TikTok request failed: ${detail}`);
  }
  return parsed;
}

export async function fetchProfile(accessToken: string): Promise<TikTokProfile> {
  const parsed = await apiGet(
    "/user/info/?fields=open_id,display_name,avatar_url",
    accessToken,
  );
  const u = parsed?.["data"]?.user ?? {};
  return {
    openId: String(u.open_id ?? ""),
    displayName: u.display_name ?? null,
    avatarUrl: u.avatar_url ?? null,
    username: u.username ?? null,
  };
}

async function apiPost(path: string, accessToken: string, body: unknown) {
  const res = await fetch(`${OAUTH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`TikTok returned an unreadable response: ${text.slice(0, 200)}`);
  }
  const err = parsed?.["error"];
  if (!res.ok || (err && err.code && err.code !== "ok")) {
    const detail = err?.message || err?.code || text.slice(0, 250);
    console.error(`[tiktok] ${path} failed [${res.status}]: ${text.slice(0, 400)}`);
    throw new Error(`TikTok rejected the post: ${detail}`);
  }
  return parsed;
}

/** Privacy options this account is allowed to use right now. */
export async function creatorInfo(accessToken: string) {
  const parsed = await apiPost("/post/publish/creator_info/query/", accessToken, {});
  const d = parsed?.["data"] ?? {};
  return {
    privacyOptions: (d.privacy_level_options ?? []) as string[],
    username: (d.creator_username ?? null) as string | null,
    maxDuration: (d.max_video_post_duration_sec ?? null) as number | null,
  };
}

export type TikTokPublishResult = { publishId: string };

/**
 * Uploads a rendered file straight to TikTok and publishes it.
 * The file is streamed through our server, so the storage link never
 * needs to be a TikTok-verified domain.
 */
export async function publishVideo(input: {
  accessToken: string;
  videoUrl: string;
  caption: string;
}): Promise<TikTokPublishResult> {
  const fileRes = await fetch(input.videoUrl);
  if (!fileRes.ok) throw new Error("The rendered video file could not be read.");
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  const size = bytes.byteLength;
  if (!size) throw new Error("The rendered video file is empty.");

  const info = await creatorInfo(input.accessToken);
  // Unaudited/sandbox clients may only post privately: TikTok requires SELF_ONLY.
  // Switch to PUBLIC_TO_EVERYONE once the app passes TikTok's audit.
  const privacy = info.privacyOptions.includes("SELF_ONLY")
    ? "SELF_ONLY"
    : (info.privacyOptions[0] ?? "SELF_ONLY");

  const init = await apiPost("/post/publish/video/init/", input.accessToken, {
    post_info: {
      title: input.caption.slice(0, 2200),
      privacy_level: privacy,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: size,
      total_chunk_count: 1,
    },
  });

  const publishId = init?.["data"]?.publish_id as string | undefined;
  const uploadUrl = init?.["data"]?.upload_url as string | undefined;
  if (!publishId || !uploadUrl) throw new Error("TikTok did not return an upload slot.");

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Content-Range": `bytes 0-${size - 1}/${size}`,
    },
    body: bytes,
  });
  if (!put.ok) {
    const t = await put.text();
    console.error(`[tiktok] upload failed [${put.status}]: ${t.slice(0, 300)}`);
    throw new Error(`TikTok upload failed [${put.status}].`);
  }

  return { publishId };
}

/** Best-effort publish status check. */
export async function publishStatus(accessToken: string, publishId: string) {
  try {
    const parsed = await apiPost("/post/publish/status/fetch/", accessToken, {
      publish_id: publishId,
    });
    return {
      status: (parsed?.["data"]?.status ?? null) as string | null,
      publiclyAvailableIds: (parsed?.["data"]?.publicaly_available_post_id ?? []) as string[],
    };
  } catch {
    return { status: null, publiclyAvailableIds: [] as string[] };
  }
}
