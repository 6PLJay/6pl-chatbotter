

require("dotenv").config();

const express = require("express");

const fs = require("fs");

const path = require("path");
const crypto = require("crypto");

const { createAuth } = require("./auth");

const app = express();

const PORT = Number(process.env.PORT || 3001);

app.use(express.urlencoded({ extended: true }));

app.use(express.json());

const CONFIG_FILE = path.join(__dirname, "config.json");

const TOKEN_FILE = path.join(

  __dirname,

  "accounts",

  "xxoofqwe.json"

);

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

const requiredVariables = [

  "TWITCH_CLIENT_ID",

  "TWITCH_CLIENT_SECRET",

  "TWITCH_REDIRECT_URI"

];

for (const variable of requiredVariables) {

  if (!process.env[variable]) {

    console.error(`[ERROR] Missing ${variable} in .env`);

    process.exit(1);

  }

}


const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DASHBOARD_SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || "";

if (DASHBOARD_PASSWORD.length < 12) {
  console.error("[ERROR] Set DASHBOARD_PASSWORD in .env (at least 12 characters).");
  process.exit(1);
}

if (DASHBOARD_SESSION_SECRET.length < 32) {
  console.error("[ERROR] Set DASHBOARD_SESSION_SECRET in .env (at least 32 characters).");
  process.exit(1);
}

const SESSION_COOKIE = "sixpl_dashboard_session";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
const failedLogins = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const auth = createAuth({

  clientId: process.env.TWITCH_CLIENT_ID,

  clientSecret: process.env.TWITCH_CLIENT_SECRET,

  redirectUri: process.env.TWITCH_REDIRECT_URI

});

// ------------------------------

// CONFIGURATION

// ------------------------------

function loadConfig() {

  try {

    const saved = JSON.parse(

      fs.readFileSync(CONFIG_FILE, "utf8")

    );

    return {

      channel: saved.channel || "6pljay",

      recentChannels: Array.isArray(saved.recentChannels)

        ? saved.recentChannels

        : []

    };

  } catch {

    const initial = {

      channel: "6pljay",

      recentChannels: ["6pljay"]

    };

    saveConfig(initial);

    return initial;

  }

}

function saveConfig(data) {

  fs.writeFileSync(

    CONFIG_FILE,

    JSON.stringify(data, null, 2)

  );

}

let config = loadConfig();

function validChannel(channel) {

  return /^[a-zA-Z0-9_]{1,25}$/.test(channel);

}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// ------------------------------

// TWITCH CHAT CONNECTION

// ------------------------------

let chatSocket = null;

let chatStatus = "Disconnected";

let chatError = "";

let joinedChannel = "";

let shouldReconnect = false;

let reconnectTimer = null;

let connectionId = 0;

// Automatic JSON message rotation for the single bot account.

let autoSendTimer = null;

let autoSendCategory = "all";

let autoSendIntervalMs = 30 * 1000;

let autoSendLastMessage = "";

let autoSendLastSentAt = null;

let lastMessageSentAt = 0;

const MIN_SEND_GAP_MS = 5000;

function updateChatStatus(status, error = "") {

  chatStatus = status;

  chatError = error;

  console.log(`[CHAT] ${status}`);

  if (error) {

    console.error(`[CHAT ERROR] ${error}`);

  }

}

function sendIRC(message) {

  if (chatSocket && chatSocket.readyState === 1) {

    console.log("[IRC SEND]", message);

    chatSocket.send(message + "\r\n");

    return true;

  }

  return false;

}

function getMessageCategories() {

  const folder = path.join(__dirname, "messages");

  if (!fs.existsSync(folder)) return [];

  return fs.readdirSync(folder)

    .filter(file => file.endsWith(".json"))

    .map(file => path.basename(file, ".json"))

    .sort();

}

function getMessages(category = "all") {

  const folder = path.join(__dirname, "messages");

  const files = category === "all"

    ? getMessageCategories()

    : [category];

  const messages = [];

  for (const name of files) {

    const file = path.join(folder, `${name}.json`);

    if (!fs.existsSync(file)) continue;

    try {

      const data = JSON.parse(fs.readFileSync(file, "utf8"));

      if (Array.isArray(data)) {

        for (const item of data) {

          if (typeof item === "string" && item.trim()) {

            messages.push(item.trim());

          }

        }

      }

    } catch (error) {

      console.error(`[MESSAGES] Could not read ${name}.json:`, error.message);

    }

  }

  return messages;

}

