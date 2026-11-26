// A stand-in for Azure Speech in e2e (PLAN T2 acceptance: "the Azure client stubbed"). Answers a
// synthesis POST with a short silent MP3, or HTTP 500 when the SSML contains 帽, so a test can
// see the PWA fall back to Web Speech. Never a real key or service: the e2e server's
// AZURE_SPEECH_ENDPOINT points here.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3102);
const FRAME = 417; // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, mono: zeros decode as silence
const mp3 = Buffer.alloc(FRAME * 8);
for (let f = 0; f < 8; f++) mp3.set([0xff, 0xfb, 0x90, 0xc0], f * FRAME);

createServer((req, res) => {
  if (req.method === "GET") return void res.end("ok");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.headers["ocp-apim-subscription-key"] || !body.startsWith("<speak")) {
      res.writeHead(400).end();
    } else if (body.includes("帽")) {
      res.writeHead(500).end();
    } else {
      res.writeHead(200, { "content-type": "audio/mpeg" }).end(mp3);
    }
  });
}).listen(PORT);
