import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";

async function check() {
  const envPath = path.join(process.cwd(), ".env.local");
  const envContent = fs.readFileSync(envPath, "utf-8");
  const apiKeyMatch = envContent.match(/GOOGLE_GEMINI_API_KEY=(.*)/);
  const apiKey = apiKeyMatch ? apiKeyMatch[1].replace(/["']/g, "").trim() : null;

  if (!apiKey) {
    console.error("API Key not found in .env.local");
    return;
  }

  console.log("Using API Key starting with:", apiKey.substring(0, 5));
  
  const genAI = new GoogleGenerativeAI(apiKey);
  
  try {
    // 1. List models
    console.log("Listing models...");
    // The listModels method might not be in all SDK versions, but let's try
    // Or we can just try a few known ones
    const models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash"];
    
    for (const m of models) {
      try {
        const model = genAI.getGenerativeModel({ model: m });
        await model.generateContent("Hello");
        console.log(`✅ Model ${m} is WORKING`);
      } catch (e) {
        console.log(`❌ Model ${m} FAILED: ${e.message}`);
      }
    }
  } catch (err) {
    console.error("General error:", err.message);
  }
}

check();