function sendChatMessage(message) {

  const cleanMessage = String(message || "").replace(/[\r\n]+/g, " ").trim();

  if (!cleanMessage) {

    return { ok: false, error: "Type a message first." };

  }

  if (cleanMessage.length > 450) {

    return { ok: false, error: "Messages must be 450 characters or fewer." };

  }

  if (!chatSocket || chatSocket.readyState !== 1 || !joinedChannel) {

    return { ok: false, error: "Connect the bot to Twitch chat first." };

  }

  const remaining = MIN_SEND_GAP_MS - (Date.now() - lastMessageSentAt);

  if (remaining > 0) {

    return {

      ok: false,

      error: `Please wait ${Math.ceil(remaining / 1000)} seconds before sending another message.`

    };

  }

  const sent = sendIRC(`PRIVMSG #${joinedChannel} :${cleanMessage}`);

  if (!sent) {

    return { ok: false, error: "The Twitch chat connection is not ready." };

  }

  lastMessageSentAt = Date.now();

  console.log(`[BOT SENT] #${joinedChannel} | xxoofqwe: ${cleanMessage}`);

  return { ok: true };

}

function stopAutoSending() {

  if (autoSendTimer) {

    clearInterval(autoSendTimer);

    autoSendTimer = null;

  }

}

function startAutoSending(category, intervalSeconds) {

  const seconds = Number(intervalSeconds);

  const selectedCategory = String(category || "all");

  const validCategories = ["all", ...getMessageCategories()];

  if (!Number.isInteger(seconds) || seconds < 3 || seconds > 3600) {

    throw new Error("Choose an interval between 3 seconds and 60 minutes.");

  }

  if (!validCategories.includes(selectedCategory)) {

    throw new Error("Choose a valid message category.");

  }

  const messages = getMessages(selectedCategory);

  if (!messages.length) {

    throw new Error("There are no messages in that JSON category.");

  }

  if (!chatSocket || chatSocket.readyState !== 1 || !joinedChannel) {

    throw new Error("Connect the bot to Twitch chat before starting automatic messages.");

  }

  stopAutoSending();

  autoSendCategory = selectedCategory;

  autoSendIntervalMs = seconds * 1000;

  autoSendLastMessage = "";

  autoSendLastSentAt = null;

  const sendNextMessage = () => {

    const currentMessages = getMessages(autoSendCategory);

    if (!currentMessages.length) {

      console.log("[BOT AUTO] No messages found. Stopping automatic messages.");

      stopAutoSending();

      return;

    }

    // Avoid sending the same message twice in a row when alternatives exist.

    const choices = currentMessages.length > 1

      ? currentMessages.filter(message => message !== autoSendLastMessage)

      : currentMessages;

    const message = choices[Math.floor(Math.random() * choices.length)];

    const result = sendChatMessage(message);

    if (result.ok) {

      autoSendLastMessage = message;

      autoSendLastSentAt = new Date().toISOString();

      console.log(`[BOT AUTO] Sent from ${autoSendCategory}. Next message in ${autoSendIntervalMs / 1000} seconds.`);

    } else {

      console.log("[BOT AUTO] Message not sent:", result.error);

    }

  };

  autoSendTimer = setInterval(sendNextMessage, autoSendIntervalMs);

  console.log(`[BOT AUTO] Started for #${joinedChannel}; category=${autoSendCategory}; interval=${autoSendIntervalMs / 1000}s; messages=${messages.length}.`);

}

function scheduleReconnect() {

  if (!shouldReconnect || reconnectTimer) {

    return;

  }

  console.log("[CHAT] Reconnecting in 5 seconds...");

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    if (shouldReconnect) {

      connectChat();

    }

  }, 5000);

}

