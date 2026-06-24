import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import open from "open";
import { config } from "./config.js";

interface TokenCache {
  refreshToken: string;
}

interface TokenSet {
  accessToken: string;
  expiresAt: number; // epoch ms
  refreshToken: string;
}

const TOKEN_FILE = resolve(config.cacheDir, "token.json");
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_URL = "https://accounts.spotify.com/authorize";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCache(): TokenCache | null {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as TokenCache;
  } catch {
    return null;
  }
}

function writeCache(cache: TokenCache): void {
  mkdirSync(config.cacheDir, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Run the one-time PKCE authorization flow via a loopback redirect. */
async function authorize(): Promise<TokenSet> {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    scope: config.scopes.join(" "),
    redirect_uri: config.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  }).toString();

  const code = await new Promise<string>((res, rej) => {
    const server = createServer((req, response) => {
      const url = new URL(req.url ?? "/", config.redirectUri);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const returnedCode = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      response.writeHead(200, { "Content-Type": "text/html" });
      if (err || returnedState !== state || !returnedCode) {
        response.end("<h2>Auth failed. You can close this tab.</h2>");
        server.close();
        rej(new Error(err ?? "state mismatch or missing code"));
        return;
      }
      response.end("<h2>Authorized. You can close this tab and return to the terminal.</h2>");
      server.close();
      res(returnedCode);
    });
    server.listen(config.callbackPort, "127.0.0.1", () => {
      console.log(`\nOpening browser to authorize Spotify...`);
      console.log(`If it doesn't open, visit:\n${authUrl.toString()}\n`);
      void open(authUrl.toString());
    });
  });

  const tokens = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });
  writeCache({ refreshToken: tokens.refreshToken });
  return tokens;
}

async function exchange(body: Record<string, string>): Promise<TokenSet> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Token request failed (${resp.status}): ${await resp.text()}`);
  }
  const json = (await resp.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    // Spotify may rotate the refresh token; keep the new one if present.
    refreshToken: json.refresh_token ?? body.refresh_token ?? "",
  };
}

/** Returns a valid access token, performing first-run auth or refresh as needed. */
export async function getAccessToken(): Promise<string> {
  const cache = readCache();
  let tokens: TokenSet;

  if (cache?.refreshToken) {
    tokens = await exchange({
      grant_type: "refresh_token",
      refresh_token: cache.refreshToken,
      client_id: config.clientId,
    });
    if (tokens.refreshToken && tokens.refreshToken !== cache.refreshToken) {
      writeCache({ refreshToken: tokens.refreshToken });
    }
  } else {
    tokens = await authorize();
  }
  return tokens.accessToken;
}
