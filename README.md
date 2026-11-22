# KinoFrame Studio

Cinematic AI video and image generation studio with project management, character/object visual consistency, a scene-by-scene storyboard, an NLE timeline Scene Builder with WebM film export, and an AI Creative Assistant.

## Architecture

- **Frontend (`src/`)**: React 19, TypeScript, Tailwind CSS v4, Motion, Firebase Web SDK (Google Sign-In + Firestore real-time sync).
- **Backend (`server.ts`)**: Express server running Vite middleware in development and serving `dist/` in production, with Firebase ID token verification (`firebase-admin/auth`).
- **AI API (`@google/genai`)**: Server-side routes for text/image/video generation (`gemini-3.1-flash-lite-image`, `gemini-nano-banana-2.1`, `gemini-omni-1.2-flash`) and AI Creative Assistant (`gemini-4-hydrogen`).
- **Database (`firestore.rules`, `firebase-blueprint.json`)**: Cloud Firestore storing user profiles, credit wallets, projects, consistency characters, media assets, storyboard scenes, and timeline clips.
- **Storage (`uploads/`)**: Local server media storage with strict path confinement and HTTP range streaming for uploaded references and generated videos/images.

## Prerequisites

- **Node.js `>= 22.0.0`**
- **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/apikey) *(a billing-enabled key is required for image and video models: `gemini-3.1-flash-lite-image`, `gemini-nano-banana-2.1`, `gemini-omni-1.2-flash`; `gemini-4-hydrogen` works on standard keys)*
- **Firebase Project** with **Authentication (Google Provider)** and **Cloud Firestore** enabled

## Local Setup (After Cloning from GitHub)

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set your `GEMINI_API_KEY`:

   ```env
   GEMINI_API_KEY="your-gemini-api-key"
   PORT=3000
   APP_URL="http://localhost:3000"
   ```

3. **Configure Firebase (if using your own Firebase project)**

   Either update `firebase-applet-config.json` (see `firebase-applet-config.example.json`) or set the `VITE_FIREBASE_*` and `FIREBASE_PROJECT_ID` overrides inside `.env`.

   Make sure to:
   - Enable **Google** sign-in in **Firebase Console → Authentication → Sign-in method**.
   - Add `localhost` (and your production domain) to **Firebase Console → Authentication → Settings → Authorized domains**.
   - Deploy Firestore rules using the Firebase CLI:

     ```bash
     npx firebase-tools deploy --only firestore:rules
     ```

4. **Run in development**

   ```bash
   npm run dev
   ```

   Open `http://localhost:3000`.

## Production Build & Start

```bash
npm run build
NODE_ENV=production npm start
```

`npm start` executes `node server.ts` natively on Node.js 22+ and serves the built `dist/` bundle alongside `/api/*` endpoints.

## Docker Deployment

```bash
docker build -t kinoframe-studio .
docker run -p 3000:3000 -e GEMINI_API_KEY="your-key" -e NODE_ENV=production kinoframe-studio
```

## Verification & CI

- Typecheck: `npm run lint`
- Production bundle: `npm run build`
- Firestore security rules lint: `npx eslint firestore.rules`
- GitHub Actions workflow is preconfigured in `.github/workflows/ci.yml`.
