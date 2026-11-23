// Xbox remote relay — runs on a free Cloudflare Worker.
// Phone (PWA) --HTTPS--> this Worker --> Microsoft / Xbox Live cloud --> your console.
//
// Secrets (set with `npx wrangler secret put NAME`):
//   MS_CLIENT_ID      Azure app registration "Application (client) ID"
//   MS_CLIENT_SECRET  Azure app registration client secret VALUE
//   APP_PIN           passcode the remote must send (keeps strangers off your Xbox)
// KV binding: TOKENS (stores the Microsoft refresh token + cached Xbox token)
// Optional var: MOCK_XBOX = "1" -> fake console, nothing leaves the Worker (for local testing)

const SCOPES = "Xboxlive.signin Xboxlive.offline_access";
const SG_URL = "https://xccs.xboxlive.com";
const SG_HEADERS = {
  "x-xbl-contract-version": "4",
  "skillplatform": "RemoteManagement",
  "Accept-Language": "en-US",
  "Content-Type": "application/json",
};

// Every action the remote is allowed to send. Anything else is rejected.
const KEYS = ["A", "B", "X", "Y", "Up", "Down", "Left", "Right", "Menu", "View", "Guide",
  // Not in the documented list. Sent experimentally; the console may reject them.
  "LeftTrigger", "RightTrigger", "LeftShoulder", "RightShoulder"];
function buildCommand(action, value) {
  if (action.startsWith("key:")) {
    const k = action.slice(4);
    if (!KEYS.includes(k)) return null;
    return ["Shell", "InjectKey", [{ keyType: k }]];
  }
  switch (action) {
    case "home": return ["Shell", "GoHome"];
    case "back": return ["Shell", "GoBack"];
    case "power_on": return ["Power", "WakeUp"];
    case "power_off": return ["Power", "TurnOff"];
    case "reboot": return ["Power", "Reboot"];
    case "vol_up": return ["Audio", "Volume", [{ direction: "Up", amount: String(clampInt(value, 1, 10, 1)) }]];
    case "vol_down": return ["Audio", "Volume", [{ direction: "Down", amount: String(clampInt(value, 1, 10, 1)) }]];
    case "mute": return ["Audio", "Mute"];
    case "unmute": return ["Audio", "Unmute"];
    case "play": return ["Media", "Play"];
    case "pause": return ["Media", "Pause"];
    case "next": return ["Media", "Next"];
    case "previous": return ["Media", "Previous"];
    case "text":
      if (typeof value !== "string" || !value || value.length > 500) return null;
      return ["Shell", "InjectString", [{ replacementString: value }]];
    case "launch":
      if (typeof value !== "string" || !/^[A-Za-z0-9]{6,20}$/.test(value)) return null;
      return ["Shell", "ActivateApplicationWithOneStoreProductId", [{ oneStoreProductId: value }]];
  }
  return null;
}
function clampInt(v, min, max, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/auth/login" && request.method === "POST") return authLogin(request, url, env);
      if (url.pathname === "/auth/callback") return authCallback(url, env);
      if (url.pathname.startsWith("/api/")) {
        if (!(await pinOk(request, env))) return json({ error: "bad_pin" }, 401);
        if (url.pathname === "/api/status" && request.method === "GET") return apiStatus(env);
        if (url.pathname === "/api/consoles" && request.method === "GET") return apiConsoles(env);
        if (url.pathname === "/api/cmd" && request.method === "POST") return apiCmd(request, env);
        if (url.pathname === "/api/reset" && request.method === "POST") {
          // fresh Xbox token + command session; keeps the Microsoft link
          await env.TOKENS.delete("xsts");
          memXsts = null;
          sessionId = null;
          return json({ ok: true });
        }
        if (url.pathname === "/api/unlink" && request.method === "POST") {
          await env.TOKENS.delete("refresh_token");
          await env.TOKENS.delete("xsts");
          memXsts = null;
          return json({ ok: true });
        }
        return json({ error: "not_found" }, 404);
      }
      // Everything else = the PWA's static files.
      return env.ASSETS.fetch(request);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.code || "server_error", detail: String(err.message || err) }, status);
    }
  },
};

