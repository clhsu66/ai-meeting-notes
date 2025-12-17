AI Meeting Notes – Run Checklist
================================

These steps assume you have already:
- Installed Python, Node.js
- Installed this project's Python and npm dependencies
- Created a Google OAuth client (`credentials.json` in the backend folder)
- Configured a hosted LLM/transcription API (for example, an OpenAI‑compatible
  endpoint) via environment variables:
  - `LLM_API_KEY` (or `OPENAI_API_KEY`)
  - optional: `LLM_API_BASE`, `LLM_MODEL_NAME`, `STT_MODEL_NAME`

Every time you want to use the app locally, do the following:

1. Start the backend (FastAPI)
------------------------------

Open a new terminal window/tab and run:

  cd path/to/ai-meeting-notes
  # If you created a virtual environment earlier, activate it:
  # source .venv/bin/activate
  uvicorn main:app --reload --port 8000

Leave this running; it serves the API at:

  http://127.0.0.1:8000


2. Start the frontend (React/Vite UI)
-------------------------------------

Open another new terminal window/tab and run:

  cd path/to/ai-meeting-notes/ai-meeting-ui
  npm run dev

Vite will print a URL, usually:

  http://localhost:5173/

Open that URL in your browser to use the app.


3. Stopping everything
----------------------

When you're done:

- Press Ctrl+C in the terminal running `npm run dev` (frontend).
- Press Ctrl+C in the terminal running `uvicorn main:app` (backend).

Repeat steps 1–2 whenever you want to bring the app back up.


Hosting (no-terminal use for your users)
----------------------------------------

Once this repo is on GitHub, you can host everything with only web UIs:

Backend (FastAPI) on Render or Railway:
- Create a new Web Service from your GitHub repo.
- Use the project root as the service root.
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn main:app --host 0.0.0.0 --port 8000`
- Set environment variables:
  - `DATABASE_URL` (optional; keep SQLite or point to Postgres)
  - `LLM_API_KEY` (or `OPENAI_API_KEY`)
  - optional: `LLM_API_BASE`, `LLM_MODEL_NAME`, `STT_MODEL_NAME`
  - `FRONTEND_BASE_URL` = your frontend URL (see below)
  - `GOOGLE_OAUTH_REDIRECT_URI` =
    `https://your-backend-host/auth/google/callback`
- In your Google Cloud OAuth client, add the deployed callback URL above as an
  authorized redirect URI.

Frontend (React/Vite) on Vercel or Netlify:
- Point the project to the `ai-meeting-ui` folder in this repo.
- Build command: `npm install && npm run build`
- Output/publish directory: `dist`
- Set environment variable:
  - `VITE_API_BASE` = `https://your-backend-host`

After both are deployed:
- Users visit the frontend URL in their browser.
- They click "Connect Google" to link their own Google account.
- All usage is browser-only; no terminal access is needed for them.
