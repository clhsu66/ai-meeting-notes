import os
import io
import uuid
import json
import wave
import asyncio
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

import httpx
from fastapi import (
    FastAPI,
    File,
    UploadFile,
    Form,
    HTTPException,
    Query,
    Depends,
    Header,
    Request,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import (
    Column,
    String,
    DateTime,
    Text,
    Boolean,
    create_engine,
    ForeignKey,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker, Session
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from google_auth_oauthlib.flow import Flow
from google.auth.transport.requests import Request as GoogleRequest

# -----------------------------------------------------------------------------
# Basic paths and constants
# -----------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "meetings.db")
AUDIO_DIR = os.path.join(BASE_DIR, "audio")

os.makedirs(AUDIO_DIR, exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DB_PATH}")

GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]
GOOGLE_CALENDAR_ID = "primary"

FRONTEND_BASE_URL = os.environ.get("FRONTEND_BASE_URL", "http://localhost:5173")
GOOGLE_OAUTH_REDIRECT_URI = os.environ.get(
    "GOOGLE_OAUTH_REDIRECT_URI",
    "http://127.0.0.1:8000/auth/google/callback",
)

# Hosted LLM / transcription config (OpenAI-compatible by default)
LLM_API_BASE = os.environ.get("LLM_API_BASE", "https://api.openai.com/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
LLM_MODEL_NAME = os.environ.get("LLM_MODEL_NAME", "gpt-4o-mini")
STT_MODEL_NAME = os.environ.get("STT_MODEL_NAME", "whisper-1")

# -----------------------------------------------------------------------------
# Database setup
# -----------------------------------------------------------------------------

Base = declarative_base()
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Folder(Base):
    __tablename__ = "folders"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    owner_id = Column(String, ForeignKey("users.id"), nullable=True)

    owner = relationship("User", back_populates="folders")
    meetings = relationship("Meeting", back_populates="folder")


class Meeting(Base):
    __tablename__ = "meetings"

    id = Column(String, primary_key=True, index=True)
    title = Column(String, nullable=False)
    folder_id = Column(String, ForeignKey("folders.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    start_time = Column(String, nullable=True)
    end_time = Column(String, nullable=True)
    status = Column(String, nullable=True)
    transcript = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)
    audio_path = Column(String, nullable=True)
    calendar_event_id = Column(String, nullable=True)
    action_items = Column(Text, nullable=True)  # JSON string of items
    is_favorite = Column(Boolean, default=False)
    owner_id = Column(String, ForeignKey("users.id"), nullable=True)

    folder = relationship("Folder", back_populates="meetings")
    owner = relationship("User", back_populates="meetings")


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, nullable=False, unique=True, index=True)
    google_sub = Column(String, nullable=True, unique=True, index=True)
    google_creds_json = Column(Text, nullable=False)
    api_token = Column(String, nullable=False, unique=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    folders = relationship("Folder", back_populates="owner")
    meetings = relationship("Meeting", back_populates="owner")


class AuthState(Base):
    __tablename__ = "auth_states"

    state = Column(String, primary_key=True, index=True)
    frontend_redirect = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


Base.metadata.create_all(bind=engine)

# -----------------------------------------------------------------------------
# Pydantic models
# -----------------------------------------------------------------------------


class FolderOut(BaseModel):
    id: str
    name: str
    created_at: datetime

    class Config:
        orm_mode = True


class ActionItem(BaseModel):
    task: str
    owner: Optional[str] = None
    due_date: Optional[str] = None
    status: Optional[str] = "open"


class MeetingOut(BaseModel):
    id: str
    title: str
    folder_id: Optional[str] = None
    created_at: datetime
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    status: Optional[str] = None
    transcript: Optional[str] = None
    summary: Optional[str] = None
    audio_path: Optional[str] = None
    calendar_event_id: Optional[str] = None
    action_items: Optional[List[ActionItem]] = None
    is_favorite: bool = False

    class Config:
        orm_mode = True


class MeetingMetadataUpdate(BaseModel):
    title: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    calendar_event_id: Optional[str] = None


class ActionItemPayload(BaseModel):
    task: str
    owner: Optional[str] = None
    due_date: Optional[str] = None
    status: Optional[str] = "open"


class MeetingActionItemsPayload(BaseModel):
    action_items: List[ActionItemPayload]


class SearchResponse(BaseModel):
    results: List[MeetingOut]


class FavoritePayload(BaseModel):
    favorite: bool


class FolderAssignment(BaseModel):
    folder_id: Optional[str] = None


class SmartSummaryRequest(BaseModel):
    mode: str  # "executive", "detailed", "decisions", "persona"
    persona_name: Optional[str] = None


class SmartSummaryResponse(BaseModel):
    summary: str


class QARequest(BaseModel):
    question: str


class QAReference(BaseModel):
    meeting_id: str
    title: str
    created_at: datetime


class QAResponse(BaseModel):
    answer: str
    references: List[QAReference]


class TopicCluster(BaseModel):
    name: str
    description: Optional[str] = None
    meeting_ids: List[str]


class TopicClustersResponse(BaseModel):
    clusters: List[TopicCluster]


class CalendarEventOut(BaseModel):
    id: str
    title: str
    start_time: str
    end_time: str
    html_link: Optional[str] = None


class CalendarSyncPayload(BaseModel):
    event_id: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None


def _build_google_flow(state: str) -> Flow:
    """
    Build a Google OAuth Flow for the given state.
    By default this reads credentials.json from the project root.
    """
    client_secrets_path = os.path.join(BASE_DIR, "credentials.json")
    if not os.path.exists(client_secrets_path):
        raise HTTPException(
            status_code=500,
            detail=(
                "Google OAuth client configuration not found. "
                "Place your credentials.json file next to main.py "
                "or configure GOOGLE_OAUTH_REDIRECT_URI appropriately."
            ),
        )

    try:
        flow = Flow.from_client_secrets_file(
            client_secrets_path,
            scopes=GOOGLE_SCOPES,
            state=state,
        )
        flow.redirect_uri = GOOGLE_OAUTH_REDIRECT_URI
        return flow
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to initialize Google OAuth flow: {e}",
        )


def _get_calendar_service_for_user(user: "User", db: Session):
    """
    Build a Google Calendar client for the given user using stored OAuth tokens.
    """
    if not user.google_creds_json:
        raise HTTPException(
            status_code=400,
            detail="Google Calendar is not connected for this user.",
        )

    try:
        info = json.loads(user.google_creds_json)
        creds = Credentials.from_authorized_user_info(info, scopes=GOOGLE_SCOPES)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load Google credentials for user: {e}",
        )

    # Refresh if needed
    try:
        if not creds.valid and creds.refresh_token:
            creds.refresh(GoogleRequest())
            user.google_creds_json = creds.to_json()
            db.add(user)
            db.commit()
    except Exception as e:
        raise HTTPException(
            status_code=401,
            detail=(
                "Failed to refresh Google credentials; "
                "please reconnect Google Calendar."
            ),
        )

    try:
        service = build("calendar", "v3", credentials=creds)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to initialize Google Calendar client: {e}",
        )
    return service