async function connectChat() {

  shouldReconnect = true;

  if (reconnectTimer) {

    clearTimeout(reconnectTimer);

    reconnectTimer = null;

  }

  const thisConnection = ++connectionId;

  if (chatSocket) {

    try {

      chatSocket.close();

    } catch {}

  }

  chatSocket = null;

  joinedChannel = "";

  updateChatStatus("Connecting");

  try {

    if (typeof WebSocket === "undefined") {

      throw new Error("Node.js WebSocket support is unavailable.");

    }

    if (!fs.existsSync(TOKEN_FILE)) {

      throw new Error("No saved Twitch credentials.");

    }

    let tokens = JSON.parse(

      fs.readFileSync(TOKEN_FILE, "utf8")

    );

    let account;

    try {

      account = await auth.validateToken(

        tokens.access_token

      );

    } catch {

      console.log("[CHAT] Refreshing Twitch token...");

      tokens = await auth.refreshToken();

      account = await auth.validateToken(

        tokens.access_token

      );

    }

    if (thisConnection !== connectionId) return;

    const scopes = account.scopes || [];

    if (!scopes.includes("chat:read")) {

      throw new Error(

        "Missing chat:read permission. Reauthorize Twitch."

      );

    }

    if (!scopes.includes("chat:edit")) {

      throw new Error(

        "Missing chat:edit permission. Reauthorize Twitch from the dashboard."

      );

    }

    console.log(`[CHAT] Twitch account: ${account.login}`);

    console.log(`[CHAT] Target channel: #${config.channel}`);

    console.log("[CHAT] Opening WebSocket...");

    const socket = new WebSocket(IRC_URL);

    chatSocket = socket;

    socket.addEventListener("open", () => {

      if (thisConnection !== connectionId) return;

      console.log("[CHAT] WebSocket opened.");

      socket.send(`PASS oauth:${tokens.access_token}\r\n`);

      socket.send(`NICK ${account.login}\r\n`);

      socket.send(

        "CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands\r\n"

      );

      updateChatStatus("Authenticating");

    });

    // ------------------------------

    // INCOMING IRC DATA

    // ------------------------------

    socket.addEventListener("message", event => {

      if (thisConnection !== connectionId) return;

      const raw = String(event.data);

      console.log("[IRC RAW]", JSON.stringify(raw));

      const messages = raw.split(/\r\n|\n/);

      for (const line of messages) {

        if (!line.trim()) continue;

        // Twitch keepalive.

        if (line.startsWith("PING")) {

          const pong = line.replace(/^PING/, "PONG");

          console.log("[IRC SEND]", pong);

          socket.send(pong + "\r\n");

          continue;

        }

        // Successful IRC authentication.

        if (line.includes(" 001 ")) {

          console.log("[CHAT] IRC authentication successful.");

          socket.send(`JOIN #${config.channel}\r\n`);

          updateChatStatus(`Joining #${config.channel}`);

          continue;

        }

        // Twitch confirms the account joined the channel.

        const joinMatch = line.match(

          /^:([^!]+)!.* JOIN #([a-zA-Z0-9_]+)/i

        );

        if (joinMatch) {

          const username = joinMatch[1].toLowerCase();

          const channel = joinMatch[2].toLowerCase();

          if (username === account.login.toLowerCase()) {

            joinedChannel = channel;

            updateChatStatus(

              `Connected to #${channel}`

            );

          }

          continue;

        }

        // Twitch notices.

        if (line.includes("NOTICE")) {

          console.log("[TWITCH NOTICE]", line);

          continue;

        }

        // Capability responses.

        if (line.includes("CAP * ACK")) {

          console.log("[CHAT] Twitch capabilities accepted.");

          continue;

        }

        if (line.includes("CAP * NAK")) {

          console.log("[CHAT] Twitch rejected capabilities:", line);

          continue;

        }

        // Twitch may request a reconnect.

        if (line.includes("RECONNECT")) {

          console.log("[CHAT] Twitch requested reconnection.");

          try {

            socket.close();

          } catch {}

          continue;

        }

        // ------------------------------

        // CHAT MESSAGE PARSING

        // ------------------------------

        if (line.includes("PRIVMSG")) {

          // Remove optional Twitch metadata tags.

          const messageLine = line.startsWith("@")

            ? line.slice(line.indexOf(" ") + 1)

            : line;

          const match = messageLine.match(

            /^:([^! ]+)!.*\sPRIVMSG #([^ ]+) :(.*)$/

          );

          if (match) {

            const username = match[1];

            const channel = match[2];

            const message = match[3];

            console.log(

              `[CHAT] #${channel} | ${username}: ${message}`

            );

          } else {

            console.log("[CHAT] Could not parse:", line);

          }

          continue;

        }

        // Log other IRC events while debugging.

        console.log("[IRC EVENT]", line);

      }

    });

    socket.addEventListener("error", error => {

      if (thisConnection !== connectionId) return;

      console.error("[CHAT] WebSocket error:", error);

      updateChatStatus(

        "Connection error",

        "Could not connect to Twitch IRC."

      );

    });

    socket.addEventListener("close", event => {

      if (thisConnection !== connectionId) return;

      console.log(

        `[CHAT] WebSocket closed. Code: ${event.code}`

      );

      chatSocket = null;

      joinedChannel = "";

      if (shouldReconnect) {

        updateChatStatus("Disconnected; reconnecting");

        scheduleReconnect();

      } else {

        updateChatStatus("Disconnected");

      }

    });

  } catch (error) {

    if (thisConnection !== connectionId) return;

    updateChatStatus("Connection failed", error.message);

    scheduleReconnect();

  }

}