// ---------- PIN ----------
async function pinOk(request, env) {
  const given = request.headers.get("x-pin") || "";
  if (!env.APP_PIN) return false;
  // Compare hashes so timing doesn't leak the PIN.
  const [a, b] = await Promise.all([sha256(given), sha256(env.APP_PIN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// ---------- Microsoft sign-in ----------
function redirectUri(url) {
  return `${url.origin}/auth/callback`;
}

async function authLogin(request, url, env) {
  // POST /auth/login (form field "pin") — PIN required so nobody else can link their account to your remote.
  const form = await request.formData().catch(() => null);
  const fakeReq = new Request(url, { headers: { "x-pin": (form && form.get("pin")) || "" } });
  if (!(await pinOk(fakeReq, env))) return html("Wrong PIN. Go back to the remote and try again.", 401);
  if (env.MOCK_XBOX === "1") {
    await env.TOKENS.put("refresh_token", "mock");
    return Response.redirect(`${url.origin}/?linked=1`, 303);
  }
  const state = crypto.randomUUID();
  await env.TOKENS.put(`state:${state}`, "1", { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: "code",
    approval_prompt: "auto",
    scope: SCOPES,
    redirect_uri: redirectUri(url),
    state,
  });
  return Response.redirect(`https://login.live.com/oauth20_authorize.srf?${q}`, 303);
}

async function authCallback(url, env) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) {
    return html(`Microsoft said: ${escapeHtml(url.searchParams.get("error_description") || url.searchParams.get("error"))}`, 400);
  }
  if (!state || !code || !(await env.TOKENS.get(`state:${state}`))) {
    return html("Sign-in link expired. Start again from the remote.", 400);
  }
  await env.TOKENS.delete(`state:${state}`);
  const tok = await msToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(url),
  });
  await saveRefresh(env, tok);
  await xboxAuthFromAccess(env, tok.access_token); // proves the account works with Xbox Live
  return Response.redirect(`${url.origin}/?linked=1`, 302);
}