# -----------------------------------------------------------------------------
# Helper functions
# -----------------------------------------------------------------------------


def get_db_session() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _get_current_user_from_header(
    authorization: Optional[str],
    db: Session,
) -> "User":
    """
    Resolve the current user from an Authorization: Bearer <token> header.
    """
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail="Missing Authorization header. Please connect Google Calendar first.",
        )

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid Authorization header.")

    token = parts[1]
    user = db.query(User).filter(User.api_token == token).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired API token.")

    return user


def meeting_to_dict(meeting: Meeting) -> dict:
    """Convert Meeting ORM object to dict, including parsed action_items JSON."""
    data = {
        "id": meeting.id,
        "title": meeting.title,
        "folder_id": meeting.folder_id,
        "created_at": meeting.created_at,
        "start_time": meeting.start_time,
        "end_time": meeting.end_time,
        "status": meeting.status,
        "transcript": meeting.transcript,
        "summary": meeting.summary,
        "audio_path": meeting.audio_path,
        "calendar_event_id": meeting.calendar_event_id,
        "is_favorite": bool(meeting.is_favorite),
    }

    if meeting.action_items:
        try:
            parsed = json.loads(meeting.action_items)
            items: List[dict] = []
            for it in parsed:
                items.append(
                    {
                        "task": it.get("task", ""),
                        "owner": it.get("owner"),
                        "due_date": it.get("due_date"),
                        "status": it.get("status", "open"),
                    }
                )
            data["action_items"] = items
        except Exception:
            data["action_items"] = []
    else:
        data["action_items"] = []

    return data


async def ollama_chat(prompt: str, api_key: Optional[str] = None) -> str:
    """
    Call a hosted LLM (OpenAI-compatible chat endpoint) with the given prompt
    and return the text.
    """
    key = (api_key or LLM_API_KEY or "").strip()
    if not key:
        raise HTTPException(
            status_code=400,
            detail=(
                "No LLM API key provided. Set an API key in the app or configure "
                "LLM_API_KEY / OPENAI_API_KEY on the server."
            ),
        )

    url = f"{LLM_API_BASE.rstrip('/')}/chat/completions"
    payload = {
        "model": LLM_MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            resp = await client.post(url, json=payload, headers=headers)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error calling LLM: {e}")

    if resp.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail=f"LLM error {resp.status_code}: {resp.text[:200]}",
        )

    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        raise HTTPException(
            status_code=500,
            detail="LLM response did not contain any choices.",
        )
    message = choices[0].get("message") or {}
    content = message.get("content") or ""
    return str(content)


async def generate_summary(transcript: str, api_key: Optional[str] = None) -> str:
    """
    Use the LLM to generate a concise, readable summary of the meeting.
    """
    prompt = (
        "You are an expert meeting summarizer. "
        "Given the following transcript, produce a clear, concise summary in markdown. "
        "Focus on key decisions, topics discussed, and outcomes.\n\n"
        f"Transcript:\n{transcript}"
    )
    return await ollama_chat(prompt, api_key=api_key)


