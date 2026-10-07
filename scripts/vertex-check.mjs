import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error("Set GOOGLE_CLOUD_PROJECT in .env.");
const ai = new GoogleGenAI({
  vertexai: true,
  project,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
  httpOptions: { timeout: 30000 },
});
try {
  const response = await ai.models.generateContent({
    model: process.env.VERTEX_MODEL || "gemini-2.5-flash",
    contents: "Reply with only: Vertex AI connected.",
    config: { maxOutputTokens: 128 },
  });
  console.log(
    response.text || "Vertex AI request succeeded (no text returned).",
  );
} catch (error) {
  console.error("Vertex AI connection failed:", error.message);
  console.error("Run: gcloud auth application-default login");
  console.error(
    `Then: gcloud auth application-default set-quota-project ${project}`,
  );
  process.exitCode = 1;
}
