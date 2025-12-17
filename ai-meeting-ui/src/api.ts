// src/api.ts

// Change this via Vite env when deploying (VITE_API_BASE); falls back to local dev URL.
export const API_BASE: string =
  (typeof import.meta !== "undefined" &&
    (import.meta as any).env &&
    (import.meta as any).env.VITE_API_BASE) ||
  "http://127.0.0.1:8000";

// ---------- Types ----------

export interface Folder {
  id: string;
  name: string;
  created_at: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  html_link?: string;
}

// For updating metadata
export interface MeetingMetadataUpdate {
  title?: string;
  start_time?: string | null;
  end_time?: string | null;
  calendar_event_id?: string | null;
}

// For action items
export interface ActionItem {
  task: string;
  owner?: string | null;
  due_date?: string | null;
  status?: "open" | "done" | string;
}

export interface Meeting {
  id: string;
  title: string;
  folder_id: string | null;
  created_at: string;
  start_time?: string | null;
  end_time?: string | null;
  status?: string;
  transcript?: string | null;
  summary?: string | null;
  audio_path?: string | null;
  calendar_event_id?: string | null;
  // Stored as JSON string or array in the backend
  action_items?: ActionItem[] | string | null;
  // Favorite flag
  is_favorite?: boolean;
}

// AI helpers
export interface SmartSummaryResponse {
  summary: string;
}

export type SmartSummaryMode = "executive" | "detailed" | "decisions" | "persona";

export interface QAReference {
  meeting_id: string;
  title: string;
  created_at: string;
}

export interface QAResponse {
  answer: string;
  references: QAReference[];
}

export interface TopicCluster {
  name: string;
  description?: string | null;
  meeting_ids: string[];
}

export interface TopicClustersResponse {
  clusters: TopicCluster[];
}

export interface CalendarSyncPayload {
  event_id?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}

// ---------- Helpers ----------

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("API error", res.status, res.statusText, text);
    throw new Error(
      `API error ${res.status}: ${res.statusText || text || "Unknown error"}`
    );
  }
  return (await res.json()) as T;
}

function getAuthHeaders(): HeadersInit {
  if (typeof window === "undefined") return {};
  const headers: HeadersInit = {};
  const token = window.localStorage.getItem("meetingApiToken");
  if (token) {
    (headers as any).Authorization = `Bearer ${token}`;
  }
  const llmKey = window.localStorage.getItem("meetingLlmApiKey");
  if (llmKey) {
    (headers as any)["X-LLM-Api-Key"] = llmKey;
  }
  return headers;
}

// ---------- Meetings ----------

export async function fetchMeetings(
  folderId?: string,
  favoritesOnly?: boolean
): Promise<Meeting[]> {
  const url = new URL(`${API_BASE}/meetings`);
  if (folderId) {
    url.searchParams.set("folder_id", folderId);
  }
  if (favoritesOnly) {
    url.searchParams.set("favorites_only", "true");
  }
  const res = await fetch(url.toString(), {
    headers: getAuthHeaders(),
  });
  return handleJson<Meeting[]>(res);
}

export async function fetchMeeting(id: string): Promise<Meeting> {
  const res = await fetch(`${API_BASE}/meetings/${id}`, {
    headers: getAuthHeaders(),
  });
  return handleJson<Meeting>(res);
}