async def generate_smart_summary(
    meeting: Meeting,
    mode: str,
    persona_name: Optional[str] = None,
    api_key: Optional[str] = None,
) -> str:
    """
    Generate alternate views of a meeting summary using the LLM.
    """
    base_context = (
        f"Title: {meeting.title}\n"
        f"Created at: {meeting.created_at.isoformat()}\n\n"
        f"Existing summary (may be empty):\n{meeting.summary or 'N/A'}\n\n"
        f"Transcript:\n{meeting.transcript or ''}\n"
    )

    mode = (mode or "").lower()
    if mode == "executive":
        instructions = (
            "Write an EXECUTIVE SUMMARY for a busy leader.\n"
            "- 3–7 concise bullet points.\n"
            "- Focus on decisions, outcomes, and major risks.\n"
            "- Do not include implementation details.\n"
        )
    elif mode == "detailed":
        instructions = (
            "Write DETAILED NOTES from this meeting in markdown.\n"
            "- Use sections and subheadings.\n"
            "- Capture key arguments, options considered, and rationale.\n"
            "- Include a short 'Decisions' section and a 'Next Steps' section.\n"
        )
    elif mode == "decisions":
        instructions = (
            "Highlight DECISIONS vs DISCUSSION in markdown.\n"
            "- Create two main sections: 'Decisions' and 'Discussion'.\n"
            "- In 'Decisions', list only clear decisions and owners.\n"
            "- In 'Discussion', summarize the main points and open questions.\n"
        )
    elif mode == "persona":
        target = persona_name or "this person"
        instructions = (
            f"Write a short recap specifically for {target}.\n"
            "- Focus only on information, decisions, and action items relevant to them.\n"
            "- Use a friendly, concise tone.\n"
            "- Mention what they should pay attention to and any tasks they own.\n"
        )
    else:
        instructions = (
            "Write a clear, concise summary with decisions and next steps."
        )

    prompt = (
        "You are an expert meeting note-taker.\n"
        f"{instructions}\n\n"
        "Meeting content:\n"
        f"{base_context}"
    )
    return await ollama_chat(prompt, api_key=api_key)


async def extract_action_items_via_llama(
    transcript: str,
    api_key: Optional[str] = None,
) -> List[ActionItem]:
    """
    Ask the LLM to extract structured action items from the transcript.
    """
    prompt = (
        "You are an assistant that extracts ACTION ITEMS from meeting transcripts.\n"
        "Return ONLY valid JSON in this exact format:\n\n"
        "[\n"
        "  {\n"
        '    \\"task\\": \\"string, the actual action\\",\n'
        '    \\"owner\\": \\"string or null\\",\n'
        '    \\"due_date\\": \\"YYYY-MM-DD or null\\",\n'
        '    \\"status\\": \\"open\\"\n'
        "  }\n"
        "]\n\n"
        "If there are no action items, return an empty list [].\n\n"
        f"Transcript:\n{transcript}\n"
    )

    raw = await ollama_chat(prompt, api_key=api_key)
    try:
        start = raw.find("[")
        end = raw.rfind("]")
        if start != -1 and end != -1 and end > start:
            raw_json = raw[start : end + 1]
        else:
            raw_json = raw

        parsed = json.loads(raw_json)
        items: List[ActionItem] = []
        if isinstance(parsed, list):
            for obj in parsed:
                if not isinstance(obj, dict):
                    continue
                task = (obj.get("task") or "").strip()
                if not task:
                    continue
                items.append(
                    ActionItem(
                        task=task,
                        owner=obj.get("owner"),
                        due_date=obj.get("due_date"),
                        status=obj.get("status") or "open",
                    )
                )
        return items
    except Exception:
        return []


def save_upload_to_wav(upload: UploadFile, dest_path: str) -> None:
    """
    Save an uploaded audio file to a .wav file at dest_path.
    """
    with open(dest_path, "wb") as f:
        f.write(upload.file.read())


async def transcribe_audio(
    file_path: str,
    api_key: Optional[str] = None,
) -> str:
    """
    Call a hosted transcription service (OpenAI-compatible /audio/transcriptions)
    to transcribe `file_path`.
    """
    key = (api_key or LLM_API_KEY or "").strip()
    if not key:
        raise HTTPException(
            status_code=400,
            detail=(
                "No LLM API key provided. Set an API key in the app or configure "
                "LLM_API_KEY / OPENAI_API_KEY on the server to enable transcription."
            ),
        )

    url = f"{LLM_API_BASE.rstrip('/')}/audio/transcriptions"
    headers = {
        "Authorization": f"Bearer {key}",
    }
    data = {
        "model": STT_MODEL_NAME,
        "response_format": "text",
    }

    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            with open(file_path, "rb") as f:
                files = {
                    "file": (os.path.basename(file_path), f, "audio/wav"),
                }
                resp = await client.post(
                    url,
                    headers=headers,
                    data=data,
                    files=files,
                )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error calling transcription service: {e}",
        )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription error {resp.status_code}: {resp.text[:200]}",
        )

    # When response_format is "text", the body is plain text
    return resp.text


