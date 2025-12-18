# AI Meeting Notes (Self‑Hosted)

AI Meeting Notes is a small web app that lets you:

- Record meetings in your browser (or upload audio)
- Automatically save them as searchable notes
- Connect your **own Google Calendar** to see events and link recordings
- Optionally use your **own LLM API key** (e.g. OpenAI‑compatible) for summaries & action items

This repo is designed so that **you host it yourself**.  
Each person who hosts their own copy must bring:

- A Google account
- A Google Cloud **OAuth 2.0 Web application** client (your own `credentials.json`)
- Optionally, an LLM API key (OpenAI or any OpenAI‑compatible provider)

End users of a hosted instance only need to sign in with Google in the browser.

---

## 1. Prerequisites

On your machine:

- **Python** 3.10+  
- **Node.js** 18+ and npm
- A **Google account**
- A **Google Cloud project** where you can create OAuth credentials

---

## 2. Create your own Google OAuth client

You must create your own Google OAuth 2.0 **Web application** client and download `credentials.json`.

1. Go to the Google Cloud Console: `https://console.cloud.google.com/`
2. Create or select a project.
3. In the left menu, go to **APIs & Services → Credentials**.
4. If you haven’t already, configure the **OAuth consent screen** (External / Internal, app name, etc.).
5. Click **“Create Credentials” → “OAuth client ID”**.
6. Choose **Application type = Web application**.
7. Add the following for local development:
   - **Authorized redirect URIs**:  
     `http://127.0.0.1:8000/auth/google/callback`
   - **Authorized JavaScript origins**:  
     `http://localhost:5173`
8. Click **Create**, then **Download JSON**. This file is your `credentials.json`.

Place the file in the backend folder (next to `main.py`):

```bash
ai-meeting-notes/
  main.py
  credentials.json   # <-- put it here
```

> **Note:** This file contains secrets. Do **not** commit it to Git.  
> `.gitignore` in this repo already ignores `credentials.json`.

If you later deploy to the cloud (Render, etc.), you will:

- Add your deployed callback URL (e.g. `https://your-api.onrender.com/auth/google/callback`) as another **Authorized redirect URI**.
- Upload the same `credentials.json` as a **secret file** in your hosting provider.

---

## 3. (Optional) Get an LLM API key

The app supports a **“bring your own API key”** model:

- If you **do not** configure any key:
  - Users can still record and save meetings.
  - Audio is stored and visible, but AI summaries & action items may be blank.
- If you **do** configure a key:
  - The app can auto‑transcribe audio and generate summaries/action items.

There are two ways to provide a key:

1. **User‑provided key in the UI (recommended)**  
   Each user pastes their own key in the app (stored in their browser `localStorage`).  
2. **Server default key (optional)**  
   You set `LLM_API_KEY` or `OPENAI_API_KEY` as an environment variable on the backend.

Any OpenAI‑compatible provider should work if you set:

- `LLM_API_BASE` (e.g. `https://api.openai.com/v1` by default)
- `LLM_MODEL_NAME` (text model, default `gpt-4o-mini`)
- `STT_MODEL_NAME` (speech‑to‑text model, default `whisper-1`)

---

## 4. Run locally (backend + frontend)

### 4.1 Backend (FastAPI)

From the project root:

```bash
cd ai-meeting-notes

# (optional but recommended) create and activate a virtual env
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

pip install -r requirements.txt
```

Set any optional environment variables (in your shell, `.env`, or IDE run config):

- `FRONTEND_BASE_URL` – where your frontend runs locally. For dev:  
  `http://localhost:5173`
- `LLM_API_KEY` / `OPENAI_API_KEY` – server‑side default LLM key (optional)
- `LLM_API_BASE`, `LLM_MODEL_NAME`, `STT_MODEL_NAME` – for non‑default providers (optional)
- `DATABASE_URL` – defaults to SQLite `meetings.db` in the project; you can point this to Postgres if you prefer.

Start the API server:

```bash
uvicorn main:app --reload --port 8000
```

This serves the backend at:

- `http://127.0.0.1:8000`

Leave this terminal running.

### 4.2 Frontend (React / Vite)

In a second terminal:

```bash
cd ai-meeting-notes/ai-meeting-ui
npm install
```

For local dev, Vite will automatically talk to `http://127.0.0.1:8000` unless you override it.  
If you want to be explicit, you can create a `.env` file in `ai-meeting-ui`:

```bash
VITE_API_BASE=http://127.0.0.1:8000
```

Now start the dev server:

```bash
npm run dev
```

Vite will show a URL like:

- `http://localhost:5173`

Open that URL in your browser.

---

## 5. Using the app

1. **Connect Google**
   - Click **“Connect Google”** in the app.
   - You’ll be redirected to Google, asked to consent, and then sent back.
   - Your calendar events (for the next year) should appear in the UI.

2. **Record a meeting**
   - Optionally click a calendar event to prefill title/time.
   - Press the record button to start; stop when finished.
   - Give the meeting a title and click **Save**.

3. **AI key (bring your own)**
   - In the right‑side panel you’ll see something like:
     - “AI: no API key (AI features limited)” or
     - “AI: API key set (summaries enabled)”.
   - Click **Set/Change AI key** and paste your key (e.g. OpenAI).
   - The key is stored only in your browser (`localStorage`), not on the server.

4. **Summaries & action items**
   - With a working key and quota, new meetings will:
     - Be transcribed,
     - Get a summary,
     - Get an initial list of action items.
   - If the key is missing or quota is exceeded, the meeting is still saved; AI fields may just be empty.

5. **Organizing and exporting**
   - Create folders, move meetings, and mark favorites.
   - Use filters and search to find meetings.
   - Click a meeting and:
     - View the transcript and summary,
     - Edit action items,
     - Export notes to Markdown or copy to clipboard.

---

## 6. Optional: Deploy to the cloud

You can host this the same way this instance was designed:

- **Backend** (this folder) on a platform like Render/Railway:
  - Build command: `pip install -r requirements.txt`
  - Start command: `uvicorn main:app --host 0.0.0.0 --port 8000`
  - Env vars:
    - `FRONTEND_BASE_URL` = your frontend URL
    - `GOOGLE_OAUTH_REDIRECT_URI` = `https://your-backend-host/auth/google/callback`
    - Optional: `LLM_API_KEY`, `LLM_API_BASE`, `LLM_MODEL_NAME`, `STT_MODEL_NAME`, `DATABASE_URL`
  - Add your `credentials.json` as a **secret file** at the backend root.

- **Frontend** (`ai-meeting-ui` folder) on Vercel/Netlify:
  - Root directory: `ai-meeting-ui`
  - Build: `npm run build`
  - Output: `dist`
  - Env var:
    - `VITE_API_BASE` = `https://your-backend-host`

Then your end users can simply:

- Visit the frontend URL,
- Click **Connect Google**,
- Optionally paste their own LLM key,
- Use the app entirely from the browser (no terminal required).

---

## 7. Security notes

- Do **not** commit:
  - `credentials.json`
  - `token.json`, `token.json.bak`
  - `meetings.db`
  - `audio/`, `uploaded_audio/`
  - `node_modules/`
- Rotate your Google client secret if it was ever exposed, and update your `credentials.json` + secret file accordingly.

This README is aimed at someone hosting their own copy.  
If you’re just using a hosted instance someone else deployed, all you need is:

- A Google account,  
- (Optionally) your own LLM API key to paste into the UI.

