const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { ElevenLabsClient } = require('elevenlabs');
const fetch = require('node-fetch'); 
const { GoogleGenAI, Type } = require('@google/genai'); 
require('dotenv').config();

const app = express();
app.use(express.json()); 
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });


const elevenlabsClient = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY
});
const ai = new GoogleGenAI({}); 


app.post('/api/extract-job', async (req, res) => {
  try {
    const { transcript } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    const jobSchema = {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING, description: "Action: 'PostJob' or 'FindJob'" },
        skill: { type: Type.STRING, description: "Profession", nullable: true },
        location: { type: Type.STRING, description: "Job location", nullable: true },
        workers: { type: Type.INTEGER, description: "Worker count", nullable: true },
        date: { type: Type.STRING, description: "Timeframe", nullable: true },
        experience_years: { type: Type.INTEGER, description: "Years of experience", nullable: true },
        is_fresher: { type: Type.BOOLEAN, description: "True if beginner/fresher", nullable: true }
      },
      required: ["intent", "skill", "location", "workers", "date", "experience_years", "is_fresher"],
    };

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: `Extract the job requirements from this transcript. If a piece of information is not present, use null for that field: "${transcript}"`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: jobSchema,
      }
    });

    const extractedData = JSON.parse(response.text);
    return res.json({ success: true, data: extractedData });

  } catch (error) {
    console.error("Gemini API Error:", error);
    return res.status(500).json({ error: "Failed to process transcript" });
  }
});


async function getLLMResponse(userSpokeText, languageHint) {
  console.log(`[LLM] Analyzing transcript via Gemini: "${userSpokeText}"`);

  try {
    const jobSchema = {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING, description: "Action: 'PostJob' or 'FindJob'" },
        skill: { type: Type.STRING, description: "Profession", nullable: true },
        location: { type: Type.STRING, description: "Job location", nullable: true },
        workers: { type: Type.INTEGER, description: "Worker count", nullable: true },
      },
      required: ["intent", "skill", "location", "workers"],
    };

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: `Extract the job requirements from this transcript. If a piece of information is not present, use null for that field: "${userSpokeText}"`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: jobSchema,
      }
    });

    const data = JSON.parse(response.text);
    console.log("[LLM] Gemini Extracted JSON:", data);


    if (data.intent === 'PostJob') {
      const count = data.workers || 'some';
      const skill = data.skill || 'workers';

      if (languageHint === "sarvam") {
        return `Theek hai, main ${count} ${skill} ke liye job post create kar raha hoon.`;
      }
      return `Got it. I am setting up a job post for ${count} ${skill}.`;
    }


    return languageHint === "sarvam"
      ? "Namaste! Aap job post karna chahte hain ya job dhoondhna?"
      : "Hello! Are you looking to hire workers or find a job?";

  } catch (error) {
    console.error("[LLM] Gemini generation failed:", error);
    return languageHint === "sarvam" ? "Maaf karna, mujhe samajh nahi aaya." : "Sorry, I didn't catch that.";
  }
}


const providers = {
  sarvam: async (text, langCode = "hi-IN") => {
    console.log(`[TTS] Requesting Sarvam Bulbul for text: ${text} in ${langCode}`);


    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': process.env.SARVAM_API_KEY
      },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: langCode, 
        speaker: "meera",
        pitch: 0,
        pace: 1.0,
        loudness: 1.5,
        speech_sample_rate: 8000, 
        enable_preprocessing: true,
        model: "bulbul:v1"
      })
    });

    if (!response.ok) {
      throw new Error(`Sarvam API failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return Buffer.from(data.audios[0], 'base64');
  },

  elevenlabs: async (text, langCode) => {
    console.log(`[TTS] Requesting ElevenLabs for text: ${text}`);


    const audioStream = await elevenlabsClient.textToSpeech.convert(
      process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb", 
      {
        text: text,
        model_id: "eleven_multilingual_v2",
        output_format: "ulaw_8000" 
      }
    );

    return new Promise((resolve, reject) => {
      const chunks = [];
      audioStream.on('data', chunk => chunks.push(chunk));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', reject);
    });
  }
};


const fillerAudioBuffer = Buffer.from("fake_filler_hmm_bytes");

async function generateAudioWithTimeout(text, activeProvider, langCode, ws) {
  let responseAudio;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TTFB_TIMEOUT")), 1500)
    );

    responseAudio = await Promise.race([
      providers[activeProvider](text, langCode),
      timeoutPromise
    ]);
    console.log(`[Success] Audio generated by ${activeProvider}`);

  } catch (error) {
    console.error(`[Error] ${activeProvider} failed: ${error.message}. Playing filler.`);
    sendAudioToExotel(ws, fillerAudioBuffer);

    responseAudio = Buffer.from("simulated_google_cloud_audio");
  }

  sendAudioToExotel(ws, responseAudio);
}


function sendAudioToExotel(ws, audioBuffer) {
  if (ws.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({
      event: "media",
      media: {
        payload: audioBuffer.toString('base64')
      }
    });
    ws.send(payload);
    console.log(`[WebSocket] Sent audio chunk to Exotel`);
  }
}


wss.on('connection', (ws) => {
  console.log("=== New Exotel Call Connected ===");
  let activeProvider = "elevenlabs"; 
  let callLanguage = "en-US"; 

  ws.on('message', async (message) => {
    const msg = JSON.parse(message);


    if (msg.event === "connected") {
      const callerId = msg.from || msg.caller;
      console.log(`[Call Info] Caller: ${callerId}`);

      console.log("[IVR] Playing language selection menu...");
      const ivrMenu = "Welcome. For English, press 1. Bengali ke liye, 2 dabayein. Hindi ke liye, 3 dabayein.";


      await generateAudioWithTimeout(ivrMenu, "elevenlabs", "en-US", ws);
    }


    if (msg.event === "dtmf") {
      const digit = msg.dtmf?.digit || msg.dtmf; 
      console.log(`[IVR] Caller pressed: ${digit}`);

      if (digit === "1") {
        activeProvider = "sarvam";
        callLanguage = "bn-IN"; 
        await generateAudioWithTimeout("Apni Bangla beche niyechen. Ami kivabe sahajya korte pari?", activeProvider, callLanguage, ws);
        console.log("[Router] Assigned: Sarvam AI (Bengali)");

      } else if
        (digit === "2") {
        activeProvider = "elevenlabs";
        callLanguage = "en-US";
        await generateAudioWithTimeout("You have selected English. How can I help you today?", activeProvider, callLanguage, ws);
        console.log("[Router] Assigned: ElevenLabs (English)");

      } else if (digit === "3") {
        activeProvider = "sarvam";
        callLanguage = "hi-IN"; 
        await generateAudioWithTimeout("Aapne Hindi chuna hai. Main aapki kaise madad kar sakta hoon?", activeProvider, callLanguage, ws);
        console.log("[Router] Assigned: Sarvam AI (Hindi)");

      } else {
        await generateAudioWithTimeout("Invalid choice. Please press 1, 2, or 3.", "elevenlabs", "en-US", ws);
      }
    }

    if (msg.event === "media") {
    }


    if (msg.event === "stop") {
      console.log("=== Call Ended by Caller ===");
      ws.close();
    }
  });


  setTimeout(async () => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log("--- Simulating STT transcription completed ---");
      const llmText = await getLLMResponse("I want to hire 5 plumbers for my site.", activeProvider);
      await generateAudioWithTimeout(llmText, activeProvider, callLanguage, ws);
    }
  }, 5000);
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`If using Cloudflare Tunnels: Use your wss:// URL`);
});