# -----------------------------------------------------------------------------
# FastAPI app + CORS
# -----------------------------------------------------------------------------

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev: allow all
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -----------------------------------------------------------------------------
# Google OAuth (multi-user)
# -----------------------------------------------------------------------------


@app.get("/auth/google/start")
def google_auth_start(frontend_redirect: str = Query(FRONTEND_BASE_URL)):
    """
    Begin Google OAuth flow. Redirects the browser to Google's consent screen.
    `frontend_redirect` is where the user will be sent after successful auth.
    """
    state = str(uuid.uuid4())
    db = SessionLocal()
    try:
        auth_state = AuthState(state=state, frontend_redirect=frontend_redirect)
        db.add(auth_state)
        db.commit()
    finally:
        db.close()

    flow = _build_google_flow(state)
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return RedirectResponse(auth_url)


@app.get("/auth/google/callback")
def google_auth_callback(
    state: str = Query(...),
    code: str = Query(...),
):
    """
    OAuth callback endpoint. Exchanges code for tokens, stores them per user,
    and redirects back to the frontend with an API token.
    """
    db = SessionLocal()
    try:
        auth_state = db.query(AuthState).filter(AuthState.state == state).first()
        if not auth_state:
            raise HTTPException(status_code=400, detail="Invalid or expired OAuth state.")
        frontend_redirect = auth_state.frontend_redirect

        flow = _build_google_flow(state)
        try:
            flow.fetch_token(code=code)
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to exchange authorization code: {e}",
            )
        creds = flow.credentials

        # Fetch user info (email + Google user id)
        try:
            oauth2 = build("oauth2", "v2", credentials=creds)
            userinfo = oauth2.userinfo().get().execute()
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to fetch Google user info: {e}",
            )
        email = userinfo.get("email")
        google_sub = userinfo.get("id")

        if not email:
            raise HTTPException(
                status_code=400,
                detail="Google account email was not provided.",
            )

        user = None
        if google_sub:
            user = db.query(User).filter(User.google_sub == google_sub).first()
        if not user:
            user = db.query(User).filter(User.email == email).first()

        if user:
            user.google_creds_json = creds.to_json()
            if google_sub:
                user.google_sub = google_sub
            if not user.api_token:
                user.api_token = str(uuid.uuid4())
        else:
            user = User(
                id=str(uuid.uuid4()),
                email=email,
                google_sub=google_sub,
                google_creds_json=creds.to_json(),
                api_token=str(uuid.uuid4()),
            )
            db.add(user)

        # Clean up used state
        db.delete(auth_state)
        db.commit()

        api_token = user.api_token
    finally:
        db.close()

    # Redirect back to the frontend with the API token in the URL
    redirect_url = f"{frontend_redirect.rstrip('/')}/?token={api_token}&email={email}"
    return RedirectResponse(redirect_url)


# -----------------------------------------------------------------------------
# Folder endpoints
# -----------------------------------------------------------------------------


@app.get("/folders", response_model=List[FolderOut])
def list_folders(
    authorization: Optional[str] = Header(None),
) -> List[FolderOut]:
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        folders = (
            db.query(Folder)
            .filter(Folder.owner_id == current_user.id)
            .order_by(Folder.created_at.asc())
            .all()
        )
        return folders
    finally:
        db.close()


class FolderCreate(BaseModel):
    name: str


@app.post("/folders", response_model=FolderOut)
def create_folder(
    payload: FolderCreate,
    authorization: Optional[str] = Header(None),
) -> FolderOut:
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        folder = Folder(
            id=str(uuid.uuid4()),
            name=payload.name,
            owner_id=current_user.id,
        )
        db.add(folder)
        db.commit()
        db.refresh(folder)
        return folder
    finally:
        db.close()


@app.delete("/folders/{folder_id}")
def delete_folder(
    folder_id: str,
    authorization: Optional[str] = Header(None),
):
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        folder = (
            db.query(Folder)
            .filter(Folder.id == folder_id, Folder.owner_id == current_user.id)
            .first()
        )
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
        db.delete(folder)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@app.put("/folders/{folder_id}")
def rename_folder(
    folder_id: str,
    payload: FolderCreate,
    authorization: Optional[str] = Header(None),
):
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        folder = (
            db.query(Folder)
            .filter(Folder.id == folder_id, Folder.owner_id == current_user.id)
            .first()
        )
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
        folder.name = payload.name
        db.commit()
        db.refresh(folder)
        return folder
    finally:
        db.close()


# -----------------------------------------------------------------------------
# Meeting endpoints
# -----------------------------------------------------------------------------


