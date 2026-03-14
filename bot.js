const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Falta la variable GEMINI_API_KEY");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const historial = {};

const PERSONALIDAD = [
  "Eres Matias respondiendo sus mensajes de WhatsApp.",
  "Responde en primera persona.",
  "Tono directo, claro, cercano y humano.",
  "Maximo 3 lineas.",
  "Nunca digas que eres una IA.",
  "Si no sabes algo exacto, di que lo confirmare personalmente.",
  "Si el mensaje parece de familia o amigos, responde mas natural."
].join(" ");

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth"
  }),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

client.on("qr", (qr) => {
  console.log("ESCANEA ESTE QR CON WHATSAPP");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("BOT_LISTO");
});

client.on("auth_failure", (msg) => {
  console.error("AUTH_FAILURE:", msg);
});

client.on("disconnected", (reason) => {
  console.log("DISCONNECTED:", reason);
});

client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;
    if (msg.from.includes("status")) return;

    const texto = (msg.body || "").trim();
    if (!texto) return;

    const id = msg.from;

    if (!historial[id]) historial[id] = [];

    historial[id].push({
      role: "user",
      parts: [{ text: texto }]
    });

    if (historial[id].length > 10) {
      historial[id].shift();
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: PERSONALIDAD
    });

    const chat = model.startChat({
      history: historial[id].slice(0, -1)
    });

    const result = await chat.sendMessage(texto);
    let respuesta = result.response.text().trim();

    if (!respuesta) {
      respuesta = "Ahora te respondo.";
    }

    historial[id].push({
      role: "model",
      parts: [{ text: respuesta }]
    });

    await msg.reply(respuesta);
    console.log("RESPONDIDO:", id, respuesta);
  } catch (error) {
    console.error("ERROR_GEMINI:", error.message || error);
  }
});

client.initialize();