function disconnectChat() {

  shouldReconnect = false;

  stopAutoSending();

  if (reconnectTimer) {

    clearTimeout(reconnectTimer);

    reconnectTimer = null;

  }

  connectionId++;

  if (chatSocket) {

    try {

      chatSocket.close();

    } catch {}

  }

  chatSocket = null;

  joinedChannel = "";

  updateChatStatus("Disconnected");

}

// ------------------------------

// DASHBOARD

// ------------------------------

function page(content) {

  return `

  <!DOCTYPE html>

  <html>

  <head>

    <meta charset="UTF-8">

    <meta name="viewport" content="width=device-width, initial-scale=1">

    <title>6PL Chat Simulator</title>

    <style>

      * { box-sizing: border-box; }

      body {

        margin: 0;

        padding: 30px;

        background: #0e0e10;

        color: white;

        font-family: Arial, sans-serif;

      }

      main {

        max-width: 850px;

        margin: auto;

      }

      h1 { margin-bottom: 5px; }

      .muted { color: #adadb8; }

      .card {

        background: #18181b;

        border: 1px solid #303036;

        border-radius: 12px;

        padding: 22px;

        margin-top: 20px;

      }

      input {

        width: 100%;

        padding: 13px;

        border: 1px solid #444;

        border-radius: 7px;

        background: #0e0e10;

        color: white;

        margin: 12px 0;

        font-size: 15px;

      }

      button {

        background: #9147ff;

        border: none;

        border-radius: 7px;

        padding: 12px 18px;

        color: white;

        cursor: pointer;

        font-weight: bold;

        margin: 4px;

      }

      button:hover { background: #772ce8; }

      .secondary { background: #303036; }

      .danger { background: #c0392b; }

      .status {

        color: #00d084;

        font-weight: bold;

      }

      .error { color: #ff6961; }

      a { color: #bf94ff; }

      .channel {

        font-size: 25px;

        font-weight: bold;

      }

      .recent {

        display: flex;

        flex-wrap: wrap;

        gap: 5px;

      }

      select, textarea {

        width: 100%;

        padding: 13px;

        border: 1px solid #444;

        border-radius: 7px;

        background: #0e0e10;

        color: white;

        margin: 12px 0;

        font-size: 15px;

      }

      textarea {

        min-height: 90px;

        resize: vertical;

      }

      .inline-form { margin-top: 12px; }

      .success { color: #00d084; }

    </style>

  </head>

  <body>

    <main>

      ${content}

    </main>

  </body>

  </html>

  `;

}

// ------------------------------


// ------------------------------
// PASSWORD-PROTECTED DASHBOARD
// ------------------------------

app.set("trust proxy", 1);

function signSession(expiry) {
  return crypto
    .createHmac("sha256", DASHBOARD_SESSION_SECRET)
    .update(String(expiry))
    .digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

function hasValidSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  const separator = token.indexOf(".");
  if (separator === -1) return false;

  const expiryText = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expiry = Number(expiryText);

  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  return safeEqual(signature, signSession(expiry));
}