@app.get("/meetings", response_model=List[MeetingOut])
def list_meetings(
    folder_id: Optional[str] = Query(None),
    favorites_only: bool = Query(False),
    authorization: Optional[str] = Header(None),
) -> List[MeetingOut]:
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        q = (
            db.query(Meeting)
            .filter(Meeting.owner_id == current_user.id)
            .order_by(Meeting.created_at.desc())
        )
        if folder_id is not None:
            q = q.filter(Meeting.folder_id == folder_id)
        if favorites_only:
            q = q.filter(Meeting.is_favorite.is_(True))

        meetings = q.all()
        return [meeting_to_dict(m) for m in meetings]
    finally:
        db.close()


# --- SEARCH MUST COME *BEFORE* /meetings/{meeting_id} TO AVOID ROUTE CONFLICT ---

@app.get("/meetings/search", response_model=List[MeetingOut])
def search_meetings(
    q: str = Query(...),
    authorization: Optional[str] = Header(None),
) -> List[MeetingOut]:
    """
    Naive search over title, summary, and transcript for the current user.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        pattern = f"%{q}%"
        meetings = (
            db.query(Meeting)
            .filter(
                Meeting.owner_id == current_user.id,
                (Meeting.title.ilike(pattern))
                | (Meeting.summary.ilike(pattern))
                | (Meeting.transcript.ilike(pattern)),
            )
            .order_by(Meeting.created_at.desc())
            .all()
        )
        return [meeting_to_dict(m) for m in meetings]
    finally:
        db.close()


@app.get("/meetings/{meeting_id}", response_model=MeetingOut)
def get_meeting(
    meeting_id: str,
    authorization: Optional[str] = Header(None),
) -> MeetingOut:
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        return meeting_to_dict(meeting)
    finally:
        db.close()


@app.patch("/meetings/{meeting_id}/metadata", response_model=MeetingOut)
def update_meeting_metadata(
    meeting_id: str,
    payload: MeetingMetadataUpdate,
    authorization: Optional[str] = Header(None),
):
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        if payload.title is not None:
            meeting.title = payload.title
        if payload.start_time is not None:
            meeting.start_time = payload.start_time
        if payload.end_time is not None:
            meeting.end_time = payload.end_time
        if payload.calendar_event_id is not None:
            meeting.calendar_event_id = payload.calendar_event_id

        db.commit()
        db.refresh(meeting)
        return meeting_to_dict(meeting)
    finally:
        db.close()


@app.post("/meetings/with-audio", response_model=MeetingOut)
async def create_meeting_with_audio(
    title: str = Form(...),
    folder_id: Optional[str] = Form(None),
    start_time: Optional[str] = Form(None),
    end_time: Optional[str] = Form(None),
    calendar_event_id: Optional[str] = Form(None),
    audio: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
    x_llm_api_key: Optional[str] = Header(None),
):
    """
    Create a new Meeting from an uploaded audio file.
    """
    meeting_id = str(uuid.uuid4())
    audio_filename = f"{meeting_id}.wav"
    audio_path = os.path.join(AUDIO_DIR, audio_filename)

    save_upload_to_wav(audio, audio_path)

    # Attempt transcription + AI, but never fail the request if AI is unavailable.
    transcript: str = ""
    summary: Optional[str] = None
    action_items: List[ActionItem] = []
    try:
        transcript = await transcribe_audio(audio_path, api_key=x_llm_api_key)
        try:
            summary, action_items = await asyncio.gather(
                generate_summary(transcript, api_key=x_llm_api_key),
                extract_action_items_via_llama(transcript, api_key=x_llm_api_key),
            )
        except HTTPException:
            # Summarization/action-items failed (e.g., quota); fall back to no AI.
            summary = None
            action_items = []
        except Exception:
            summary = None
            action_items = []
    except HTTPException:
        # Transcription failed (e.g., no key or quota); fall back to audio-only meeting.
        transcript = ""
        summary = None
        action_items = []
    except Exception:
        transcript = ""
        summary = None
        action_items = []

    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        action_items_json = json.dumps(
            [
                {
                    "task": item.task,
                    "owner": item.owner,
                    "due_date": item.due_date,
                    "status": item.status or "open",
                }
                for item in action_items
            ]
        )

        meeting = Meeting(
            id=meeting_id,
            title=title,
            folder_id=folder_id,
            owner_id=current_user.id,
            created_at=datetime.utcnow(),
            start_time=start_time,
            end_time=end_time,
            status="completed",
            transcript=transcript,
            summary=summary,
            audio_path=os.path.join("audio", audio_filename),
            calendar_event_id=calendar_event_id,
            action_items=action_items_json,
            is_favorite=False,
        )

        db.add(meeting)
        db.commit()
        db.refresh(meeting)
        return meeting_to_dict(meeting)
    finally:
        db.close()


@app.get("/audio/{filename}")
def get_audio(filename: str):
    file_path = os.path.join(AUDIO_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(file_path, media_type="audio/wav")


@app.delete("/meetings/{meeting_id}")
def delete_meeting(
    meeting_id: str,
    authorization: Optional[str] = Header(None),
):
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        if meeting.audio_path:
            audio_file = os.path.join(BASE_DIR, meeting.audio_path)
            if os.path.exists(audio_file):
                try:
                    os.remove(audio_file)
                except OSError:
                    pass

        db.delete(meeting)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


# -----------------------------------------------------------------------------
# Favorite, folder assignment, and action items update
# -----------------------------------------------------------------------------


def _set_favorite_flag(
    db: Session,
    meeting_id: str,
    favorite: bool,
    current_user: "User",
) -> dict:
    meeting = (
        db.query(Meeting)
        .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
        .first()
    )
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    meeting.is_favorite = bool(favorite)
    db.commit()
    db.refresh(meeting)
    return meeting_to_dict(meeting)


@app.put("/meetings/{meeting_id}/favorite", response_model=MeetingOut)
def set_favorite_json(
    meeting_id: str,
    payload: FavoritePayload,
    authorization: Optional[str] = Header(None),
):
    """
    PUT version: accepts JSON { "favorite": true/false }.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        return _set_favorite_flag(db, meeting_id, payload.favorite, current_user)
    finally:
        db.close()


