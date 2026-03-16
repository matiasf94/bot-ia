const { Client, LocalAuth } = require("whatsapp-web.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const historial = {};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] }
});

let pairingCode = null;
const PHONE = process.env.PHONE_NUMBER;

client.on("qr", async (qr) => {
  console.log("QR recibido, solicitando codigo de emparejamiento...");
  try {
    pairingCode = await client.requestPairingCode(PHONE);
    console.log("CODIGO DE EMPAREJAMIENTO: " + pairingCode);
  } catch(e) {
    console.error("Error pairing code:", e.message);
  }
});


client.on("message", async (msg) => {
  if (msg.fromMe || msg.from.includes("status")) return;
  const id = msg.from;
  const texto = msg.body;
  historial[id].push({ role: "user", parts: [{ text: texto }] });
  if (historial[id].length > 10) historial[id].shift();
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const chat = model.startChat({ history: historial[id].slice(0,-1), systemInstruction: "Eres el asistente de Matias, emprendedor chileno. Responde como el en primera persona, directo y cercano, maximo 3 lineas, nunca digas que eres IA." });
    const res = await chat.sendMessage(texto);
    const respuesta = res.response.text();
    historial[id].push({ role: "model", parts: [{ text: respuesta }] });
    await msg.reply(respuesta);
  } catch(e) { console.error(e.message); }
});

app.get("/", (req, res) => {
  res.send(pairingCode ? "Codigo: " + pairingCode : "Esperando codigo...");
});

app.listen(process.env.PORT || 3000);
client.initialize();
