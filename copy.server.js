import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

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
        workers: { type: Type.INTEGER, description: "Worker count", nullable: true },
        date: { type: Type.STRING, description: "Timeframe", nullable: true },
        experience_years: { type: Type.INTEGER, description: "Years of experience", nullable: true },
        is_fresher: { type: Type.BOOLEAN, description: "True if beginner/fresher", nullable: true }
      },
      required: ["intent", "skill", "workers", "date", "experience_years", "is_fresher"],
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running. Test in Postman at: POST http://localhost:${PORT}/api/extract-job`);
});