@app.post("/meetings/{meeting_id}/favorite", response_model=MeetingOut)
def set_favorite_form(
    meeting_id: str,
    favorite: bool = Form(...),
    authorization: Optional[str] = Header(None),
):
    """
    POST version: accepts form field 'favorite' from the frontend.
    This matches the React FormData call in api.ts.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        return _set_favorite_flag(db, meeting_id, favorite, current_user)
    finally:
        db.close()


@app.api_route(
    "/meetings/{meeting_id}/folder",
    methods=["POST", "PUT"],
    response_model=MeetingOut,
)
def set_meeting_folder(
    meeting_id: str,
    payload: FolderAssignment,
    authorization: Optional[str] = Header(None),
):
    """
    Move a meeting into a folder (or remove from folder if folder_id is null).
    Accepts JSON body { "folder_id": "<id or null>" }.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        if payload.folder_id is not None:
            folder = (
                db.query(Folder)
                .filter(
                    Folder.id == payload.folder_id,
                    Folder.owner_id == current_user.id,
                )
                .first()
            )
            if not folder:
                raise HTTPException(
                    status_code=404, detail="Folder not found for this user."
                )

        meeting.folder_id = payload.folder_id
        db.commit()
        db.refresh(meeting)
        return meeting_to_dict(meeting)
    finally:
        db.close()


@app.put("/meetings/{meeting_id}/action-items", response_model=MeetingOut)
def update_meeting_action_items(
    meeting_id: str,
    payload: MeetingActionItemsPayload,
    authorization: Optional[str] = Header(None),
):
    """
    Replace the meeting's action_items with the list provided by the client.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        items_json = json.dumps(
            [
                {
                    "task": item.task,
                    "owner": item.owner,
                    "due_date": item.due_date,
                    "status": item.status or "open",
                }
                for item in payload.action_items
            ]
        )
        meeting.action_items = items_json
        db.commit()
        db.refresh(meeting)
        return meeting_to_dict(meeting)
    finally:
        db.close()


@app.post("/meetings/{meeting_id}/extract_action_items", response_model=MeetingOut)
async def extract_action_items_endpoint(
    meeting_id: str,
    authorization: Optional[str] = Header(None),
    x_llm_api_key: Optional[str] = Header(None),
):
    """
    Re-extract action items from the meeting's transcript using the LLM.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        if not meeting.transcript or not meeting.transcript.strip():
            raise HTTPException(
                status_code=400,
                detail="No transcript available to extract action items from.",
            )

        items = await extract_action_items_via_llama(
            meeting.transcript,
            api_key=x_llm_api_key,
        )

        items_json = json.dumps(
            [
                {
                    "task": item.task,
                    "owner": item.owner,
                    "due_date": item.due_date,
                    "status": item.status or "open",
                }
                for item in items
            ]
        )

        meeting.action_items = items_json
        db.commit()
        db.refresh(meeting)
        return meeting_to_dict(meeting)
    finally:
        db.close()


