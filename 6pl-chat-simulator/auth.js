
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TOKEN_FILE = path.join(
  __dirname,
  "accounts",
  "xxoofqwe.json"
);

const TWITCH_AUTHORIZE_URL =
  "https://id.twitch.tv/oauth2/authorize";

const TWITCH_TOKEN_URL =
  "https://id.twitch.tv/oauth2/token";

const TWITCH_VALIDATE_URL =
  "https://id.twitch.tv/oauth2/validate";

const REQUIRED_SCOPES = [
  "chat:read",
  "chat:edit"
];

function createAuth(config) {
  let expectedState = null;

  function getAuthorizationUrl() {
    expectedState = crypto.randomBytes(32).toString("hex");

    const url = new URL(TWITCH_AUTHORIZE_URL);

    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", expectedState);
    url.searchParams.set(
      "scope",
      REQUIRED_SCOPES.join(" ")
    );

    return url.toString();
  }

  function verifyState(receivedState) {
    if (!expectedState || !receivedState) {
      return false;
    }

    const expected = Buffer.from(expectedState);
    const received = Buffer.from(receivedState);

    expectedState = null;

    if (expected.length !== received.length) {
      return false;
    }

    return crypto.timingSafeEqual(expected, received);
  }

  async function postTokenRequest(params) {
    const response = await fetch(TWITCH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(params)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.message ||
        `Twitch OAuth error: ${response.status}`
      );
    }

    return data;
  }

  function saveTokens(tokens) {
    fs.mkdirSync(path.dirname(TOKEN_FILE), {
      recursive: true
    });

    const temporaryFile = `${TOKEN_FILE}.tmp`;

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(tokens, null, 2),
      { mode: 0o600 }
    );

    fs.renameSync(temporaryFile, TOKEN_FILE);
  }

  function loadTokens() {
    if (!fs.existsSync(TOKEN_FILE)) {
      return null;
    }

    return JSON.parse(
      fs.readFileSync(TOKEN_FILE, "utf8")
    );
  }

  async function exchangeCode(code) {
    const tokens = await postTokenRequest({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri
    });

    saveTokens(tokens);

    return tokens;
  }

  async function refreshToken() {
    const current = loadTokens();

    if (!current || !current.refresh_token) {
      throw new Error(
        "No saved refresh token. Authorization required."
      );
    }

    const tokens = await postTokenRequest({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: current.refresh_token
    });

    saveTokens(tokens);

    return tokens;
  }

  async function validateToken(accessToken) {
    const response = await fetch(TWITCH_VALIDATE_URL, {
      headers: {
        Authorization: `OAuth ${accessToken}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.message ||
        "Twitch token validation failed."
      );
    }

    return data;
  }

  function checkChatPermissions(account) {
    const scopes = account.scopes || [];

    const missing = REQUIRED_SCOPES.filter(
      scope => !scopes.includes(scope)
    );

    if (missing.length > 0) {
      throw new Error(
        `Missing permissions: ${missing.join(", ")}`
      );
    }

    return true;
  }

  async function initialize() {
    let tokens = loadTokens();

    if (!tokens) {
      console.log("[AUTH] No saved credentials.");
      console.log("[AUTH] Visit http://localhost:3000/auth/start");
      return null;
    }

    try {
      let account;

      try {
        account = await validateToken(tokens.access_token);
      } catch {
        console.log("[AUTH] Refreshing access token...");

        tokens = await refreshToken();

        account = await validateToken(tokens.access_token);
      }

      console.log(`[AUTH] Connected as ${account.login}`);

      try {
        checkChatPermissions(account);
        console.log("[AUTH] Chat permissions verified.");
      } catch (error) {
        console.error("[AUTH]", error.message);
      }

      return account;
    } catch (error) {
      console.error(
        "[AUTH] Authorization needs attention:",
        error.message
      );

      return null;
    }
  }

  async function hourlyValidation() {
    try {
      let tokens = loadTokens();

      if (!tokens) return;

      try {
        await validateToken(tokens.access_token);

        console.log(
          "[AUTH] Hourly token validation successful."
        );
      } catch {
        console.log("[AUTH] Refreshing invalid access token...");

        tokens = await refreshToken();

        await validateToken(tokens.access_token);

        console.log("[AUTH] Token refreshed successfully.");
      }
    } catch (error) {
      console.error(
        "[AUTH] Validation failed:",
        error.message
      );
    }
  }

  return {
    getAuthorizationUrl,
    verifyState,
    exchangeCode,
    refreshToken,
    validateToken,
    checkChatPermissions,
    initialize,
    hourlyValidation
  };
}

module.exports = { createAuth };
