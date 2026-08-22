import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import OpenAI from "openai";

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ALLOWED_CATEGORIES = new Set([
  "One Word Substitution",
  "Idioms",
  "Antonyms & Synonyms",
  "Spellings",
  "Grammar"
]);

function cleanText(value, fallback = "") {
  return String(value || fallback).trim().slice(0, 300);
}

function cleanList(value) {
  const list = Array.isArray(value) ? value : [];
  const cleaned = [...new Set(list.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))]
    .filter((x) => x.length > 2)
    .slice(0, 2);
  return cleaned.length ? cleaned : ["Not available automatically"];
}

function extractJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON returned by model");
    try {
      // BUG FIX: Wrap final parse in try-catch to handle invalid JSON
      return JSON.parse(match[0]);
    } catch (e) {
      throw new Error(`Invalid JSON in model response: ${e.message}`);
    }
  }
}

export const generateVocabulary = onRequest(
  {
    region: "us-central1",
    cors: [
      "https://hellosamar.github.io",
      "http://localhost:5000",
      "http://127.0.0.1:5000"
    ],
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 60,
    maxInstances: 10
  },
  async (req, res) => {
    try {
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      // Validate HTTP method
      if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "POST required" });
        return;
      }

      // Validate and clean input EARLY
      const rawTerm = String(req.body?.term || "").trim();
      if (!rawTerm || rawTerm.length > 80) {
        res.status(400).json({ ok: false, error: "Enter a valid word or phrase under 80 characters." });
        return;
      }

      const term = cleanText(rawTerm);
      const category = cleanText(req.body?.category || "Antonyms & Synonyms");

      // Validate category
      if (!ALLOWED_CATEGORIES.has(category)) {
        res.status(400).json({ ok: false, error: "Invalid category." });
        return;
      }

      // Initialize OpenAI client
      const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
      const model = process.env.OPENAI_MODEL || "gpt-4o-mini"; // Updated default model

      // Call OpenAI with CORRECT API method (chat.completions, not responses)
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: 450,
        messages: [
          {
            role: "system",
            content:
              "You are an English vocabulary assistant for Indian government exam aspirants. " +
              "Return only valid JSON. No markdown. No extra text. Use natural, exam-appropriate English examples. " +
              "Do not force every sentence into exam context if it sounds unnatural. Hindi must be accurate and simple."
          },
          {
            role: "user",
            content:
              `Create one vocabulary revision entry.\n` +
              `Category: ${category}\n` +
              `Input: ${term}\n\n` +
              `Return JSON with exactly these keys:\n` +
              `meaning: Hindi meaning as a short Hindi phrase\n` +
              `synonyms: array of exactly 2 English synonyms, or [] if not suitable\n` +
              `antonyms: array of exactly 2 English antonyms, or [] if not suitable\n` +
              `example: one natural English sentence using the input\n` +
              `exampleHindi: Hindi meaning of the example sentence`
          }
        ]
      });

      // Extract and parse response
      const content = response.choices[0]?.message?.content || "";
      const parsed = extractJson(content);

      // Clean and normalize entry
      const entry = {
        meaning: cleanText(parsed.meaning, "Hindi meaning not available"),
        synonyms: cleanList(parsed.synonyms),
        antonyms: cleanList(parsed.antonyms),
        example: cleanText(parsed.example, `${term} is used in a natural English sentence.`),
        exampleHindi: cleanText(parsed.exampleHindi, "Hindi translation not available"),
        source: "OpenAI"
      };

      res.status(200).json({ ok: true, entry });
    } catch (error) {
      console.error("Vocabulary generation error:", error);
      res.status(500).json({
        ok: false,
        error: "AI generation failed. Check OPENAI_API_KEY secret, model access, and function logs."
      });
    }
  }
);