async function msToken(env, data) {
  const body = new URLSearchParams({ ...data, scope: SCOPES, client_id: env.MS_CLIENT_ID });
  if (env.MS_CLIENT_SECRET) body.set("client_secret", env.MS_CLIENT_SECRET);
  const r = await fetch("https://login.live.com/oauth20_token.srf", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(401, "ms_token_failed", j.error_description || j.error || r.status);
  return j;
}

async function saveRefresh(env, tok) {
  if (tok.refresh_token) await env.TOKENS.put("refresh_token", tok.refresh_token);
}

// ---------- Xbox Live token chain ----------
// Cached per Worker instance (memory) and in KV, so most button presses skip auth entirely.
let memXsts = null;

async function xboxAuthHeader(env) {
  const now = Date.now();
  if (memXsts && memXsts.exp - 5 * 60_000 > now) return memXsts.header;
  const cached = await env.TOKENS.get("xsts", "json");
  if (cached && cached.exp - 5 * 60_000 > now) {
    memXsts = cached;
    return cached.header;
  }
  const refresh = await env.TOKENS.get("refresh_token");
  if (!refresh) throw httpErr(409, "not_linked", "Sign in with Microsoft first.");
  const tok = await msToken(env, { grant_type: "refresh_token", refresh_token: refresh });
  await saveRefresh(env, tok);
  return xboxAuthFromAccess(env, tok.access_token);
}

async function xboxAuthFromAccess(env, accessToken) {
  const ur = await fetch("https://user.auth.xboxlive.com/user/authenticate", {
    method: "POST",
    headers: { "x-xbl-contract-version": "1", "Content-Type": "application/json" },
    body: JSON.stringify({
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${accessToken}` },
    }),
  });
  if (!ur.ok) throw httpErr(401, "xbox_user_auth_failed", ur.status);
  const user = await ur.json();

  const xr = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
    method: "POST",
    headers: { "x-xbl-contract-version": "1", "Content-Type": "application/json" },
    body: JSON.stringify({
      RelyingParty: "http://xboxlive.com",
      TokenType: "JWT",
      Properties: { UserTokens: [user.Token], SandboxId: "RETAIL" },
    }),
  });
  if (!xr.ok) {
    const j = await xr.json().catch(() => ({}));
    // 2148916233 = no Xbox profile on this account; 2148916238 = child account needs family approval
    throw httpErr(401, "xsts_failed", j.XErr || xr.status);
  }
  const xsts = await xr.json();
  const uhs = xsts.DisplayClaims.xui[0].uhs;
  const entry = { header: `XBL3.0 x=${uhs};${xsts.Token}`, exp: Date.parse(xsts.NotAfter) };
  memXsts = entry;
  await env.TOKENS.put("xsts", JSON.stringify(entry));
  return entry.header;
}

// ---------- API ----------
async function apiStatus(env) {
  const linked = !!(await env.TOKENS.get("refresh_token"));
  return json({ linked, mock: env.MOCK_XBOX === "1" });
}

async function apiConsoles(env) {
  if (env.MOCK_XBOX === "1") {
    return json({ consoles: [{ id: "MOCK0001", name: "Living Room Series X", type: "XboxSeriesX", power: "On", remoteEnabled: true }] });
  }
  const auth = await xboxAuthHeader(env);
  const r = await fetch(`${SG_URL}/lists/devices?queryCurrentDevice=false&includeStorageDevices=false`, {
    headers: { ...SG_HEADERS, Authorization: auth },
  });
  if (!r.ok) throw httpErr(502, "console_list_failed", r.status);
  const j = await r.json();
  return json({
    consoles: (j.result || []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.consoleType,
      power: c.powerState,
      remoteEnabled: c.remoteManagementEnabled,
    })),
  });
}

let sessionId = null; // random values aren't allowed at Worker startup, so make it on first use

async function apiCmd(request, env) {
  const { consoleId, action, value } = await request.json().catch(() => ({}));
  if (typeof consoleId !== "string" || !/^[A-Za-z0-9]{4,40}$/.test(consoleId)) {
    return json({ error: "bad_console" }, 400);
  }
  const cmd = buildCommand(String(action || ""), value);
  if (!cmd) return json({ error: "bad_action" }, 400);
  const [type, command, params] = cmd;

  if (env.MOCK_XBOX === "1") {
    console.log("MOCK cmd", type, command, JSON.stringify(params || []));
    return json({ ok: true, mock: true, type, command });
  }

  const auth = await xboxAuthHeader(env);
  sessionId ||= crypto.randomUUID();
  const r = await fetch(`${SG_URL}/commands`, {
    method: "POST",
    headers: { ...SG_HEADERS, Authorization: auth },
    body: JSON.stringify({
      destination: "Xbox",
      type,
      command,
      sessionId,
      sourceId: "com.microsoft.smartglass",
      parameters: params || [{}],
      linkedXboxId: consoleId,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) { memXsts = null; await env.TOKENS.delete("xsts"); }
    throw httpErr(502, "command_failed", `${r.status} ${JSON.stringify(j.status || j).slice(0, 200)}`);
  }
  const ok = !j.status || j.status.errorCode === "OK";
  return json({ ok, result: j.result || null, status: j.status || null });
}

// ---------- helpers ----------
function httpErr(status, code, message) {
  const e = new Error(String(message));
  e.status = status;
  e.code = code;
  return e;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function html(msg, status = 200) {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;background:#0b0d0c;color:#eee;padding:32px"><p>${msg}</p><p><a style="color:#7CFF6B" href="/">Back to remote</a></p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
