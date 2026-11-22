import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createServer as createViteServer } from "vite";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { GoogleGenAI, Type } from "@google/genai";

interface FirebaseConfigFile {
  projectId: string;
}

interface AuthenticatedRequest extends Request {
  uid?: string;
  userEmail?: string;
}

type JobStatusType = "Generating" | "Processing" | "Completed" | "Failed";

interface GenerationJob {
  id: string;
  ownerUid: string;
  kind: "image" | "video";
  status: JobStatusType;
  stageLabel: string;
  createdAt: number;
  updatedAt: number;
  result?: {
    url: string;
    mimeType: string;
    interactionId?: string;
    promptUsed?: string;
  };
  errorMessage?: string;
}

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const UPLOADS_DIR = path.resolve(ROOT_DIR, "uploads");
const GENERATED_ASSETS_DIR = fs.existsSync(path.resolve(ROOT_DIR, "src", "assets", "images"))
  ? path.resolve(ROOT_DIR, "src", "assets", "images")
  : path.resolve(ROOT_DIR, "dist", "src", "assets", "images");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Initialize Firebase Admin solely for stateless ID token verification (no IAM required)
const firebaseConfigPath = path.resolve(ROOT_DIR, "firebase-applet-config.json");
let firebaseProjectId = process.env.FIREBASE_PROJECT_ID || "";
if (!firebaseProjectId && fs.existsSync(firebaseConfigPath)) {
  const firebaseConfigRaw = fs.readFileSync(firebaseConfigPath, "utf-8");
  const firebaseConfig = JSON.parse(firebaseConfigRaw) as FirebaseConfigFile;
  firebaseProjectId = firebaseConfig.projectId;
}

const adminApp = getApps().length
  ? getApp()
  : initializeApp(firebaseProjectId ? { projectId: firebaseProjectId } : undefined);
const adminAuth = getAuth(adminApp);

const jobs = new Map<string, GenerationJob>();

// Clean up completed/failed job entries older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.updatedAt < cutoff) {
      jobs.delete(id);
    }
  }
}, 15 * 60 * 1000).unref();

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Open Settings > Secrets to attach an API key."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function formatGeminiError(err: unknown): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes("permission_denied") ||
    lower.includes("api_key_invalid") ||
    lower.includes("api key not valid") ||
    lower.includes("403")
  ) {
    return {
      status: 403,
      message:
        "API key permission denied or invalid. Please check your GEMINI_API_KEY in Settings > Secrets.",
    };
  }
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("429") ||
    lower.includes("quota") ||
    lower.includes("billing") ||
    lower.includes("paid")
  ) {
    return {
      status: 429,
      message:
        "Quota exhausted or billing required for this media model. Select a billing-enabled API key in Settings > Secrets.",
    };
  }
  if (lower.includes("not_found") || lower.includes("404")) {
    return {
      status: 404,
      message: `Requested AI model endpoint was unavailable: ${raw}`,
    };
  }
  return {
    status: 500,
    message: raw || "Generation request failed.",
  };
}

async function requireFirebaseAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required. Please sign in." });
    return;
  }
  const idToken = authHeader.slice("Bearer ".length).trim();
  if (!idToken) {
    res.status(401).json({ error: "Invalid authorization token." });
    return;
  }
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.userEmail = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: "Session expired or invalid token. Please sign in again." });
  }
}

const ALLOWED_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

function sanitizeSafeFilePath(baseDir: string, filename: string): string | null {
  if (!/^[a-zA-Z0-9_.\-]+$/.test(filename)) {
    return null;
  }
  const resolved = path.resolve(baseDir, filename);
  if (!resolved.startsWith(baseDir + path.sep)) {
    return null;
  }
  return resolved;
}