@app.post(
    "/meetings/{meeting_id}/smart-summary", response_model=SmartSummaryResponse
)
async def smart_summary_endpoint(
    meeting_id: str,
    payload: SmartSummaryRequest,
    authorization: Optional[str] = Header(None),
    x_llm_api_key: Optional[str] = Header(None),
) -> SmartSummaryResponse:
    """
    Generate alternate AI summaries for a meeting (executive, detailed, decisions, persona).
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        if not meeting.transcript and not meeting.summary:
            raise HTTPException(
                status_code=400,
                detail="No content available for this meeting yet.",
            )
        text = await generate_smart_summary(
            meeting,
            payload.mode,
            payload.persona_name,
            api_key=x_llm_api_key,
        )
        return SmartSummaryResponse(summary=text)
    finally:
        db.close()


@app.post("/ai/qa", response_model=QAResponse)
async def ai_question_answer(
    payload: QARequest,
    authorization: Optional[str] = Header(None),
    x_llm_api_key: Optional[str] = Header(None),
) -> QAResponse:
    """
    Answer a natural language question using recent meeting summaries/transcripts.
    """
    question = (payload.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        # Use the most recent N meetings as context for this user
        meetings = (
            db.query(Meeting)
            .filter(Meeting.owner_id == current_user.id)
            .order_by(Meeting.created_at.desc())
            .limit(40)
            .all()
        )
    finally:
        db.close()

    if not meetings:
        return QAResponse(answer="There are no meetings in the system yet.", references=[])

    context_lines = []
    for m in meetings:
        context_lines.append(
            f"- id: {m.id}\n"
            f"  title: {m.title}\n"
            f"  created_at: {m.created_at.isoformat()}\n"
            f"  summary: {m.summary or 'No summary available.'}\n"
        )

    context = "\n\n".join(context_lines)

    prompt = (
        "You are an assistant that answers questions about past meetings.\n"
        "You are given a list of meetings with id, title, created_at, and summary.\n"
        "Answer the user's question based ONLY on this context.\n"
        "If you truly cannot answer from the data, say you don't know.\n"
        "Respond in JSON with this exact shape:\n"
        "{\n"
        '  \"answer\": \"short markdown answer\",\n'
        '  \"references\": [ { \"meeting_id\": \"...\" }, ... ]\n'
        "}\n\n"
        f"Meetings:\n{context}\n\n"
        f"Question: {question}\n"
    )

    raw = await ollama_chat(prompt, api_key=x_llm_api_key)
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1 and end > start:
            raw_json = raw[start : end + 1]
        else:
            raw_json = raw
        parsed = json.loads(raw_json)
        answer_text = str(parsed.get("answer") or "").strip() or raw
        refs_raw = parsed.get("references") or []
    except Exception:
        # Fallback: return raw text, no references
        return QAResponse(answer=raw, references=[])

    # Map references to metadata
    refs: List[QAReference] = []
    id_set = {str(r.get("meeting_id")) for r in refs_raw if isinstance(r, dict)}
    if id_set:
        db = SessionLocal()
        try:
            rows = (
                db.query(Meeting)
                .filter(
                    Meeting.owner_id == _get_current_user_from_header(
                        authorization, db
                    ).id,
                    Meeting.id.in_(list(id_set)),
                )
                .order_by(Meeting.created_at.desc())
                .all()
            )
        finally:
            db.close()
        for m in rows:
            refs.append(
                QAReference(
                    meeting_id=m.id,
                    title=m.title,
                    created_at=m.created_at,
                )
            )

    return QAResponse(answer=answer_text, references=refs)


@app.post("/ai/topics", response_model=TopicClustersResponse)
async def ai_topics(
    authorization: Optional[str] = Header(None),
    x_llm_api_key: Optional[str] = Header(None),
) -> TopicClustersResponse:
    """
    Ask the LLM to cluster recent meetings into high-level topics.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        meetings = (
            db.query(Meeting)
            .filter(Meeting.owner_id == current_user.id)
            .order_by(Meeting.created_at.desc())
            .limit(50)
            .all()
        )
    finally:
        db.close()

    if not meetings:
        return TopicClustersResponse(clusters=[])

    meeting_lines = []
    for m in meetings:
        meeting_lines.append(
            f"- id: {m.id}\n"
            f"  title: {m.title}\n"
            f"  created_at: {m.created_at.isoformat()}\n"
            f"  summary: {m.summary or 'No summary'}\n"
        )

    context = "\n\n".join(meeting_lines)

    prompt = (
        "You are an assistant that groups related meetings into topics.\n"
        "Given the list of meetings below, create 3–8 coherent clusters.\n"
        "Respond ONLY as JSON with this shape:\n"
        "{ \"clusters\": [\n"
        "  {\n"
        "    \"name\": \"Short topic name\",\n"
        "    \"description\": \"Optional one-sentence description\",\n"
        "    \"meeting_ids\": [\"id1\", \"id2\", ...]\n"
        "  },\n"
        "  ...\n"
        "]}\n\n"
        f"Meetings:\n{context}\n"
    )

    raw = await ollama_chat(prompt, api_key=x_llm_api_key)
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1 and end > start:
            raw_json = raw[start : end + 1]
        else:
            raw_json = raw
        parsed = json.loads(raw_json)
        clusters_raw = parsed.get("clusters") or []
        clusters: List[TopicCluster] = []
        for c in clusters_raw:
            if not isinstance(c, dict):
                continue
            name = (c.get("name") or "").strip()
            if not name:
                continue
            meeting_ids = [
                str(mid)
                for mid in (c.get("meeting_ids") or [])
                if isinstance(mid, (str, int))
            ]
            clusters.append(
                TopicCluster(
                    name=name,
                    description=c.get("description"),
                    meeting_ids=meeting_ids,
                )
            )
    except Exception:
        return TopicClustersResponse(clusters=[])

    return TopicClustersResponse(clusters=clusters)