function setSessionCookie(req, res) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS;
  const token = `${expiry}.${signSession(expiry)}`;
  const secure = req.secure ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME_SECONDS}${secure}`
  );
}

function clearSessionCookie(req, res) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}

function loginPage(error = "") {
  return page(`
    <section class="card" style="max-width:430px;margin:12vh auto">
      <h1>6PL Dashboard</h1>
      <p class="muted">Enter your private dashboard password to continue.</p>
      ${error ? `<p class="error">${escapeHTML(error)}</p>` : ""}
      <form action="/login" method="POST">
        <label for="password">Dashboard password</label>
        <input id="password" name="password" type="password"
          autocomplete="current-password" required autofocus>
        <button type="submit">Unlock Dashboard</button>
      </form>
    </section>
  `);
}

app.get("/login", (req, res) => {
  if (hasValidSession(req)) return res.redirect("/");
  res.setHeader("Cache-Control", "no-store");
  res.send(loginPage());
});

app.post("/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempts = failedLogins.get(ip);

  if (attempts && now - attempts.startedAt < LOGIN_WINDOW_MS &&
      attempts.count >= MAX_LOGIN_ATTEMPTS) {
    return res.status(429).send(
      loginPage("Too many failed attempts. Wait 15 minutes and try again.")
    );
  }

  const supplied = String(req.body.password || "");
  if (!safeEqual(supplied, DASHBOARD_PASSWORD)) {
    const current = failedLogins.get(ip);
    if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
      failedLogins.set(ip, { startedAt: now, count: 1 });
    } else {
      current.count += 1;
    }

    return res.status(401).send(loginPage("Incorrect password."));
  }

  failedLogins.delete(ip);
  setSessionCookie(req, res);
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  clearSessionCookie(req, res);
  res.redirect("/login");
});

// All dashboard pages, APIs, and Twitch actions require a valid login.
app.use((req, res, next) => {
  if (req.path === "/login") return next();
  if (hasValidSession(req)) return next();

  res.setHeader("Cache-Control", "no-store");
  if (req.path === "/status" || req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Login required." });
  }

  return res.redirect("/login");
});

// MAIN PAGE

// ------------------------------

app.get("/", async (req, res) => {

  let accountName = "Not connected";

  let authenticated = false;

  try {

    if (fs.existsSync(TOKEN_FILE)) {

      const tokens = JSON.parse(

        fs.readFileSync(TOKEN_FILE, "utf8")

      );

      const account = await auth.validateToken(

        tokens.access_token

      );

      authenticated = true;

      accountName = account.login;

    }

  } catch {

    authenticated = false;

  }

  const recent = (config.recentChannels || [])

    .map(channel => `

      <button

        class="secondary"

        onclick="document.getElementById('channel').value='${escapeHTML(channel)}'"

      >

        ${escapeHTML(channel)}

      </button>

    `).join("");

  const chatColor = chatStatus.startsWith("Connected")

    ? "status"

    : "muted";

  res.send(page(`

    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h1>6PL Chat Simulator</h1>
      <form action="/logout" method="POST" style="margin:0">
        <button type="submit" class="secondary">Log out</button>
      </form>
    </div>

    <p class="muted">

      Twitch chat management dashboard

    </p>

    <section class="card">

      <h2>Twitch Account</h2>

      <p>

        Account:

        <strong>${escapeHTML(accountName)}</strong>

      </p>

      <p class="${authenticated ? "status" : "error"}">

        ${authenticated ? "● OAuth authenticated" : "● Not authenticated"}

      </p>

      ${

        authenticated

          ? ""

          : '<a href="/auth/start">Connect Twitch account</a>'

      }

    </section>

    <section class="card">

      <h2>Channel Selection</h2>

      <p class="muted">Current channel</p>

      <div class="channel">

        #${escapeHTML(config.channel)}

      </div>

      <form action="/channel" method="POST">

        <input

          id="channel"

          name="channel"

          placeholder="Enter Twitch channel username"

          required

          maxlength="25"

        >

        <button type="submit">Switch Channel</button>

      </form>

      <h3>Recently used</h3>

      <div class="recent">

        ${recent}

      </div>

    </section>

    <section class="card">

      <h2>Twitch Chat Connection</h2>

      <p>

        Status:

        <strong class="${chatColor}">

          ${escapeHTML(chatStatus)}

        </strong>

      </p>

      ${

        chatError

          ? `<p class="error">${escapeHTML(chatError)}</p>`

          : ""

      }

      <p class="muted">Account: xxoofqwe</p>

      <p class="muted">Target: #${escapeHTML(config.channel)}</p>

      <form action="/chat/connect" method="POST">

        <button type="submit">Connect to Chat</button>

      </form>

      <form action="/chat/disconnect" method="POST">

        <button type="submit" class="danger">Disconnect</button>

      </form>

      <p class="muted">

        Receives chat and sends messages as xxoofqwe.

      </p>

    </section>

    <section class="card">

      <h2>Send a Message</h2>

      <p class="muted">

        Messages are sent by the single bot account <strong>xxoofqwe</strong>.

      </p>

      <form action="/chat/send" method="POST">

        <textarea

          name="message"

          maxlength="450"

          placeholder="Type a message to send to #${escapeHTML(config.channel)}"

          required

        ></textarea>

        <button type="submit">Send Message</button>

      </form>

      <form action="/chat/send-random" method="POST">

        <label for="manualCategory">Or send a random message from a category:</label>

        <select id="manualCategory" name="category">

          <option value="all">All categories</option>

          ${getMessageCategories().map(category =>

            `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`

          ).join("")}

        </select>

        <button type="submit" class="secondary">Send Random Message</button>

      </form>

      <p class="muted"><a href="/messages">View message library</a></p>

    </section>

    <section class="card">

      <h2>Automatic JSON Messages</h2>

      <p class="muted">

        ${autoSendTimer

          ? `● Running — random message from ${escapeHTML(autoSendCategory)} every ${autoSendIntervalMs / 1000} seconds`

          : "● Stopped"}

      </p>

      <p class="muted">The bot selects a random message from your JSON library each time. It avoids repeating the same message twice in a row when possible.</p>

      <form action="/chat/auto/start" method="POST">

        <label for="autoCategory">Message category</label>

        <select id="autoCategory" name="category">

          <option value="all" ${autoSendCategory === "all" ? "selected" : ""}>All JSON files</option>

          ${getMessageCategories().map(category =>

            `<option value="${escapeHTML(category)}" ${autoSendCategory === category ? "selected" : ""}>${escapeHTML(category)}</option>`

          ).join("")}

        </select>

        <label for="intervalSeconds">Send interval (seconds)</label>

        <input

          id="intervalSeconds"

          name="interval"

          type="number"

          min="3"

          max="3600"

          step="1"

          value="${autoSendIntervalMs / 1000}"

          required

        >

        <p class="muted">Choose from 3 seconds up to 60 minutes. The bot sends as xxoofqwe.</p>

        <button type="submit">Start Automatic Messages</button>

      </form>

      <form action="/chat/auto/stop" method="POST">

        <button type="submit" class="danger">Stop Automatic Messages</button>

      </form>

    </section>

    <section class="card">

      <h2>System</h2>

      <p>Server: <span class="status">Running</span></p>

      <p>Configuration: config.json</p>

      <p>Credentials: locally stored</p>

    </section>

  `));

});

// ------------------------------

// CHANNEL SWITCH

// ------------------------------

app.post("/channel", (req, res) => {

  const channel = String(req.body.channel || "")

    .trim()

    .replace(/^@/, "")

    .toLowerCase();

  if (!validChannel(channel)) {

    return res.status(400).send(

      page(`

        <h1>Invalid channel</h1>

        <p>Enter a valid Twitch username.</p>

        <a href="/">Go back</a>

      `)

    );

  }

  config.channel = channel;

  config.recentChannels = [

    channel,

    ...config.recentChannels.filter(

      item => item !== channel

    )

  ].slice(0, 10);

  saveConfig(config);

  if (shouldReconnect) {

    connectChat();

  }

  res.redirect("/");

});

// ------------------------------

// CHAT CONTROLS

// ------------------------------

app.post("/chat/connect", (req, res) => {

  connectChat();

  res.redirect("/");

});

app.post("/chat/disconnect", (req, res) => {

  disconnectChat();

  res.redirect("/");

});

app.post("/chat/send", (req, res) => {

  const result = sendChatMessage(req.body.message);

  if (!result.ok) {

    return res.status(400).send(page(`

      <h1>Message not sent</h1>

      <p class="error">${escapeHTML(result.error)}</p>

      <a href="/">Back to dashboard</a>

    `));

  }

  res.redirect("/");

});

app.post("/chat/send-random", (req, res) => {

  const category = String(req.body.category || "all");

  const messages = getMessages(category);

  if (!messages.length) {

    return res.status(400).send(page(`

      <h1>No messages found</h1>

      <p class="error">That category has no messages.</p>

      <a href="/">Back to dashboard</a>

    `));

  }

  const message = messages[Math.floor(Math.random() * messages.length)];

  const result = sendChatMessage(message);

  if (!result.ok) {

    return res.status(400).send(page(`

      <h1>Message not sent</h1>

      <p class="error">${escapeHTML(result.error)}</p>

      <a href="/">Back to dashboard</a>

    `));

  }

  res.redirect("/");

});

app.post("/chat/auto/start", (req, res) => {

  try {

    startAutoSending(req.body.category, req.body.interval);

    res.redirect("/");

  } catch (error) {

    res.status(400).send(page(`

      <h1>Automatic sending not started</h1>

      <p class="error">${escapeHTML(error.message)}</p>

      <a href="/">Back to dashboard</a>

    `));

  }

});

app.post("/chat/auto/stop", (req, res) => {

  stopAutoSending();

  res.redirect("/");

});

// ------------------------------

// MESSAGE LIBRARY

// ------------------------------

app.get("/messages", (req, res) => {

  const folder = path.join(__dirname, "messages");

  let categories = [];

  if (fs.existsSync(folder)) {

    categories = fs.readdirSync(folder)

      .filter(file => file.endsWith(".json"));

  }

  const items = categories.map(file => {

    const category = file.replace(".json", "");

    let count = 0;

    try {

      const data = JSON.parse(

        fs.readFileSync(

          path.join(folder, file),

          "utf8"

        )

      );

      count = Array.isArray(data) ? data.length : 0;

    } catch {}

    return `

      <div class="card">

        <strong>${escapeHTML(category)}</strong>

        <p class="muted">${count} messages</p>

      </div>

    `;

  }).join("");

  res.send(page(`

    <h1>Message Library</h1>

    ${items || "<p>No message categories found.</p>"}

    <p><a href="/">Back to dashboard</a></p>

  `));

});

// ------------------------------

// OAUTH

// ------------------------------

app.get("/auth/start", (req, res) => {

  res.redirect(auth.getAuthorizationUrl());

});

app.get("/auth/callback", async (req, res) => {

  try {

    const { code, state, error } = req.query;

    if (error) {

      return res.status(400).send(

        "Twitch authorization was denied."

      );

    }

    if (!code || !auth.verifyState(state)) {

      return res.status(400).send(

        "Invalid authorization state. Restart authorization."

      );

    }

    const tokens = await auth.exchangeCode(code);

    const account = await auth.validateToken(

      tokens.access_token

    );

    console.log(

      `[AUTH] Successfully connected: ${account.login}`

    );

    res.redirect("/");

  } catch (error) {

    console.error("[AUTH] Callback error:", error.message);

    res.status(500).send("Authentication failed.");

  }

});

// ------------------------------

// STATUS API

// ------------------------------

app.get("/status", async (req, res) => {

  let authenticated = false;

  let accountName = null;

  try {

    if (fs.existsSync(TOKEN_FILE)) {

      const tokens = JSON.parse(

        fs.readFileSync(TOKEN_FILE, "utf8")

      );

      const account = await auth.validateToken(

        tokens.access_token

      );

      authenticated = true;

      accountName = account.login;

    }

  } catch {

    authenticated = false;

  }

  res.json({

    authenticated,

    account: accountName,

    channel: config.channel,

    chat: {

      status: chatStatus,

      connected: chatStatus.startsWith("Connected"),

      joinedChannel,

      error: chatError

    },

    outgoing: {

      automatic: Boolean(autoSendTimer),

      category: autoSendCategory,

      intervalSeconds: autoSendIntervalMs / 1000,

      lastMessage: autoSendLastMessage,

      lastSentAt: autoSendLastSentAt

    }

  });

});

// ------------------------------

// START SERVER

// ------------------------------

app.listen(PORT, "127.0.0.1", async () => {

  console.log("--------------------------------");

  console.log("       6PL CHAT SIMULATOR");

  console.log("--------------------------------");

  console.log(`Dashboard: http://localhost:${PORT}`);

  console.log(`Channel: #${config.channel}`);

  await auth.initialize();

  setInterval(() => {

    auth.hourlyValidation();

  }, 60 * 60 * 1000);

});