function readLocalAssetAsBase64(mediaUrl: string): { data: string; mimeType: string } | null {
  if (!mediaUrl || typeof mediaUrl !== "string") return null;

  let filePath: string | null = null;
  if (mediaUrl.startsWith("/api/storage/files/")) {
    const fileName = mediaUrl.slice("/api/storage/files/".length);
    filePath = sanitizeSafeFilePath(UPLOADS_DIR, fileName);
  } else if (mediaUrl.startsWith("/src/assets/images/")) {
    const fileName = mediaUrl.slice("/src/assets/images/".length);
    filePath = sanitizeSafeFilePath(GENERATED_ASSETS_DIR, fileName);
  } else {
    return null;
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };
  const mimeType = mimeMap[ext];
  if (!mimeType) return null;

  const buffer = fs.readFileSync(filePath);
  return {
    data: buffer.toString("base64"),
    mimeType,
  };
}

interface CharacterRefPayload {
  name: string;
  entityType: string;
  appearancePrompt: string;
  referenceImageUrl?: string;
}

function buildConsistentPrompt(params: {
  prompt: string;
  visualStyle?: string;
  cameraMovement?: string;
  characters?: CharacterRefPayload[];
  modeLabel?: string;
}): string {
  const sections: string[] = [];

  if (params.characters && params.characters.length > 0) {
    const charLines = params.characters.map(
      (c) => `[${c.entityType.toUpperCase()} — ${c.name}]: ${c.appearancePrompt}`
    );
    sections.push(
      `Maintain strict visual consistency for these recurring subjects across frames:\n${charLines.join("\n")}`
    );
  }

  sections.push(`Scene Action & Subject:\n${params.prompt.trim()}`);

  const directionParts: string[] = [];
  if (params.visualStyle && params.visualStyle !== "Default") {
    directionParts.push(`Visual Style: ${params.visualStyle}`);
  }
  if (params.cameraMovement && params.cameraMovement !== "Static Locked") {
    directionParts.push(`Camera Movement: ${params.cameraMovement}`);
  }
  if (params.modeLabel) {
    directionParts.push(`Direction: ${params.modeLabel}`);
  }

  if (directionParts.length > 0) {
    sections.push(directionParts.join(" | "));
  }

  return sections.join("\n\n");
}

function updateJob(jobId: string, patch: Partial<GenerationJob>) {
  const existing = jobs.get(jobId);
  if (!existing) return;
  jobs.set(jobId, {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  });
}