@app.post(
    "/meetings/{meeting_id}/sync_calendar", response_model=MeetingOut
)
def sync_meeting_calendar(
    meeting_id: str,
    payload: CalendarSyncPayload,
    authorization: Optional[str] = Header(None),
):
    """
    Create or update a Google Calendar event from a meeting.
    - If payload.event_id is provided, append the notes to that event and update its time.
    - Otherwise, create a new event.
    In both cases, calendar_event_id, start_time, and end_time are updated on the Meeting.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        service = _get_calendar_service_for_user(current_user, db)

        meeting = (
            db.query(Meeting)
            .filter(Meeting.id == meeting_id, Meeting.owner_id == current_user.id)
            .first()
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        # Determine start/end
        start_iso = payload.start_time or meeting.start_time
        end_iso = payload.end_time or meeting.end_time

        if not start_iso:
            start_iso = meeting.created_at.isoformat()

        if not end_iso:
            try:
                dt_start = datetime.fromisoformat(start_iso)
                dt_end = dt_start + timedelta(hours=1)
                end_iso = dt_end.isoformat()
            except Exception:
                end_iso = start_iso

        # Build description snippet
        snippet_lines = [
            "Meeting notes from AI Meeting Notes:",
            f"Title: {meeting.title}",
            f"Created at: {meeting.created_at.isoformat()}",
        ]
        if meeting.summary:
            snippet_lines.append("")
            snippet_lines.append("Summary:")
            snippet_lines.append(meeting.summary)
        description_snippet = "\n".join(snippet_lines)

        event_id: Optional[str] = None
        if payload.event_id:
            # Append to existing event
            try:
                ev = (
                    service.events()
                    .get(calendarId=GOOGLE_CALENDAR_ID, eventId=payload.event_id)
                    .execute()
                )
            except Exception as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to load existing event {payload.event_id}: {e}",
                )

            existing_desc = ev.get("description") or ""
            if description_snippet not in existing_desc:
                if existing_desc:
                    new_desc = existing_desc + "\n\n---\n" + description_snippet
                else:
                    new_desc = description_snippet
            else:
                new_desc = existing_desc

            ev["description"] = new_desc
            if not ev.get("summary"):
                ev["summary"] = meeting.title
            ev["start"] = {"dateTime": start_iso, "timeZone": "UTC"}
            ev["end"] = {"dateTime": end_iso, "timeZone": "UTC"}

            updated = (
                service.events()
                .update(
                    calendarId=GOOGLE_CALENDAR_ID,
                    eventId=payload.event_id,
                    body=ev,
                )
                .execute()
            )
            event_id = updated.get("id") or payload.event_id
        else:
            # Create a new event
            body = {
                "summary": meeting.title,
                "description": description_snippet,
                "start": {"dateTime": start_iso, "timeZone": "UTC"},
                "end": {"dateTime": end_iso, "timeZone": "UTC"},
            }
            created = (
                service.events()
                .insert(calendarId=GOOGLE_CALENDAR_ID, body=body)
                .execute()
            )
            event_id = created.get("id")

        if not event_id:
            raise HTTPException(
                status_code=500, detail="Failed to create or update calendar event."
            )

        meeting.calendar_event_id = event_id
        meeting.start_time = start_iso
        meeting.end_time = end_iso
        db.commit()
        db.refresh(meeting)
        return meeting_to_dict(meeting)
    finally:
        db.close()


@app.get("/calendar-events", response_model=List[CalendarEventOut])
def list_calendar_events(
    max_results: int = 0,
    start: Optional[str] = None,
    end: Optional[str] = None,
    authorization: Optional[str] = Header(None),
) -> List[CalendarEventOut]:
    """
    Return Google Calendar events (read-only) from the user's primary calendar.
    If `start` / `end` are provided, they should be RFC3339 strings and will be
    used as timeMin / timeMax for the query. Otherwise, events starting from now
    are returned. Requires a valid Authorization bearer token linked to a
    Google account.
    """
    db = SessionLocal()
    try:
        current_user = _get_current_user_from_header(authorization, db)
        service = _get_calendar_service_for_user(current_user, db)

        if start:
            time_min = start
        else:
            time_min = datetime.utcnow().isoformat() + "Z"

        params: dict = {
            "calendarId": GOOGLE_CALENDAR_ID,
            "timeMin": time_min,
            "singleEvents": True,
            "orderBy": "startTime",
        }
        if end:
            params["timeMax"] = end
        if max_results and max_results > 0:
            params["maxResults"] = max_results

        try:
            events_result = service.events().list(**params).execute()
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error fetching calendar events: {e}"
            )

        items = events_result.get("items", [])
        out: List[CalendarEventOut] = []
        for ev in items:
            ev_id = ev.get("id") or ""
            title = ev.get("summary") or "(No title)"
            html_link = ev.get("htmlLink")
            start_obj = ev.get("start", {})
            end_obj = ev.get("end", {})
            start_time = start_obj.get("dateTime") or start_obj.get("date") or ""
            end_time = end_obj.get("dateTime") or end_obj.get("date") or start_time
            out.append(
                CalendarEventOut(
                    id=ev_id,
                    title=title,
                    start_time=start_time,
                    end_time=end_time,
                    html_link=html_link,
                )
            )
        return out
    finally:
        db.close()