export async function deleteMeeting(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/meetings/${id}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to delete meeting: ${res.status} ${text || res.statusText}`
    );
  }
}

// Upload a new meeting with recorded audio

export interface UploadMeetingOptions {
  title: string;
  folderId?: string | null;
  audioBlob: Blob;
  startTime?: string | null;
  endTime?: string | null;
  calendarEventId?: string | null;
}

export async function uploadMeetingWithAudio(
  options: UploadMeetingOptions
): Promise<Meeting> {
  const { title, folderId, audioBlob, startTime, endTime, calendarEventId } =
    options;

  console.log("[uploadMeetingWithAudio] raw audioBlob:", audioBlob);

  // Normalize to an actual Blob
  let filePart: Blob | null = null;

  if (audioBlob instanceof Blob) {
    filePart = audioBlob;
  } else if (audioBlob && (audioBlob as any).blob instanceof Blob) {
    // In case useRecorder returns { blob: Blob, url: string } or similar
    filePart = (audioBlob as any).blob;
    console.log("[uploadMeetingWithAudio] using audioBlob.blob");
  } else if (audioBlob && (audioBlob as any).file instanceof Blob) {
    // Or { file: Blob }
    filePart = (audioBlob as any).file;
    console.log("[uploadMeetingWithAudio] using audioBlob.file");
  }

  if (!filePart) {
    console.error(
      "[uploadMeetingWithAudio] audioBlob is not a Blob – cannot upload:",
      audioBlob
    );
    throw new Error("Recording data is not a Blob. Please re-record and try again.");
  }

  const formData = new FormData();

  // Must match FastAPI parameter names
  formData.append("title", title);

  if (folderId) {
    formData.append("folder_id", folderId);
  }
  if (startTime) {
    formData.append("start_time", startTime);
  }
  if (endTime) {
    formData.append("end_time", endTime);
  }
  if (calendarEventId) {
    formData.append("calendar_event_id", calendarEventId);
  }

  // Critical: field name "audio" and value must be a Blob
  formData.append("audio", filePart, "recording.webm");

  const res = await fetch(`${API_BASE}/meetings/with-audio`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
    // DO NOT set Content-Type manually; browser sets multipart boundary.
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Upload failed:", res.status, text);
    throw new Error(`Upload failed: ${res.status}`);
  }

  return (await res.json()) as Meeting;
}

// Search meetings (backend: GET /meetings/search -> Meeting[])
export async function searchMeetings(query: string): Promise<Meeting[]> {
  const url = new URL(`${API_BASE}/meetings/search`);
  url.searchParams.set("q", query);
  const res = await fetch(url.toString(), {
    headers: getAuthHeaders(),
  });
  return handleJson<Meeting[]>(res);
}

export async function updateMeetingMetadata(
  id: string,
  payload: MeetingMetadataUpdate
): Promise<Meeting> {
  const res = await fetch(`${API_BASE}/meetings/${id}/metadata`, {
    method: "PATCH",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return handleJson<Meeting>(res);
}

// Extract / re-extract action items from transcript using LLM
export async function extractActionItems(meetingId: string): Promise<Meeting> {
  const res = await fetch(
    `${API_BASE}/meetings/${meetingId}/extract_action_items`,
    {
      method: "POST",
      headers: getAuthHeaders(),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      "API error in extractActionItems",
      res.status,
      res.statusText,
      text
    );
    throw new Error(
      `Failed to extract action items (status ${res.status}). See console for details.`
    );
  }

  return (await res.json()) as Meeting;
}

// Update all action items for a meeting (editable UI)
export async function updateMeetingActionItems(
  meetingId: string,
  items: ActionItem[]
): Promise<Meeting> {
  const res = await fetch(`${API_BASE}/meetings/${meetingId}/action-items`, {
    method: "PUT",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action_items: items.map((item) => ({
        task: item.task,
        owner: item.owner ?? null,
        due_date: item.due_date ?? null,
        status: item.status ?? "open",
      })),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return (await res.json()) as Meeting;
}

// Favorite flag
export async function updateMeetingFavorite(
  meetingId: string,
  favorite: boolean
): Promise<Meeting> {
  const formData = new FormData();
  // FastAPI gets this as a form field named "favorite"
  formData.append("favorite", favorite ? "true" : "false");

  const res = await fetch(`${API_BASE}/meetings/${meetingId}/favorite`, {
    method: "POST", // backend supports POST form + PUT JSON
    headers: getAuthHeaders(),
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("API error update favorite", res.status, text);
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return (await res.json()) as Meeting;
}

// ---------- AI Summaries / QA / Topics ----------

export async function smartSummarizeMeeting(
  meetingId: string,
  mode: SmartSummaryMode,
  personaName?: string
): Promise<SmartSummaryResponse> {
  const res = await fetch(`${API_BASE}/meetings/${meetingId}/smart-summary`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode,
      persona_name: personaName ?? null,
    }),
  });
  return handleJson<SmartSummaryResponse>(res);
}

export async function askMeetingsQuestion(
  question: string
): Promise<QAResponse> {
  const res = await fetch(`${API_BASE}/ai/qa`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question }),
  });
  return handleJson<QAResponse>(res);
}

export async function fetchTopicClusters(): Promise<TopicClustersResponse> {
  const res = await fetch(`${API_BASE}/ai/topics`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  return handleJson<TopicClustersResponse>(res);
}

export async function syncMeetingCalendar(
  meetingId: string,
  payload: CalendarSyncPayload
): Promise<Meeting> {
  const res = await fetch(`${API_BASE}/meetings/${meetingId}/sync_calendar`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return handleJson<Meeting>(res);
}

// Move meeting to a folder
export async function updateMeetingFolder(
  meetingId: string,
  folderId: string | null
): Promise<Meeting> {
  const res = await fetch(`${API_BASE}/meetings/${meetingId}/folder`, {
    method: "POST", // backend accepts POST or PUT
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ folder_id: folderId }),
  });
  return handleJson<Meeting>(res);
}

// ---------- Folders ----------

export async function fetchFolders(): Promise<Folder[]> {
  const res = await fetch(`${API_BASE}/folders`, {
    headers: getAuthHeaders(),
  });
  return handleJson<Folder[]>(res);
}

export async function createFolder(name: string): Promise<Folder> {
  const res = await fetch(`${API_BASE}/folders`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  return handleJson<Folder>(res);
}

export async function renameFolder(
  folderId: string,
  name: string
): Promise<Folder> {
  const res = await fetch(`${API_BASE}/folders/${folderId}`, {
    method: "PUT",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  return handleJson<Folder>(res);
}

export async function deleteFolder(folderId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/folders/${folderId}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to delete folder: ${res.status} ${text || res.statusText}`
    );
  }
}

// ---------- Calendar (optional) ----------
// NOTE: Backend implements /calendar-events but it requires the user
// to connect their Google account first via the /auth/google/start flow.

export async function fetchCalendarEvents(
  start?: string,
  end?: string
): Promise<CalendarEvent[]> {
  const url = new URL(`${API_BASE}/calendar-events`);
  if (start) url.searchParams.set("start", start);
  if (end) url.searchParams.set("end", end);
  const res = await fetch(url.toString(), {
    headers: getAuthHeaders(),
  });
  return handleJson<CalendarEvent[]>(res);
}
