const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createAuth({ clientId, clientSecret, redirectUri }) {
  const tokenFile = path.join(__dirname, "accounts", "bot.json");
  let oauthState = crypto.randomBytes(24).toString("hex");

  function readTokens() {
    if (!fs.existsSync(tokenFile)) return null;
    return JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  }

  function saveTokens(tokens) {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  async function tokenRequest(body) {
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error_description || "Twitch OAuth request failed.");
    return data;
  }

  async function validateToken(accessToken) {
    const response = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${accessToken}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Twitch access token is invalid or expired.");
    return data;
  }

  async function refreshToken() {
    const current = readTokens();
    if (!current?.refresh_token) throw new Error("No refresh token found. Reconnect the Twitch account.");
    const refreshed = await tokenRequest({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: current.refresh_token
    });
    const updated = { ...current, ...refreshed };
    saveTokens(updated);
    return updated;
  }

  return {
    initialize: async () => {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      if (fs.existsSync(tokenFile)) {
        try {
          const tokens = readTokens();
          await validateToken(tokens.access_token);
          console.log("[AUTH] Saved Twitch account token is valid.");
        } catch {
          console.log("[AUTH] Saved token needs reconnecting. Use Connect Twitch account in the dashboard.");
        }
      }
    },

    getAuthorizationUrl: () => {
      oauthState = crypto.randomBytes(24).toString("hex");
      const url = new URL("https://id.twitch.tv/oauth2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "chat:read chat:edit");
      url.searchParams.set("state", oauthState);
      return url.toString();
    },

    verifyState: value => typeof value === "string" && value.length === oauthState.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(oauthState)),

    exchangeCode: async code => {
      const tokens = await tokenRequest({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      });
      saveTokens(tokens);
      return tokens;
    },

    validateToken,
    refreshToken,

    hourlyValidation: async () => {
      const current = readTokens();
      if (!current?.access_token) return;
      try {
        await (async () => {
          const response = await fetch("https://id.twitch.tv/oauth2/validate", {
            headers: { Authorization: `OAuth ${current.access_token}` }
          });
          if (!response.ok) throw new Error("Token expired");
        })();
      } catch {
        try { await refreshToken(); }
        catch (error) { console.error("[AUTH] Token refresh failed:", error.message); }
      }
    }
  };
}

module.exports = { createAuth };