async function runImageGenerationJob(
  jobId: string,
  payload: {
    prompt: string;
    aspectRatio: string;
    resolution: string;
    visualStyle?: string;
    cameraMovement?: string;
    referenceUrls?: string[];
    characters?: CharacterRefPayload[];
  }
) {
  try {
    const ai = getAiClient();
    const useNanoBanana21 = payload.resolution === "2K" || payload.resolution === "4K";
    const model = useNanoBanana21 ? "gemini-nano-banana-2.1" : "gemini-3.1-flash-lite-image";

    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];

    // Attach character reference portraits first for visual consistency
    if (payload.characters) {
      for (const ch of payload.characters.slice(0, 3)) {
        if (ch.referenceImageUrl) {
          const media = readLocalAssetAsBase64(ch.referenceImageUrl);
          if (media && media.mimeType.startsWith("image/")) {
            parts.push({ inlineData: { data: media.data, mimeType: media.mimeType } });
          }
        }
      }
    }

    // Attach user-uploaded / selected visual references
    if (payload.referenceUrls) {
      for (const refUrl of payload.referenceUrls.slice(0, 3)) {
        const media = readLocalAssetAsBase64(refUrl);
        if (media && media.mimeType.startsWith("image/")) {
          parts.push({ inlineData: { data: media.data, mimeType: media.mimeType } });
        }
      }
    }

    const fullPrompt = buildConsistentPrompt({
      prompt: payload.prompt,
      visualStyle: payload.visualStyle,
      cameraMovement: payload.cameraMovement,
      characters: payload.characters,
    });
    parts.push({ text: fullPrompt });

    const validAspect = ["1:1", "3:4", "4:3", "9:16", "16:9"].includes(payload.aspectRatio)
      ? payload.aspectRatio
      : "16:9";

    const response = await ai.models.generateContent({
      model,
      contents: { parts },
      config: {
        imageConfig: {
          aspectRatio: validAspect,
          ...(useNanoBanana21 ? { imageSize: payload.resolution } : {}),
        },
      },
    });

    updateJob(jobId, {
      status: "Processing",
      stageLabel: "Processing rendered frame & saving to project storage...",
    });

    let imageBase64: string | null = null;
    let mimeType = "image/png";

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        imageBase64 = part.inlineData.data;
        mimeType = part.inlineData.mimeType || "image/png";
        break;
      }
    }

    if (!imageBase64) {
      throw new Error("The AI model returned no image frame. Try refining the prompt.");
    }

    const ext = ALLOWED_MIME_EXTENSIONS[mimeType] || ".png";
    const fileName = `gen_img_${jobId}${ext}`;
    const safePath = sanitizeSafeFilePath(UPLOADS_DIR, fileName);
    if (!safePath) {
      throw new Error("Unable to resolve safe storage path.");
    }

    fs.writeFileSync(safePath, Buffer.from(imageBase64, "base64"));

    updateJob(jobId, {
      status: "Completed",
      stageLabel: "Completed",
      result: {
        url: `/api/storage/files/${fileName}`,
        mimeType,
        promptUsed: fullPrompt,
      },
    });
  } catch (err) {
    const formatted = formatGeminiError(err);
    updateJob(jobId, {
      status: "Failed",
      stageLabel: "Failed",
      errorMessage: formatted.message,
    });
  }
}

