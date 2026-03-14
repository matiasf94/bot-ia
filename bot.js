const express = require("express");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Falta GEMINI_API_KEY");
}

const AI_DELAY_MS = 5 * 60 * 1000; // 5 minutos

const app = express();
const PORT = process.env.PORT || 3000;

let qrImageDataUrl = null;
let botStatus = "iniciando";
const chats = {};

function getChatState(chatId) {
  if (!chats[chatId]) {
    chats[chatId] = {
      history: [],
      pendingTimer: null,
      humanTookOver: false,
      ignoreNextOwnMessage: false,
      lastInboundText: ""
    };
  }
  return chats[chatId];
}

function trimHistory(state) {
  if (state.history.length > 20) {
    state.history = state.history.slice(-20);
  }
}

function clearPendingTimer(state) {
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }
}

app.get("/", (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta http-equiv="refresh" content="5" />
      <title>QR WhatsApp Bot</title>
      <style>
        body {
          margin: 0;
          font-family: Arial, sans-serif;
          background: #0f172a;
          color: white;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
        }
        .box {
          background: #111827;
          padding: 24px;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
          text-align: center;
          max-width: 560px;
          width: 92%;
        }
        h1 { margin-top: 0; font-size: 24px; }
        p { opacity: 0.9; }
        img {
          width: 100%;
          max-width: 420px;
          background: white;
          padding: 16px;
          border-radius: 12px;
          margin-top: 16px;
        }
        .status {
          margin-top: 12px;
          font-size: 14px;
          opacity: 0.8;
        }
        .ok { color: #22c55e; }
        .warn { color: #facc15; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>WhatsApp Bot</h1>
        ${
          botStatus === "ready"
            ? `<p class="ok">Bot conectado correctamente.</p>`
            : qrImageDataUrl
              ? `<p>Escanea este QR desde WhatsApp → Dispositivos vinculados.</p><img src="${qrImageDataUrl}" alt="QR WhatsApp" /><p class="status warn">Estado: esperando escaneo...</p>`
              : `<p>Generando QR o iniciando sesión...</p><p class="status">Estado: ${botStatus}</p>`
        }
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: botStatus });
});

app.listen(PORT, () => {
  console.log("WEB_QR_LISTENING_PORT:", PORT);
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PERSONALIDAD = [
  "Eres el agente personal de Matias Figueroa, emprendedor chileno.",
  "Nunca hables como si fueras Matias. Hablas como su agente personal.",
  "Debes responder en español de Chile natural, claro, simple y profesional.",
  "Nunca uses modismos argentinos como: vos, tenes, queres, che, dale, barbaro, laburo, pibe, boludo.",
  "Cuando respondas, di de forma natural que eres el agente personal de Matias y que el retomara la conversacion cuando vuelva.",
  "No inventes informacion. Si no sabes algo exacto, di que Matias lo revisara cuando vuelva.",
  "Maximo 3 lineas por respuesta.",
  "No suenes robotico ni exageradamente formal."
].join(" ");

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth"
  }),
  authTimeoutMs: 120000,
  qrMaxRetries: 10,
  puppeteer: {
    headless: true,
    timeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding"
    ]
  }
});

client.on("qr", async (qr) => {
  try {
    botStatus = "esperando_qr";
    qrImageDataUrl = await QRCode.toDataURL(qr, {
      width: 500,
      margin: 2
    });
    console.log("QR_WEB_READY");
  } catch (e) {
    console.error("QR_RENDER_ERROR:", e.message || e);
  }
});

client.on("ready", () => {
  botStatus = "ready";
  qrImageDataUrl = null;
  console.log("BOT_LISTO");
});

client.on("authenticated", () => {
  botStatus = "authenticated";
  console.log("AUTHENTICATED");
});

client.on("auth_failure", (msg) => {
  botStatus = "auth_failure";
  console.error("AUTH_FAILURE:", msg);
});

client.on("disconnected", (reason) => {
  botStatus = "disconnected";
  qrImageDataUrl = null;
  console.log("DISCONNECTED:", reason);
});

client.on("message_create", async (msg) => {
  if (!msg.fromMe) return;

  const chatId = msg.to || msg.from;
  if (!chatId) return;
  if (chatId.includes("status")) return;
  if (chatId.endsWith("@g.us")) return;

  const texto = (msg.body || "").trim();
  const state = getChatState(chatId);

  if (state.ignoreNextOwnMessage) {
    state.ignoreNextOwnMessage = false;
    return;
  }

  clearPendingTimer(state);
  state.humanTookOver = true;

  if (texto) {
    state.history.push({
      role: "model",
      parts: [{ text: texto }]
    });
    trimHistory(state);
  }

  console.log("TAKEOVER_HUMANO:", chatId);
});

async function responderComoAgente(chatId) {
  const state = getChatState(chatId);

  if (state.humanTookOver) return;
  if (!state.lastInboundText) return;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: PERSONALIDAD
    });

    const chat = model.startChat({
      history: state.history.slice(0, -1)
    });

    const result = await chat.sendMessage(state.lastInboundText);
    let respuesta = result.response.text().trim();

    if (!respuesta) {
      respuesta = "Hola, soy el agente personal de Matias. El retomara la conversacion cuando vuelva.";
    }

    state.history.push({
      role: "model",
      parts: [{ text: respuesta }]
    });
    trimHistory(state);

    state.ignoreNextOwnMessage = true;
    await client.sendMessage(chatId, respuesta);

    console.log("RESPONDIDO:", chatId, respuesta);
  } catch (error) {
    console.error("ERROR_GEMINI:", error.message || error);
  }
}

client.on("message", async (msg) => {
  if (msg.fromMe) return;

  const chatId = msg.from;
  if (!chatId) return;
  if (chatId.includes("status")) return;
  if (chatId.endsWith("@g.us")) return;

  const texto = (msg.body || "").trim();
  if (!texto) return;

  const state = getChatState(chatId);

  state.history.push({
    role: "user",
    parts: [{ text: texto }]
  });
  trimHistory(state);

  state.lastInboundText = texto;

  if (state.humanTookOver) {
    console.log("MODO_HUMANO_ACTIVO:", chatId);
    return;
  }

  clearPendingTimer(state);

  state.pendingTimer = setTimeout(() => {
    responderComoAgente(chatId);
  }, AI_DELAY_MS);

  console.log("TEMPORIZADOR_IA_5_MIN:", chatId);
});

(async () => {
  try {
    botStatus = "iniciando_cliente";
    console.log("INICIANDO_CLIENTE");
    await client.initialize();
  } catch (e) {
    botStatus = "init_error";
    console.error("INIT_ERROR:", e.message || e);
  }
})();