async function runVideoGenerationJob(
  jobId: string,
  payload: {
    mode: "text-to-video" | "image-to-video" | "keyframe-motion" | "video-edit";
    prompt: string;
    aspectRatio: string;
    durationSeconds: number;
    resolution: string;
    visualStyle?: string;
    cameraMovement?: string;
    startImageUrl?: string;
    endImageUrl?: string;
    referenceVideoUrl?: string;
    referenceUrls?: string[];
    characters?: CharacterRefPayload[];
    previousInteractionId?: string;
  }
) {
  try {
    const ai = getAiClient();

    type InteractionInputPart =
      | { type: "text"; text: string }
      | { type: "image"; mime_type: string; data: string }
      | { type: "video"; mime_type: string; data: string };

    const inputParts: InteractionInputPart[] = [];

    // Character portraits (counted inside up to 6 reference images)
    if (payload.characters) {
      for (const ch of payload.characters.slice(0, 2)) {
        if (ch.referenceImageUrl) {
          const media = readLocalAssetAsBase64(ch.referenceImageUrl);
          if (media && media.mimeType.startsWith("image/")) {
            inputParts.push({
              type: "image",
              mime_type: media.mimeType,
              data: media.data,
            });
          }
        }
      }
    }

    let modeInstruction = "";
    if (payload.mode === "image-to-video" && payload.startImageUrl) {
      const startMedia = readLocalAssetAsBase64(payload.startImageUrl);
      if (!startMedia) {
        throw new Error("Starting image reference could not be loaded from project storage.");
      }
      inputParts.push({
        type: "image",
        mime_type: startMedia.mimeType,
        data: startMedia.data,
      });
      modeInstruction = "Animate the provided starting frame smoothly with coherent motion.";
    } else if (payload.mode === "keyframe-motion" && payload.startImageUrl && payload.endImageUrl) {
      const startMedia = readLocalAssetAsBase64(payload.startImageUrl);
      const endMedia = readLocalAssetAsBase64(payload.endImageUrl);
      if (!startMedia || !endMedia) {
        throw new Error("Both start and end keyframe images must exist in project storage.");
      }
      inputParts.push({
        type: "image",
        mime_type: startMedia.mimeType,
        data: startMedia.data,
      });
      inputParts.push({
        type: "image",
        mime_type: endMedia.mimeType,
        data: endMedia.data,
      });
      modeInstruction =
        "Use the first image as the opening keyframe and transition seamlessly into the second image as the ending keyframe.";
    } else if (payload.mode === "video-edit" && payload.referenceVideoUrl) {
      const vidMedia = readLocalAssetAsBase64(payload.referenceVideoUrl);
      if (!vidMedia || !vidMedia.mimeType.startsWith("video/")) {
        throw new Error("Reference video could not be loaded from project storage.");
      }
      inputParts.push({
        type: "video",
        mime_type: vidMedia.mimeType,
        data: vidMedia.data,
      });
      modeInstruction = "Transform or continue the provided video clip as instructed.";
    }

    // Additional visual reference images
    if (payload.referenceUrls) {
      for (const refUrl of payload.referenceUrls.slice(0, 3)) {
        if (inputParts.length >= 6) break;
        const media = readLocalAssetAsBase64(refUrl);
        if (media && media.mimeType.startsWith("image/")) {
          inputParts.push({
            type: "image",
            mime_type: media.mimeType,
            data: media.data,
          });
        }
      }
    }

    const fullPrompt = buildConsistentPrompt({
      prompt: payload.prompt,
      visualStyle: payload.visualStyle,
      cameraMovement: payload.cameraMovement,
      characters: payload.characters,
      modeLabel: modeInstruction,
    });
    inputParts.push({ type: "text", text: fullPrompt });

    const maxDur = payload.mode === "keyframe-motion" ? 10 : 15;
    const clampedDur = Math.max(3, Math.min(maxDur, Math.round(payload.durationSeconds || 8)));
    const validVideoAspect = payload.aspectRatio === "9:16" ? "9:16" : "16:9";
    const resMap: Record<string, string> = {
      "360p": "360p",
      "720p": "720p",
      "1080p": "1080p",
      "4K": "4k",
      "4k": "4k",
    };
    const validRes = resMap[payload.resolution] || "720p";

    const interaction = await ai.interactions.create(
      {
        model: "gemini-omni-1.2-flash",
        input: inputParts,
        ...(payload.previousInteractionId
          ? { previous_interaction_id: payload.previousInteractionId }
          : {}),
        background: false,
        store: true,
        stream: false,
        response_format: {
          type: "video",
          aspect_ratio: validVideoAspect,
          duration: `${clampedDur}s`,
          resolution: validRes,
        },
      },
      { timeout: 300000 }
    );

    updateJob(jobId, {
      status: "Processing",
      stageLabel: "Encoding final MP4 stream & saving to project storage...",
    });

    const videoPart = interaction.output_video;
    if (!videoPart || (!videoPart.data && !videoPart.uri)) {
      throw new Error("Video model completed without returning a playable video stream.");
    }

    let videoBuffer: Buffer;
    if (videoPart.data) {
      videoBuffer = Buffer.from(videoPart.data, "base64");
    } else if (videoPart.uri) {
      const parsedUri = new URL(videoPart.uri);
      if (parsedUri.hostname !== "generativelanguage.googleapis.com") {
        throw new Error("Unexpected video URI host returned by API.");
      }
      const dlRes = await fetch(videoPart.uri, {
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY || "",
        },
      });
      if (!dlRes.ok) {
        throw new Error(`Failed to download generated video (${dlRes.status}).`);
      }
      videoBuffer = Buffer.from(await dlRes.arrayBuffer());
    } else {
      throw new Error("No video payload available.");
    }

    const fileName = `gen_vid_${jobId}.mp4`;
    const safePath = sanitizeSafeFilePath(UPLOADS_DIR, fileName);
    if (!safePath) {
      throw new Error("Unable to resolve safe video storage path.");
    }

    fs.writeFileSync(safePath, videoBuffer);

    updateJob(jobId, {
      status: "Completed",
      stageLabel: "Completed",
      result: {
        url: `/api/storage/files/${fileName}`,
        mimeType: videoPart.mime_type || "video/mp4",
        interactionId: interaction.id,
        promptUsed: fullPrompt,
      },
    });
  } catch (err) {
    const formatted = formatGeminiError(err);
    updateJob(jobId, {
      status: "Failed",
      stageLabel: "Failed",
      errorMessage: formatted.message,
    });
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "60mb" }));

  // Serve uploaded and generated media files with Range support for video scrubbing
  app.get("/api/storage/files/:filename", (req: Request, res: Response) => {
    const filename = req.params.filename;
    const safePath = sanitizeSafeFilePath(UPLOADS_DIR, filename);
    if (!safePath || !fs.existsSync(safePath)) {
      res.status(404).json({ error: "Media file not found." });
      return;
    }
    res.sendFile(safePath);
  });

  // Upload visual reference image or video into project storage
  app.post(
    "/api/storage/upload",
    requireFirebaseAuth,
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const { mimeType, dataBase64, originalName } = req.body as {
          mimeType?: string;
          dataBase64?: string;
          originalName?: string;
        };

        if (!mimeType || !dataBase64 || typeof dataBase64 !== "string") {
          res.status(400).json({ error: "Missing file payload or MIME type." });
          return;
        }

        const ext = ALLOWED_MIME_EXTENSIONS[mimeType];
        if (!ext) {
          res.status(400).json({
            error: "Unsupported file format. Upload PNG, JPEG, WEBP, MP4, or WEBM.",
          });
          return;
        }

        const cleanBase64 = dataBase64.includes(",")
          ? dataBase64.split(",")[1]
          : dataBase64;
        const buffer = Buffer.from(cleanBase64, "base64");
        if (buffer.length === 0 || buffer.length > 45 * 1024 * 1024) {
          res.status(400).json({ error: "File must be non-empty and under 45 MB." });
          return;
        }

        const fileId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const fileName = `ref_${fileId}${ext}`;
        const safePath = sanitizeSafeFilePath(UPLOADS_DIR, fileName);
        if (!safePath) {
          res.status(400).json({ error: "Invalid file path." });
          return;
        }

        fs.writeFileSync(safePath, buffer);
        res.json({
          url: `/api/storage/files/${fileName}`,
          mimeType,
          size: buffer.length,
          name: originalName || fileName,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : "Failed to store uploaded file.",
        });
      }
    }
  );

  // Start async Image Generation job
  app.post(
    "/api/ai/generate-image",
    requireFirebaseAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as {
        prompt?: string;
        aspectRatio?: string;
        resolution?: string;
        visualStyle?: string;
        cameraMovement?: string;
        referenceUrls?: string[];
        characters?: CharacterRefPayload[];
      };

      if (!body.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
        res.status(400).json({ error: "A descriptive prompt is required." });
        return;
      }

      const jobId = crypto.randomUUID();
      const job: GenerationJob = {
        id: jobId,
        ownerUid: req.uid || "",
        kind: "image",
        status: "Generating",
        stageLabel: "Sending prompt & visual references to image model...",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.set(jobId, job);

      void runImageGenerationJob(jobId, {
        prompt: body.prompt,
        aspectRatio: body.aspectRatio || "16:9",
        resolution: body.resolution || "1K",
        visualStyle: body.visualStyle,
        cameraMovement: body.cameraMovement,
        referenceUrls: Array.isArray(body.referenceUrls) ? body.referenceUrls : [],
        characters: Array.isArray(body.characters) ? body.characters : [],
      });

      res.status(202).json({ jobId, status: job.status, stageLabel: job.stageLabel });
    }
  );

  // Start async Video Generation job (Text-to-Video, Image-to-Video, Keyframes, Video Edit)
  app.post(
    "/api/ai/generate-video",
    requireFirebaseAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as {
        mode?: "text-to-video" | "image-to-video" | "keyframe-motion" | "video-edit";
        prompt?: string;
        aspectRatio?: string;
        durationSeconds?: number;
        resolution?: string;
        visualStyle?: string;
        cameraMovement?: string;
        startImageUrl?: string;
        endImageUrl?: string;
        referenceVideoUrl?: string;
        referenceUrls?: string[];
        characters?: CharacterRefPayload[];
        previousInteractionId?: string;
      };

      if (!body.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
        res.status(400).json({ error: "A scene motion prompt is required." });
        return;
      }

      const mode = body.mode || "text-to-video";
      if (mode === "image-to-video" && !body.startImageUrl) {
        res.status(400).json({ error: "Select or upload a starting image to animate." });
        return;
      }
      if (mode === "keyframe-motion" && (!body.startImageUrl || !body.endImageUrl)) {
        res.status(400).json({ error: "Both start and end keyframe images are required." });
        return;
      }
      if (mode === "video-edit" && !body.referenceVideoUrl) {
        res.status(400).json({ error: "Select or upload a reference video to edit." });
        return;
      }

      const jobId = crypto.randomUUID();
      const job: GenerationJob = {
        id: jobId,
        ownerUid: req.uid || "",
        kind: "video",
        status: "Generating",
        stageLabel: "Submitting video generation pipeline to Omni Flash...",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.set(jobId, job);

      void runVideoGenerationJob(jobId, {
        mode,
        prompt: body.prompt,
        aspectRatio: body.aspectRatio || "16:9",
        durationSeconds: Number(body.durationSeconds || 8),
        resolution: body.resolution || "720p",
        visualStyle: body.visualStyle,
        cameraMovement: body.cameraMovement,
        startImageUrl: body.startImageUrl,
        endImageUrl: body.endImageUrl,
        referenceVideoUrl: body.referenceVideoUrl,
        referenceUrls: Array.isArray(body.referenceUrls) ? body.referenceUrls : [],
        characters: Array.isArray(body.characters) ? body.characters : [],
        previousInteractionId: body.previousInteractionId,
      });

      res.status(202).json({ jobId, status: job.status, stageLabel: job.stageLabel });
    }
  );

  // Poll generation job status (Generating -> Processing -> Completed / Failed)
  app.get(
    "/api/ai/jobs/:jobId",
    requireFirebaseAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const job = jobs.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: "Generation job not found." });
        return;
      }
      if (job.ownerUid !== req.uid) {
        res.status(403).json({ error: "Forbidden." });
        return;
      }
      res.json({
        id: job.id,
        kind: job.kind,
        status: job.status,
        stageLabel: job.stageLabel,
        result: job.result,
        errorMessage: job.errorMessage,
      });
    }
  );

  // AI Creative Assistant (gemini-4-hydrogen)
  app.post(
    "/api/ai/assistant",
    requireFirebaseAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const ai = getAiClient();
        const { mode, message, projectContext, history } = req.body as {
          mode?: "chat" | "breakdown-story" | "develop-character" | "enhance-prompt";
          message?: string;
          projectContext?: {
            title?: string;
            synopsis?: string;
            visualStyle?: string;
            characters?: Array<{ name: string; entityType: string; appearancePrompt: string }>;
            scenes?: Array<{ title: string; prompt: string }>;
          };
          history?: Array<{ role: "user" | "assistant"; content: string }>;
        };

        if (!message || typeof message !== "string" || !message.trim()) {
          res.status(400).json({ error: "Please enter a creative request or story idea." });
          return;
        }

        const contextSummary = projectContext
          ? `Project: "${projectContext.title || "Untitled"}" | Style: ${projectContext.visualStyle || "Cinematic"}\nSynopsis: ${projectContext.synopsis || "None"}\nCharacters/Objects: ${(projectContext.characters || []).map((c) => `${c.name} (${c.entityType}): ${c.appearancePrompt}`).join("; ") || "None"}\nExisting Scenes: ${(projectContext.scenes || []).map((s, idx) => `${idx + 1}. ${s.title}`).join(", ") || "None"}`
          : "";

        if (mode === "breakdown-story") {
          const response = await ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: `${contextSummary}\n\nUser Story Concept:\n${message}\n\nBreak this concept down into 4 connected cinematic storyboard scenes with cohesive continuity.`,
            config: {
              systemInstruction:
                "You are an experienced film director and storyboard supervisor. Return a structured sequence of 4 connected visual scenes with vivid, filmable prompts, camera movements, and realistic clip durations (5 to 10 seconds).",
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  scenes: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        title: { type: Type.STRING },
                        prompt: { type: Type.STRING },
                        notes: { type: Type.STRING },
                        cameraMovement: { type: Type.STRING },
                        durationSeconds: { type: Type.INTEGER },
                      },
                      required: ["title", "prompt", "notes", "cameraMovement", "durationSeconds"],
                    },
                  },
                },
                required: ["scenes"],
              },
            },
          });
          const parsed = JSON.parse((response.text ?? "{}").trim());
          res.json({ mode, data: parsed });
          return;
        }

        if (mode === "develop-character") {
          const response = await ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: `${contextSummary}\n\nCreate a reusable character or key object profile based on:\n${message}`,
            config: {
              systemInstruction:
                "You are a film production designer creating a visual continuity bible entry. Specify exact wardrobe, facial/material details, silhouette, color accents, and lighting cues so image/video models preserve identity across scenes.",
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  entityType: { type: Type.STRING },
                  appearancePrompt: { type: Type.STRING },
                  tags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: ["name", "entityType", "appearancePrompt", "tags"],
              },
            },
          });
          const parsed = JSON.parse((response.text ?? "{}").trim());
          res.json({ mode, data: parsed });
          return;
        }

        if (mode === "enhance-prompt") {
          const response = await ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: `${contextSummary}\n\nDraft Prompt to Elevate:\n${message}`,
            config: {
              systemInstruction:
                "You are a cinematographer and AI prompt architect. Rewrite the user's draft into a cohesive, visual, motion-aware production prompt detailing lens focal length, lighting, atmosphere, subject motion, and framing.",
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  enhancedPrompt: { type: Type.STRING },
                  suggestedCamera: { type: Type.STRING },
                  suggestedStyle: { type: Type.STRING },
                },
                required: ["enhancedPrompt", "suggestedCamera", "suggestedStyle"],
              },
            },
          });
          const parsed = JSON.parse((response.text ?? "{}").trim());
          res.json({ mode, data: parsed });
          return;
        }

        // Standard multi-turn creative studio chat
        const conversationText = (history || [])
          .slice(-8)
          .map((m) => `${m.role === "user" ? "Director" : "Assistant"}: ${m.content}`)
          .join("\n");

        const response = await ai.models.generateContent({
          model: "gemini-4-hydrogen",
          contents: `${contextSummary}\n\n${conversationText ? `Recent Thread:\n${conversationText}\n\n` : ""}Director: ${message}`,
          config: {
            systemInstruction:
              "You are the KinoFrame Creative Assistant — a concise, knowledgeable film director, screenwriter, and AI cinematography advisor. Help the user write stories, craft prompts, suggest scenes, develop consistent characters, and sharpen visual ideas. Keep suggestions actionable and production-ready.",
          },
        });

        res.json({
          mode: "chat",
          reply: response.text || "I could not generate a response. Please rephrase your request.",
        });
      } catch (err) {
        const formatted = formatGeminiError(err);
        res.status(formatted.status).json({ error: formatted.message });
      }
    }
  );

  // Vite middleware in dev, static dist/ in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`KinoFrame Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
