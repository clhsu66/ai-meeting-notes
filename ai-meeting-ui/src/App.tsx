// src/App.tsx
import React, { useEffect, useRef, useState, useMemo } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ChangeEvent,
} from "react";
import ReactMarkdown from "react-markdown";

import {
  fetchMeetings,
  fetchFolders,
  uploadMeetingWithAudio,
  fetchMeeting,
  API_BASE,
  deleteMeeting as apiDeleteMeeting,
  searchMeetings,
  updateMeetingMetadata,
  fetchCalendarEvents,
  extractActionItems,
  createFolder,
  renameFolder,
  deleteFolder as apiDeleteFolder,
  updateMeetingFolder,
  updateMeetingFavorite,
  updateMeetingActionItems,
  smartSummarizeMeeting,
  askMeetingsQuestion,
  fetchTopicClusters,
  syncMeetingCalendar,
} from "./api";
import type {
  Meeting,
  Folder,
  CalendarEvent,
  SmartSummaryMode,
  QAResponse,
  TopicCluster,
} from "./api";
import { useRecorder } from "./hooks/useRecorder";

// ----- Types & helpers -----

type View =
  | { type: "list" }
  | { type: "detail"; meetingId: string }
  | { type: "actions" }
  | { type: "calendar" };

export interface ActionItem {
  task: string;
  owner?: string | null;
  due_date?: string | null;
  status?: "open" | "done" | string;
}

interface Command {
  id: string;
  label: string;
  section: "General" | "Navigation" | "Filters";
  hint?: string;
  run: () => void;
  visible?: boolean;
}

interface AggregatedActionItem {
  id: string;
  meetingId: string;
  meetingTitle: string;
  createdAt: string;
  itemIndex: number;
  task: string;
  owner?: string;
  dueDate?: string;
  status?: string;
}

function getMeetingStartDate(meeting: Meeting): Date | null {
  const raw = meeting.start_time || meeting.created_at;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d;
}

function getDayKey(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function isSameDay(a: Date, b: Date): boolean {
  return getDayKey(a) === getDayKey(b);
}

function getSummaryPreview(summary: string): string {
  const lines = summary.split("\n").map((l) => l.trim());
  const candidate = lines.find((l) => l && !l.startsWith("#"));
  return candidate || lines[0] || "";
}

function slugifyForFilename(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "meeting";
}

function getActionItemStats(
  meeting: Meeting | null
): { total: number; open: number; overdue: number; allDone: boolean } {
  const items = parseActionItemsFromMeeting(meeting);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let open = 0;
  let overdue = 0;

  for (const item of items) {
    const status = (item.status || "open").toLowerCase();
    const isDone = status === "done";
    if (!isDone) {
      open += 1;
      if (item.due_date) {
        const dt = new Date(item.due_date);
        if (!isNaN(dt.getTime())) {
          const dayOnly = new Date(dt);
          dayOnly.setHours(0, 0, 0, 0);
          if (dayOnly < today) {
            overdue += 1;
          }
        }
      }
    }
  }

  const total = items.length;
  const allDone = total > 0 && open === 0;
  return { total, open, overdue, allDone };
}

// Parse the JSON string of action items from a Meeting into an array
function parseActionItemsFromMeeting(meeting: Meeting | null): ActionItem[] {
  if (!meeting || !meeting.action_items) return [];

  try {
    const raw = meeting.action_items as any;

    // Case 1: backend already returned an array
    if (Array.isArray(raw)) {
      return raw
        .filter((it) => it && typeof it.task === "string")
        .map((it) => ({
          task: it.task,
          owner: it.owner ?? null,
          due_date: it.due_date ?? null,
          status: it.status ?? "open",
        }));
    }

    // Case 2: older data stored as JSON string
    if (typeof raw === "string") {
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((it) => it && typeof it.task === "string")
        .map((it) => ({
          task: it.task,
          owner: it.owner ?? null,
          due_date: it.due_date ?? null,
          status: it.status ?? "open",
        }));
    }

    return [];
  } catch (e) {
    console.error("Failed to parse action_items:", e);
    return [];
  }
}

// Build a markdown document for a meeting + its action items
function buildMarkdownForMeeting(
  meeting: Meeting,
  options?: {
    includeSummary?: boolean;
    includeTranscript?: boolean;
    includeActionItems?: boolean;
  }
): string {
  const {
    includeSummary = true,
    includeTranscript = true,
    includeActionItems = true,
  } = options || {};

  const parts: string[] = [];
  parts.push(`# ${meeting.title}`);
  parts.push("");
  parts.push(`**Created:** ${new Date(meeting.created_at).toLocaleString()}`);
  parts.push("");

  if (includeSummary && meeting.summary) {
    parts.push("## Summary");
    parts.push("");
    parts.push(meeting.summary);
    parts.push("");
  }

  if (includeTranscript && meeting.transcript) {
    parts.push("## Transcript");
    parts.push("");
    parts.push(meeting.transcript);
    parts.push("");
  }

  const items = parseActionItemsFromMeeting(meeting);

  if (includeActionItems && items.length > 0) {
    parts.push("## Action Items");
    parts.push("");
    for (const item of items) {
      const bits = [item.task];
      if (item.owner) bits.push(`(Owner: ${item.owner})`);
      if (item.due_date) bits.push(`(Due: ${item.due_date})`);
      parts.push(`- ${bits.join(" ")}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// Simple time formatter (used by action-items table)
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ====== MAIN APP COMPONENT ======

function App() {
  const [view, setView] = useState<View>({ type: "list" });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<
    string | undefined
  >();

  const [loading, setLoading] = useState(false);

  // Recorder + title
  const {
    isRecording,
    isPaused,
    elapsedSeconds,
    audioBlob,
    start,
    stop,
    pause,
    resume,
  } = useRecorder();
  const [title, setTitle] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // Search & filters
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [filterFavoritesOnly, setFilterFavoritesOnly] = useState(false);
  const [filterHasActionItems, setFilterHasActionItems] = useState(false);
  const [filterFromDate, setFilterFromDate] = useState("");
  const [filterToDate, setFilterToDate] = useState("");

  // Track when a recording "belongs" (for calendar / agenda)
  const [recordingStartTime, setRecordingStartTime] = useState<string | null>(
    null
  );

  // AI Q&A
  const [qaQuestion, setQaQuestion] = useState("");
  const [qaResult, setQaResult] = useState<QAResponse | null>(null);
  const [qaLoading, setQaLoading] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);

  // Topic clusters
  const [topicClusters, setTopicClusters] = useState<TopicCluster[] | null>(
    null
  );
  const [topicsLoading, setTopicsLoading] = useState(false);

  // Google Calendar events
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarEventsLoaded, setCalendarEventsLoaded] = useState(false);
  const [selectedCalendarEventId, setSelectedCalendarEventId] = useState<
    string | null
  >(null);

  // Auth / current user (for Google)
  const [apiToken, setApiToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [hasLlmApiKey, setHasLlmApiKey] = useState(false);
  const [showAiHelp, setShowAiHelp] = useState(false);

  // Folder create / rename
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Theme
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem("meetingTheme");
      if (saved === "light" || saved === "dark") return saved;
    }
    return "light";
  });
  const isDark = theme === "dark";

  // Layout responsivity
  const [isNarrow, setIsNarrow] = useState(false);

  // Command palette
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const paletteInputRef = useRef<HTMLInputElement | null>(null);

  // Toast notifications
  const [toast, setToast] = useState<{
    message: string;
    type: "info" | "success" | "error";
  } | null>(null);

  const showToast = (
    message: string,
    type: "info" | "success" | "error" = "info"
  ) => {
    setToast({ message, type });
  };

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => {
      setToast(null);
    }, 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // ---- Effects ----

  // Capture auth token from URL (after Google OAuth redirect)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const email = params.get("email");

    if (token) {
      window.localStorage.setItem("meetingApiToken", token);
      setApiToken(token);
    } else {
      const savedToken = window.localStorage.getItem("meetingApiToken");
      if (savedToken) {
        setApiToken(savedToken);
      }
    }

    if (email) {
      window.localStorage.setItem("meetingUserEmail", email);
      setUserEmail(email);
    } else {
      const savedEmail = window.localStorage.getItem("meetingUserEmail");
      if (savedEmail) {
        setUserEmail(savedEmail);
      }
    }

    if (token || email) {
      params.delete("token");
      params.delete("email");
      const newSearch = params.toString();
      const newUrl =
        window.location.pathname +
        (newSearch ? `?${newSearch}` : "") +
        window.location.hash;
      window.history.replaceState(null, "", newUrl);
    }

    // Check for a stored LLM API key
    const storedLlmKey = window.localStorage.getItem("meetingLlmApiKey");
    setHasLlmApiKey(!!storedLlmKey);
  }, []);

  // Initial load
  useEffect(() => {
    const load = async () => {
      try {
        const [f, m] = await Promise.all([fetchFolders(), fetchMeetings()]);
        setFolders(f);
        setMeetings(m);

        // Load Google Calendar events from today through one year ahead.
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setFullYear(start.getFullYear() + 1);
        const rangeStart = start.toISOString();
        const rangeEnd = end.toISOString();
        const events = await fetchCalendarEvents(rangeStart, rangeEnd);
        setCalendarEvents(events);
      } catch (e) {
        console.error("Failed to load folders/meetings or calendar events", e);
      } finally {
        setCalendarEventsLoaded(true);
      }
    };

    if (!apiToken) {
      setFolders([]);
      setMeetings([]);
      setCalendarEvents([]);
      setCalendarEventsLoaded(true);
      return;
    }

    void load();
  }, [apiToken]);

  const handleConnectGoogle = () => {
    if (typeof window === "undefined") return;
    const frontendBase = window.location.origin;
    const url = `${API_BASE}/auth/google/start?frontend_redirect=${encodeURIComponent(
      frontendBase
    )}`;
    window.location.href = url;
  };

  const handleSetLlmApiKey = () => {
    if (typeof window === "undefined") return;
    const current = window.localStorage.getItem("meetingLlmApiKey") || "";
    const value = window.prompt(
      "Enter your AI API key (for example, an OpenAI API key). Leave blank to clear.",
      current
    );
    if (value === null) return;
    const trimmed = value.trim();
    if (trimmed) {
      window.localStorage.setItem("meetingLlmApiKey", trimmed);
      setHasLlmApiKey(true);
    } else {
      window.localStorage.removeItem("meetingLlmApiKey");
      setHasLlmApiKey(false);
    }
  };

  // Theme effect
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("meetingTheme", theme);
      document.body.style.backgroundColor = isDark ? "#020617" : "#f5f5f7";
    }
  }, [theme, isDark]);

  // Layout resize
  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== "undefined") {
        setIsNarrow(window.innerWidth < 900);
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Helper to reload meetings (optionally by folder)
  const reloadMeetings = async (folderId?: string) => {
    const m = await fetchMeetings(folderId, filterFavoritesOnly);
    setMeetings(m);
  };

  // Helper: start recording and remember which date/time this meeting belongs to.
  function startRecordingForDate(dateOverride?: Date) {
    if (isRecording) return;
    const when = dateOverride ?? new Date();
    setRecordingStartTime(when.toISOString());
    start();
  }

  const handleFolderClick = async (folderId?: string) => {
    setSelectedFolderId(folderId);
    setSearchQuery("");
    setSearching(false);
    await reloadMeetings(folderId);
  };

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const key = e.key;

      // If palette open, let Esc close it; typing handled inside
      if (isCommandPaletteOpen) {
        if (key === "Escape") {
          e.preventDefault();
          setCommandPaletteOpen(false);
          setPaletteQuery("");
        }
        return;
      }

      // Ignore when typing in inputs/textareas (except Cmd+K)
      const active = document.activeElement as HTMLElement | null;
      const isEditable =
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.getAttribute("contenteditable") === "true");

      if (isEditable) {
        if (e.metaKey && key.toLowerCase() === "k") {
          e.preventDefault();
          setCommandPaletteOpen(true);
          setPaletteQuery("");
          setTimeout(() => {
            paletteInputRef.current?.focus();
          }, 10);
        }
        return;
      }

      // Cmd+K — toggle Command Palette
      if (e.metaKey && key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        setPaletteQuery("");
        if (!isCommandPaletteOpen) {
          setTimeout(() => {
            paletteInputRef.current?.focus();
          }, 10);
        }
        return;
      }

      // "/" — focus search
      if (key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // "n" — new meeting (focus title + start recording)
        if ((key === "n" || key === "N") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (!isRecording) {
          titleInputRef.current?.focus();
          startRecordingForDate();
        }
        return;
      }
      // Escape — close detail or clear search
      if (key === "Escape") {
        e.preventDefault();
        if (view.type === "detail") {
          setView({ type: "list" });
          return;
        }
        if (searchQuery) {
          setSearchQuery("");
          setSearching(false);
          void reloadMeetings(selectedFolderId);
        }
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    isCommandPaletteOpen,
    isRecording,
    searchQuery,
    view,
    selectedFolderId,
    start,
  ]);

  // ---- Folder handlers ----

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const created = await createFolder(name);
      setFolders((prev) => [...prev, created]);
      setNewFolderName("");
    } catch (e) {
      console.error(e);
      alert("Failed to create folder.");
    }
  };

  const handleBeginRenameFolder = (folder: Folder) => {
    setRenamingFolderId(folder.id);
    setRenameValue(folder.name);
  };

  const handleRenameFolderKeyDown = (
    e: ReactKeyboardEvent<HTMLInputElement>,
    folderId: string
  ) => {
    if (e.key === "Enter") {
      void handleCommitRenameFolder(folderId);
    } else if (e.key === "Escape") {
      setRenamingFolderId(null);
      setRenameValue("");
    }
  };

  const handleCommitRenameFolder = async (folderId: string) => {
    const name = renameValue.trim();
    if (!name) {
      alert("Folder name cannot be empty.");
      return;
    }
    try {
      const updated = await renameFolder(folderId, name);
      setFolders((prev) =>
        prev.map((f) => (f.id === folderId ? { ...f, name: updated.name } : f))
      );
      setRenamingFolderId(null);
      setRenameValue("");
    } catch (e) {
      console.error(e);
      alert("Failed to rename folder.");
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    const ok = window.confirm(
      "Delete this folder? Meetings inside will NOT be deleted; they will just move to 'All meetings'."
    );
    if (!ok) return;
    try {
      await apiDeleteFolder(folderId);
      setFolders((prev) => prev.filter((f) => f.id !== folderId));
      if (selectedFolderId === folderId) {
        setSelectedFolderId(undefined);
        await reloadMeetings(undefined);
      } else {
        await reloadMeetings(selectedFolderId);
      }
    } catch (e) {
      console.error(e);
      alert("Failed to delete folder.");
    }
  };

  // ---- Upload / search / filters ----

  const handleUpload = async () => {
    if (!audioBlob || !title.trim()) {
      alert("Please add a title and record something first.");
      return;
    }
    setLoading(true);
    showToast("Saving meeting…", "info");
    try {
      // Use the remembered recordingStartTime if we have one (e.g., from the calendar),
      // otherwise default to "now".
      const startTime = recordingStartTime || new Date().toISOString();
      const endTime = new Date().toISOString();

      const meeting = await uploadMeetingWithAudio({
        title: title.trim(),
        folderId: selectedFolderId,
        audioBlob,
        startTime,
        endTime,
        calendarEventId: selectedCalendarEventId,
      });

      setTitle("");
      setRecordingStartTime(null);
      setSelectedCalendarEventId(null);
      await reloadMeetings(selectedFolderId);
      setView({ type: "detail", meetingId: meeting.id });
      showToast("Meeting saved", "success");
    } catch (e) {
      console.error(e);
      showToast("Failed to save meeting", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      setSearching(false);
      await reloadMeetings(selectedFolderId);
      return;
    }
    setSearching(true);
    try {
      const results = await searchMeetings(q);
      setMeetings(results);
    } catch (e) {
      console.error(e);
      alert("Search failed. Please try again.");
    }
  };

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void handleSearch();
    }
  };

  const handleToggleFavoriteInList = async (
    meetingId: string,
    current: boolean | undefined
  ) => {
    try {
      const updated = await updateMeetingFavorite(meetingId, !current);
      setMeetings((prev) =>
        prev.map((m) =>
          m.id === meetingId ? { ...m, is_favorite: updated.is_favorite } : m
        )
      );
    } catch (e) {
      console.error(e);
      alert("Failed to update favorite.");
    }
  };

  // Filtered meetings (for Search 2.0)
  const filteredMeetings = meetings.filter((m) => {
    if (filterFavoritesOnly && !m.is_favorite) return false;

    if (filterHasActionItems) {
      const items = parseActionItemsFromMeeting(m);
      if (items.length === 0) return false;
    }

    if (filterFromDate || filterToDate) {
      try {
        const created = new Date(m.created_at);
        if (filterFromDate) {
          const from = new Date(filterFromDate);
          if (created < from) return false;
        }
        if (filterToDate) {
          const to = new Date(filterToDate);
          const end = new Date(to);
          end.setDate(end.getDate() + 1);
          if (created >= end) return false;
        }
      } catch {
        // ignore if bad date
      }
    }

    return true;
  });

  const upcomingCalendarEvents = useMemo(() => {
    if (!calendarEvents || calendarEvents.length === 0) return [];
    const now = new Date();
    return calendarEvents
      .filter((ev) => {
        if (!ev.start_time) return false;
        const d = new Date(ev.start_time);
        if (isNaN(d.getTime())) return false;
        return d >= now;
      })
      .sort((a, b) => {
        const ad = new Date(a.start_time).getTime();
        const bd = new Date(b.start_time).getTime();
        if (isNaN(ad) || isNaN(bd)) return 0;
        return ad - bd;
      });
  }, [calendarEvents]);

  // ----- Command Palette: build dynamic commands -----

  const commands: Command[] = [
    {
      id: "new-meeting",
      label: "New meeting (start recording)",
      section: "General",
      hint: "N",
      run: () => {
        if (!isRecording) {
          titleInputRef.current?.focus();
          startRecordingForDate();
        }
      },
      visible: true,
    },
    {
      id: "toggle-theme",
      label: isDark ? "Switch to light mode" : "Switch to dark mode",
      section: "General",
      run: () => {
        setTheme(isDark ? "light" : "dark");
      },
      visible: true,
    },
    {
      id: "focus-search",
      label: "Focus search",
      section: "General",
      hint: "/",
      run: () => {
        searchInputRef.current?.focus();
      },
      visible: true,
    },
    {
      id: "all-meetings",
      label: "Go to All meetings",
      section: "Navigation",
      run: () => {
        void handleFolderClick(undefined);
      },
      visible: true,
    },
    {
      id: "view-calendar",
      label: "Go to Calendar view",
      section: "Navigation",
      run: () => {
        setView({ type: "calendar" });
      },
      visible: true,
    },
    {
      id: "filter-favorites",
      label: filterFavoritesOnly
        ? "Show all (turn off favorites filter)"
        : "Show favorites only",
      section: "Filters",
      run: () => {
        setFilterFavoritesOnly((v) => !v);
      },
      visible: true,
    },
    {
      id: "filter-action-items",
      label: filterHasActionItems
        ? "Show all (turn off action items filter)"
        : "Show only with action items",
      section: "Filters",
      run: () => {
        setFilterHasActionItems((v) => !v);
      },
      visible: true,
    },
    // Folder navigation
    ...folders.map<Command>((f) => ({
      id: `folder-${f.id}`,
      label: `Go to folder: ${f.name}`,
      section: "Navigation",
      run: () => {
        void handleFolderClick(f.id);
      },
      visible: true,
    })),
  ];

  const filteredCommands = commands.filter((cmd) => {
    if (cmd.visible === false) return false;
    if (!paletteQuery.trim()) return true;
    const q = paletteQuery.toLowerCase();
    return cmd.label.toLowerCase().includes(q);
  });

  const toastElement = toast ? (
    <div
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        maxWidth: 320,
        padding: "8px 12px",
        borderRadius: 12,
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: isDark
          ? "0 12px 32px rgba(0,0,0,0.8)"
          : "0 12px 32px rgba(15,23,42,0.25)",
        background:
          toast.type === "error"
            ? isDark
              ? "#7f1d1d"
              : "#fee2e2"
            : toast.type === "success"
            ? isDark
              ? "#065f46"
              : "#dcfce7"
            : isDark
            ? "#111827"
            : "#e5e7eb",
        color:
          toast.type === "error"
            ? isDark
              ? "#fecaca"
              : "#b91c1c"
            : toast.type === "success"
            ? isDark
              ? "#bbf7d0"
              : "#166534"
            : isDark
            ? "#e5e7eb"
            : "#111827",
        zIndex: 10000,
      }}
    >
      <span aria-hidden="true">
        {toast.type === "error"
          ? "⚠️"
          : toast.type === "success"
          ? "✅"
          : "ℹ️"}
      </span>
      <span>{toast.message}</span>
    </div>
  ) : null;

  // ===================== RENDER =====================

  // DETAIL VIEW wrapper
  if (view.type === "detail") {
    return (
      <div
        style={{
          minHeight: "100vh",
          padding: 16,
          background: isDark ? "#020617" : "#f5f5f7",
          color: isDark ? "#e5e7eb" : "#111827",
          fontFamily: "system-ui",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "100%",
            margin: 0,
            height: "calc(100vh - 32px)",
            borderRadius: 20,
            boxShadow: isDark
              ? "0 18px 40px rgba(0,0,0,0.7)"
              : "0 18px 40px rgba(15,23,42,0.16)",
            background: isDark ? "#020617" : "#ffffff",
            border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
            position: "relative",
          }}
        >
          <div className="view-transition" style={{ height: "100%" }}>
            <MeetingDetail
              meetingId={view.meetingId}
              onBack={() => setView({ type: "list" })}
              onDeleted={(id) => {
                setMeetings((prev) => prev.filter((m) => m.id !== id));
                setView({ type: "list" });
              }}
              folders={folders}
              onFolderChanged={(id, newFolderId) => {
                setMeetings((prev) => {
                  let updated = prev.map((m) =>
                    m.id === id ? { ...m, folder_id: newFolderId } : m
                  );
                  if (selectedFolderId) {
                    updated = updated.filter(
                      (m) => m.folder_id === selectedFolderId
                    );
                  }
                  return updated;
                });
              }}
              onFavoriteChanged={(id, isFav) => {
                setMeetings((prev) =>
                  prev.map((m) =>
                    m.id === id ? { ...m, is_favorite: isFav } : m
                  )
                );
              }}
              calendarEvents={calendarEvents}
              theme={theme}
              isDark={isDark}
              hasLlmKey={hasLlmApiKey}
              onMeetingUpdated={(updated) => {
                setMeetings((prev) => {
                  const idx = prev.findIndex((m) => m.id === updated.id);
                  if (idx === -1) return [...prev, updated];
                  const copy = [...prev];
                  copy[idx] = { ...copy[idx], ...updated };
                  return copy;
                });
              }}
            />
          </div>

          {isCommandPaletteOpen && (
            <CommandPalette
              commands={filteredCommands}
              query={paletteQuery}
              setQuery={setPaletteQuery}
              onClose={() => {
                setCommandPaletteOpen(false);
                setPaletteQuery("");
              }}
              isDark={isDark}
              inputRef={paletteInputRef}
            />
          )}
        </div>
        {toastElement}
      </div>
    );
  }

  // LIST + ACTIONS VIEW
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 16,
        fontFamily: "system-ui",
        background: isDark ? "#020617" : "#f5f5f7",
        color: isDark ? "#e5e7eb" : "#111827",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "100%",
          margin: 0,
          display: "flex",
          flexDirection: isNarrow ? "column" : "row",
          height: "calc(100vh - 32px)",
          borderRadius: 20,
          overflow: "hidden",
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          background: isDark ? "#020617" : "#ffffff",
          boxShadow: isDark
            ? "0 18px 40px rgba(0,0,0,0.7)"
            : "0 18px 40px rgba(15,23,42,0.16)",
          position: "relative",
        }}
      >
        {/* Sidebar */}
        <div
          style={{
            width: isNarrow ? "100%" : 260,
            borderRight: isNarrow
              ? "none"
              : `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
            borderBottom: isNarrow
              ? `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`
              : "none",
            padding: 16,
            background: isDark ? "#020617" : "#ffffff",
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Folders</h3>

          {/* New folder input */}
          <div
            style={{ display: "flex", gap: 6, marginBottom: 12, marginTop: 4 }}
          >
            <input
              type="text"
              placeholder="New folder"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleCreateFolder();
                }
              }}
              style={{
                flex: 1,
                padding: 6,
                borderRadius: 8,
                border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                fontSize: 13,
                background: isDark ? "#020617" : "#ffffff",
                color: isDark ? "#e5e7eb" : "#111827",
              }}
            />
            <button
              onClick={handleCreateFolder}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "none",
                background: "#1677ff",
                color: "white",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Add
            </button>
          </div>

          {/* All meetings */}
          <button
            onClick={() => handleFolderClick(undefined)}
            style={{
              width: "100%",
              textAlign: "left",
              background: !selectedFolderId
                ? isDark
                  ? "#111827"
                  : "#e5e7eb"
                : "transparent",
              borderRadius: 999,
              padding: "6px 10px",
              border: "none",
              cursor: "pointer",
              marginBottom: 8,
              fontSize: 13,
              color: isDark ? "#e5e7eb" : "#111827",
            }}
          >
            All meetings
          </button>

          {/* Folder list */}
          {folders.map((f) => {
            const isSelected = selectedFolderId === f.id;
            const isRenaming = renamingFolderId === f.id;
            return (
              <div key={f.id} style={{ marginBottom: 6 }}>
                {isRenaming ? (
                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => handleRenameFolderKeyDown(e, f.id)}
                      style={{
                        flex: 1,
                        padding: 4,
                        borderRadius: 6,
                        border: `1px solid ${
                          isDark ? "#374151" : "#d1d5db"
                        }`,
                        fontSize: 13,
                        background: isDark ? "#020617" : "#ffffff",
                        color: isDark ? "#e5e7eb" : "#111827",
                      }}
                    />
                    <button
                      onClick={() => handleCommitRenameFolder(f.id)}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 999,
                        border: "none",
                        background: "#1677ff",
                        color: "white",
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setRenamingFolderId(null);
                        setRenameValue("");
                      }}
                      style={{
                        padding: "4px 6px",
                        borderRadius: 999,
                        border: "none",
                        background: isDark ? "#111827" : "#f3f4f6",
                        color: isDark ? "#e5e7eb" : "#111827",
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    <button
                      onClick={() => handleFolderClick(f.id)}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        background: isSelected
                          ? isDark
                            ? "#111827"
                            : "#e5e7eb"
                          : "transparent",
                        borderRadius: 999,
                        padding: "6px 10px",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 13,
                        color: isDark ? "#e5e7eb" : "#111827",
                      }}
                    >
                      {f.name}
                    </button>
                    <button
                      onClick={() => handleBeginRenameFolder(f)}
                      style={{
                        padding: "2px 6px",
                        borderRadius: 999,
                        border: "none",
                        background: isDark ? "#111827" : "#f3f4f6",
                        cursor: "pointer",
                        fontSize: 11,
                        color: isDark ? "#e5e7eb" : "#111827",
                      }}
                      title="Rename folder"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => void handleDeleteFolder(f.id)}
                      style={{
                        padding: "2px 6px",
                        borderRadius: 999,
                        border: "none",
                        background: isDark ? "#7f1d1d" : "#fee2e2",
                        color: isDark ? "#fecaca" : "#b91c1c",
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                      title="Delete folder"
                    >
                      🗑
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Main area */}
        <div
          style={{
            flex: 1,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            height: "100%",
            overflow: "hidden",
          }}
        >
          <header
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Meetings</h2>
              {selectedFolderId && (
                <p
                  style={{
                    margin: 0,
                    marginTop: 4,
                    fontSize: 12,
                    color: isDark ? "#9ca3af" : "#6b7280",
                  }}
                >
                  Showing folder:{" "}
                  {
                    folders.find((f) => f.id === selectedFolderId)?.name ??
                    "(Unknown folder)"
                  }
                </p>
              )}
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => setTheme(isDark ? "light" : "dark")}
                style={{
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: "none",
                  background: isDark ? "#111827" : "#e5e7eb",
                  color: isDark ? "#e5e7eb" : "#111827",
                  cursor: "pointer",
                  fontSize: 12,
                }}
                title="Toggle theme"
              >
                {isDark ? "☀️ Light" : "🌙 Dark"}
              </button>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search in meetings…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                style={{
                  padding: 6,
                  borderRadius: 999,
                  border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                  minWidth: 220,
                  background: isDark ? "#020617" : "#ffffff",
                  color: isDark ? "#e5e7eb" : "#111827",
                }}
              />
              <button
                onClick={handleSearch}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: "none",
                  background: "#1677ff",
                  color: "white",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {searching ? "Searching…" : "Search"}
              </button>
            {(searching ||
              filterFavoritesOnly ||
              filterHasActionItems ||
              filterFromDate ||
              filterToDate) && (
              <button
                onClick={async () => {
                  // reset all filters + search text
                  setSearchQuery("");
                  setSearching(false);
                  setFilterFavoritesOnly(false);
                  setFilterHasActionItems(false);
                  setFilterFromDate("");
                  setFilterToDate("");

                  // also reset to "All meetings" and reload, same as clicking the sidebar button
                  await handleFolderClick(undefined);
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: "none",
                  background: isDark ? "#111827" : "#e5e7eb",
                  color: isDark ? "#e5e7eb" : "#111827",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Clear all
              </button>
            )}
            </div>
          </header>

          {/* Filters */}
          <section
            style={{
              border: `1px solid ${isDark ? "#1f2937" : "#f3f4f6"}`,
              borderRadius: 999,
              padding: 8,
              display: "flex",
              alignItems: "center",
              gap: 16,
              fontSize: 12,
              background: isDark ? "#020617" : "#ffffff",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                id="filter-favorites"
                type="checkbox"
                checked={filterFavoritesOnly}
                onChange={(e) => setFilterFavoritesOnly(e.target.checked)}
              />
              <label htmlFor="filter-favorites">Favorites only</label>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                id="filter-has-actions"
                type="checkbox"
                checked={filterHasActionItems}
                onChange={(e) => setFilterHasActionItems(e.target.checked)}
              />
              <label htmlFor="filter-has-actions">Has action items</label>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>From</span>
              <input
                type="date"
                value={filterFromDate}
                onChange={(e) => setFilterFromDate(e.target.value)}
                style={{
                  padding: 4,
                  borderRadius: 6,
                  border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                  background: isDark ? "#020617" : "#ffffff",
                  color: isDark ? "#e5e7eb" : "#111827",
                }}
              />
              <span>to</span>
              <input
                type="date"
                value={filterToDate}
                onChange={(e) => setFilterToDate(e.target.value)}
                style={{
                  padding: 4,
                  borderRadius: 6,
                  border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                  background: isDark ? "#020617" : "#ffffff",
                  color: isDark ? "#e5e7eb" : "#111827",
                }}
              />
            </div>
          </section>

          {/* Ask your meetings (AI) */}
          <section
            style={{
              borderRadius: 16,
              border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
              padding: 10,
              background: isDark ? "#020617" : "#ffffff",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  color: isDark ? "#e5e7eb" : "#111827",
                  fontWeight: 500,
                }}
              >
                Ask your meetings (AI)
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: isDark ? "#9ca3af" : "#6b7280",
                }}
              >
                Example: "When did we decide to ship Feature X?"
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <input
                type="text"
                value={qaQuestion}
                onChange={(e) => setQaQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void (async () => {
                      const q = qaQuestion.trim();
                      if (!q) return;
                      try {
                        setQaError(null);
                        setQaLoading(true);
                        const res = await askMeetingsQuestion(q);
                        setQaResult(res);
                      } catch (err: any) {
                        console.error(err);
                        setQaError(
                          err?.message || "Failed to answer the question."
                        );
                      } finally {
                        setQaLoading(false);
                      }
                    })();
                  }
                }}
                placeholder="Ask a question about your meetings…"
                style={{
                  flex: 1,
                  minWidth: 220,
                  padding: 6,
                  borderRadius: 999,
                  border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                  background: isDark ? "#020617" : "#ffffff",
                  color: isDark ? "#e5e7eb" : "#111827",
                  fontSize: 13,
                }}
              />
              <button
                onClick={async () => {
                  const q = qaQuestion.trim();
                  if (!q) return;
                  try {
                    setQaError(null);
                    setQaLoading(true);
                    const res = await askMeetingsQuestion(q);
                    setQaResult(res);
                  } catch (err: any) {
                    console.error(err);
                    setQaError(
                      err?.message || "Failed to answer the question."
                    );
                  } finally {
                    setQaLoading(false);
                  }
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: "none",
                  background: "#6366f1",
                  color: "white",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {qaLoading ? "Thinking…" : "Ask"}
              </button>
            </div>
            {(qaResult || qaError) && (
              <div
                style={{
                  borderRadius: 10,
                  border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
                  padding: 8,
                  fontSize: 12,
                  maxHeight: 180,
                  overflow: "auto",
                }}
              >
                {qaError ? (
                  <p
                    style={{
                      margin: 0,
                      color: isDark ? "#fecaca" : "#b91c1c",
                    }}
                  >
                    {qaError}
                  </p>
                ) : qaResult ? (
                  <>
                    <div
                      style={{
                        marginBottom: 6,
                        color: isDark ? "#e5e7eb" : "#111827",
                      }}
                    >
                      <ReactMarkdown>{qaResult.answer}</ReactMarkdown>
                    </div>
                    {qaResult.references && qaResult.references.length > 0 && (
                      <div
                        style={{
                          borderTop: `1px solid ${
                            isDark ? "#1f2937" : "#e5e7eb"
                          }`,
                          paddingTop: 6,
                          marginTop: 4,
                          color: isDark ? "#9ca3af" : "#6b7280",
                        }}
                      >
                        <div style={{ marginBottom: 4, fontSize: 11 }}>
                          Based on:
                        </div>
                        <ul
                          style={{
                            listStyle: "none",
                            padding: 0,
                            margin: 0,
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                          }}
                        >
                          {qaResult.references.map((ref) => (
                            <li key={ref.meeting_id}>
                              <button
                                onClick={() =>
                                  setView({
                                    type: "detail",
                                    meetingId: ref.meeting_id,
                                  })
                                }
                                style={{
                                  borderRadius: 999,
                                  border: "none",
                                  padding: "2px 8px",
                                  fontSize: 11,
                                  cursor: "pointer",
                                  background: isDark
                                    ? "#111827"
                                    : "#e5e7eb",
                                  color: isDark
                                    ? "#e5e7eb"
                                    : "#111827",
                                }}
                              >
                                {ref.title}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </section>

          {/* Record area */}
          <section
            style={{
              border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
              borderRadius: 16,
              padding: 12,
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: isDark ? "#020617" : "#ffffff",
              boxShadow: isDark
                ? "0 4px 10px rgba(0,0,0,0.4)"
                : "0 4px 10px rgba(15,23,42,0.06)",
              flexWrap: "wrap",
            }}
          >
            <input
              ref={titleInputRef}
              type="text"
              placeholder="Meeting title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{
                flex: 1,
                minWidth: 180,
                padding: 8,
                borderRadius: 999,
                border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                background: isDark ? "#020617" : "#ffffff",
                color: isDark ? "#e5e7eb" : "#111827",
              }}
            />

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 160,
              }}
            >
              {!isRecording ? (
                <button
                  onClick={() => startRecordingForDate()}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 999,
                    border: "none",
                    background: "#ef4444",
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  ● Record
                </button>
              ) : (
                <>
                  <button
                    onClick={() => (isPaused ? resume() : pause())}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: "none",
                      background: isPaused ? "#10b981" : "#f97316",
                      color: "white",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {isPaused ? "▶ Resume" : "⏸ Pause"}
                  </button>
                  <button
                    onClick={stop}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: "none",
                      background: "#4b5563",
                      color: "white",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    ■ Stop
                  </button>
                </>
              )}

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 80,
                }}
              >
                <span
                  className={
                    isRecording ? (isPaused ? "recording-dot paused" : "recording-dot") : ""
                  }
                  style={{
                    display: isRecording ? "inline-block" : "none",
                  }}
                />
                <div
                  className={
                    isRecording && !isPaused
                      ? "recording-wave"
                      : isRecording
                      ? "recording-wave paused"
                      : "recording-wave hidden"
                  }
                  style={{
                    width: 40,
                    height: 10,
                    borderRadius: 999,
                    background: isDark ? "#f97316" : "#fb923c",
                    opacity: isRecording ? 1 : 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                    color: isDark ? "#e5e7eb" : "#111827",
                    minWidth: 50,
                  }}
              >
                {elapsedSeconds > 0 || isRecording
                  ? formatTime(elapsedSeconds)
                  : "0:00"}
              </span>
            </div>
          </div>

            <button
              onClick={handleUpload}
              disabled={!audioBlob || loading}
              style={{
                padding: "8px 16px",
                borderRadius: 999,
                border: "none",
                background: !audioBlob || loading ? "#9ca3af" : "#1677ff",
                color: "white",
                cursor: !audioBlob || loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Processing..." : "Save & Summarize"}
            </button>
          </section>

          {/* Google Calendar events (optional) */}
          {calendarEventsLoaded && (
            <section
              style={{
                borderRadius: 16,
                border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
                padding: 10,
                background: isDark ? "#020617" : "#ffffff",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  fontSize: 13,
                  color: isDark ? "#e5e7eb" : "#111827",
                }}
              >
                <span>Upcoming Google Calendar events</span>
                <span
                  style={{
                    fontSize: 11,
                    color: isDark ? "#9ca3af" : "#6b7280",
                  }}
                >
                  Click an event to prefill a recording.
                </span>
              </div>
              {upcomingCalendarEvents.length === 0 ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    color: isDark ? "#9ca3af" : "#6b7280",
                  }}
                >
                  No upcoming events in the next year. If you use Google Calendar, connect it above to see events here.
                </p>
              ) : (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    maxHeight: 120,
                    overflow: "auto",
                  }}
                >
                  {upcomingCalendarEvents.map((ev) => {
                    const startLabel = (() => {
                      const d = new Date(ev.start_time);
                      if (isNaN(d.getTime())) return ev.start_time;
                      return d.toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      });
                    })();
                    const isSelected = selectedCalendarEventId === ev.id;
                    return (
                      <button
                        key={ev.id}
                        onClick={() => {
                          setTitle(ev.title || "");
                          setRecordingStartTime(ev.start_time);
                          setSelectedCalendarEventId(ev.id);
                        }}
                        style={{
                          borderRadius: 12,
                          border: `1px solid ${
                            isSelected
                              ? "#2563eb"
                              : isDark
                              ? "#1f2937"
                              : "#e5e7eb"
                          }`,
                          padding: 8,
                          cursor: "pointer",
                          background: isSelected
                            ? isDark
                              ? "#020617"
                              : "#e0edff"
                            : isDark
                            ? "#020617"
                            : "#f9fafb",
                          minWidth: 180,
                          textAlign: "left",
                          fontSize: 12,
                          color: isDark ? "#e5e7eb" : "#111827",
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 500,
                            marginBottom: 2,
                          }}
                        >
                          {ev.title || "(No title)"}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: isDark ? "#9ca3af" : "#6b7280",
                          }}
                        >
                          {startLabel}
                        </div>
                        {isSelected && (
                          <div
                            style={{
                              marginTop: 4,
                              fontSize: 11,
                              color: isDark ? "#93c5fd" : "#1d4ed8",
                            }}
                          >
                            Linked to next recording
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* List / Action items section */}
          <section
            style={{
              border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
              borderRadius: 16,
              padding: 12,
              flex: 1,
              overflowY: "auto",
              background: isDark ? "#020617" : "#ffffff",
            }}
          >
            {/* Google Calendar + AI status */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
                fontSize: 11,
                color: isDark ? "#9ca3af" : "#6b7280",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span>
                  Google Calendar:{" "}
                  {userEmail ? `connected as ${userEmail}` : "not connected"}
                </span>
                <button
                  onClick={handleConnectGoogle}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    background: isDark ? "#111827" : "#e5e7eb",
                    color: isDark ? "#e5e7eb" : "#111827",
                  }}
                >
                  {userEmail ? "Reconnect Google" : "Connect Google"}
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span>
                  AI:{" "}
                  {hasLlmApiKey
                    ? "API key set (summaries enabled)"
                    : "no API key (AI features limited)"}
                </span>
                <button
                  onClick={handleSetLlmApiKey}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    background: isDark ? "#111827" : "#e5e7eb",
                    color: isDark ? "#e5e7eb" : "#111827",
                  }}
                >
                  {hasLlmApiKey ? "Change AI key" : "Set AI key"}
                </button>
                <button
                  onClick={() => setShowAiHelp((v) => !v)}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    background: "transparent",
                    color: isDark ? "#9ca3af" : "#6b7280",
                  }}
                  title="How AI is used"
                >
                  ?
                </button>
              </div>
            </div>
            {showAiHelp && (
              <div
                style={{
                  marginBottom: 8,
                  padding: 8,
                  borderRadius: 10,
                  border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
                  background: isDark ? "#020617" : "#f9fafb",
                  fontSize: 11,
                  color: isDark ? "#9ca3af" : "#4b5563",
                }}
              >
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  About AI in this app
                </div>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 18,
                  }}
                >
                  <li>
                    If you add an AI API key, summaries, action items, and Q&A
                    are generated using that key (your account, your quota).
                  </li>
                  <li>
                    Without a key, you can still record, save, organize, and
                    sync meetings to Calendar — you just won&apos;t see
                    AI-generated summaries.
                  </li>
                  <li>
                    Audio and text stay on this backend; keys are stored only in
                    your browser&apos;s local storage.
                  </li>
                </ul>
              </div>
            )}

            {/* View mode tabs */}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <button
                onClick={() => setView({ type: "list" })}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  background:
                    view.type === "list"
                      ? isDark
                        ? "#111827"
                        : "#e5e7eb"
                      : "transparent",
                  color:
                    view.type === "list"
                      ? isDark
                        ? "#e5e7eb"
                        : "#111827"
                      : isDark
                      ? "#9ca3af"
                      : "#6b7280",
                }}
              >
                Meetings
              </button>
              <button
                onClick={() => setView({ type: "actions" })}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  background:
                    view.type === "actions"
                      ? isDark
                        ? "#111827"
                        : "#e5e7eb"
                      : "transparent",
                  color:
                    view.type === "actions"
                      ? isDark
                        ? "#e5e7eb"
                        : "#111827"
                      : isDark
                      ? "#9ca3af"
                      : "#6b7280",
                }}
              >
                Action items
              </button>
              <button
                onClick={() => setView({ type: "calendar" })}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  background:
                    view.type === "calendar"
                      ? isDark
                        ? "#111827"
                        : "#e5e7eb"
                      : "transparent",
                  color:
                    view.type === "calendar"
                      ? isDark
                        ? "#e5e7eb"
                        : "#111827"
                      : isDark
                      ? "#9ca3af"
                      : "#6b7280",
                }}
              >
                Calendar
              </button>
            </div>

            {view.type === "actions" ? (
              <div className="view-transition">
                <ActionItemsView
                  meetings={meetings}
                  onOpenMeeting={(id) => setView({ type: "detail", meetingId: id })}
                  isDark={isDark}
                />
              </div>
            ) : view.type === "calendar" ? (
              <div className="view-transition">
                <CalendarView
                  meetings={meetings}
                  onOpenMeeting={(id) => setView({ type: "detail", meetingId: id })}
                  onStartRecordingForDate={(date) => {
                    if (!isRecording) {
                      startRecordingForDate(date);
                    }
                  }}
                  calendarEvents={calendarEvents}
                  isRecording={isRecording}
                  theme={theme}
                  isDark={isDark}
                />
              </div>
            ) : (
              <div className="view-transition">
                {/* Search/filter status row */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                    fontSize: 12,
                    color: isDark ? "#9ca3af" : "#6b7280",
                    flexWrap: "wrap",
                  }}
                >
                  <span>Showing {filteredMeetings.length} meeting(s)</span>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <button
                      onClick={async () => {
                        try {
                          setTopicsLoading(true);
                          const res = await fetchTopicClusters();
                          setTopicClusters(res.clusters || []);
                        } catch (e) {
                          console.error(e);
                          alert("Failed to discover topics.");
                        } finally {
                          setTopicsLoading(false);
                        }
                      }}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 999,
                        border: "none",
                        cursor: "pointer",
                        fontSize: 11,
                        background: isDark ? "#111827" : "#e5e7eb",
                        color: isDark ? "#e5e7eb" : "#111827",
                      }}
                    >
                      {topicsLoading ? "Clustering…" : "Discover topics"}
                    </button>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    {searchQuery.trim() && (
                      <button
                        onClick={() => {
                          setSearchQuery("");
                          setSearching(false);
                          void reloadMeetings(selectedFolderId);
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "none",
                          background: isDark ? "#111827" : "#e5e7eb",
                          color: isDark ? "#e5e7eb" : "#111827",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                        title="Clear search"
                      >
                        <span>Search: “{searchQuery.trim()}”</span>
                        <span aria-hidden="true">✕</span>
                      </button>
                    )}
                    {filterFavoritesOnly && (
                      <button
                        onClick={() => setFilterFavoritesOnly(false)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "none",
                          background: isDark ? "#111827" : "#e5e7eb",
                          color: isDark ? "#e5e7eb" : "#111827",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                        title="Clear favorites filter"
                      >
                        <span>Favorites only</span>
                        <span aria-hidden="true">✕</span>
                      </button>
                    )}
                    {filterHasActionItems && (
                      <button
                        onClick={() => setFilterHasActionItems(false)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "none",
                          background: isDark ? "#111827" : "#e5e7eb",
                          color: isDark ? "#e5e7eb" : "#111827",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                        title="Clear action items filter"
                      >
                        <span>Has action items</span>
                        <span aria-hidden="true">✕</span>
                      </button>
                    )}
                    {(filterFromDate || filterToDate) && (
                      <button
                        onClick={() => {
                          setFilterFromDate("");
                          setFilterToDate("");
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "none",
                          background: isDark ? "#111827" : "#e5e7eb",
                          color: isDark ? "#e5e7eb" : "#111827",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                        title="Clear date filter"
                      >
                        <span>
                          Date:{" "}
                          {filterFromDate || "Any"} –{" "}
                          {filterToDate || "Any"}
                        </span>
                        <span aria-hidden="true">✕</span>
                      </button>
                    )}
                  </div>
                </div>

                {topicClusters && topicClusters.length > 0 && (
                  <div
                    style={{
                      marginBottom: 8,
                      padding: 8,
                      borderRadius: 12,
                      border: `1px solid ${
                        isDark ? "#1f2937" : "#e5e7eb"
                      }`,
                      background: isDark ? "#020617" : "#f9fafb",
                      fontSize: 12,
                    }}
                  >
                    <div
                      style={{
                        marginBottom: 4,
                        color: isDark ? "#e5e7eb" : "#111827",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>Topic clusters</span>
                      <button
                        onClick={() => setTopicClusters(null)}
                        style={{
                          borderRadius: 999,
                          border: "none",
                          padding: "2px 8px",
                          fontSize: 10,
                          cursor: "pointer",
                          background: "transparent",
                          color: isDark ? "#9ca3af" : "#6b7280",
                        }}
                      >
                        Clear
                      </button>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      {topicClusters.map((cluster, idx) => (
                        <div
                          key={cluster.name + idx}
                          style={{
                            borderRadius: 10,
                            padding: 8,
                            border: `1px solid ${
                              isDark ? "#111827" : "#e5e7eb"
                            }`,
                            minWidth: 180,
                            maxWidth: 260,
                            background: isDark ? "#020617" : "#ffffff",
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 500,
                              marginBottom: 4,
                              color: isDark ? "#e5e7eb" : "#111827",
                            }}
                          >
                            {cluster.name}
                          </div>
                          {cluster.description && (
                            <div
                              style={{
                                fontSize: 11,
                                marginBottom: 4,
                                color: isDark ? "#9ca3af" : "#6b7280",
                              }}
                            >
                              {cluster.description}
                            </div>
                          )}
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 4,
                            }}
                          >
                            {cluster.meeting_ids.map((id) => {
                              const mtg = meetings.find((m) => m.id === id);
                              if (!mtg) return null;
                              return (
                                <button
                                  key={id}
                                  onClick={() =>
                                    setView({ type: "detail", meetingId: id })
                                  }
                                  style={{
                                    borderRadius: 999,
                                    border: "none",
                                    padding: "2px 8px",
                                    fontSize: 11,
                                    cursor: "pointer",
                                    background: isDark
                                      ? "#111827"
                                      : "#e5e7eb",
                                    color: isDark
                                      ? "#e5e7eb"
                                      : "#111827",
                                  }}
                                >
                                  {mtg.title}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {filteredMeetings.length === 0 ? (
                  <p style={{ color: isDark ? "#9ca3af" : "#6b7280" }}>
                    {searching ||
                    filterFavoritesOnly ||
                    filterHasActionItems ||
                    filterFromDate ||
                    filterToDate
                      ? "No meetings match your current search or filters. Try clearing filters or adjusting your search."
                      : "No meetings yet. Click the record button to capture your first conversation."}
                  </p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {filteredMeetings.map((m) => {
                      const actionStats = getActionItemStats(m);

                      const handleExportMarkdownFromList = () => {
                        const exportFull = window.confirm(
                          "Export full notes? Click Cancel to export transcript only."
                        );
                        const md = exportFull
                          ? buildMarkdownForMeeting(m)
                          : buildMarkdownForMeeting(m, {
                              includeSummary: false,
                              includeActionItems: false,
                            });
                        const blob = new Blob([md], {
                          type: "text/markdown;charset=utf-8",
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${slugifyForFilename(m.title)}.md`;
                        a.click();
                        URL.revokeObjectURL(url);
                      };

                      return (
                        <li
                          key={m.id}
                          style={{
                            padding: 12,
                            borderRadius: 12,
                            borderBottom: `1px solid ${
                              isDark ? "#111827" : "#f3f4f6"
                            }`,
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            setView({ type: "detail", meetingId: m.id })
                          }
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleToggleFavoriteInList(
                                    m.id,
                                    m.is_favorite
                                  );
                                }}
                                style={{
                                  width: 22,
                                  height: 22,
                                  borderRadius: "50%",
                                  border: "none",
                                  background: "transparent",
                                  cursor: "pointer",
                                  fontSize: 16,
                                  lineHeight: 1,
                                  padding: 0,
                                  color: m.is_favorite
                                    ? "#f59e0b"
                                    : isDark
                                    ? "#6b7280"
                                    : "#9ca3af",
                                }}
                                title={
                                  m.is_favorite
                                    ? "Unpin meeting"
                                    : "Pin meeting"
                                }
                              >
                                {m.is_favorite ? "★" : "☆"}
                              </button>
                              <strong>{m.title}</strong>
                              {m.is_favorite && (
                                <span
                                  style={{
                                    padding: "2px 6px",
                                    borderRadius: 999,
                                    fontSize: 10,
                                    background: isDark
                                      ? "#78350f"
                                      : "#fef3c7",
                                    color: isDark ? "#fed7aa" : "#92400e",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                  }}
                                >
                                  <span aria-hidden="true">📌</span>
                                  <span>Favorite</span>
                                </span>
                              )}
                              {actionStats.total > 0 && actionStats.allDone && (
                                <span
                                  style={{
                                    padding: "2px 6px",
                                    borderRadius: 999,
                                    fontSize: 10,
                                    background: isDark
                                      ? "#064e3b"
                                      : "#dcfce7",
                                    color: isDark ? "#bbf7d0" : "#166534",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                  }}
                                >
                                  <span aria-hidden="true">✅</span>
                                  <span>All actions done</span>
                                </span>
                              )}
                              {actionStats.overdue > 0 && (
                                <span
                                  style={{
                                    padding: "2px 6px",
                                    borderRadius: 999,
                                    fontSize: 10,
                                    background: isDark
                                      ? "#7f1d1d"
                                      : "#fee2e2",
                                    color: isDark ? "#fecaca" : "#b91c1c",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                  }}
                                >
                                  <span aria-hidden="true">⚠️</span>
                                  <span>
                                    {actionStats.overdue} overdue
                                    {actionStats.overdue > 1 ? " items" : " item"}
                                  </span>
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 12,
                                  color: isDark ? "#9ca3af" : "#9ca3af",
                                }}
                              >
                                {new Date(
                                  m.created_at
                                ).toLocaleString()}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleExportMarkdownFromList();
                                }}
                                style={{
                                  padding: "4px 8px",
                                  borderRadius: 999,
                                  border: "none",
                                  background: isDark
                                    ? "#111827"
                                    : "#e5e7eb",
                                  color: isDark ? "#e5e7eb" : "#111827",
                                  cursor: "pointer",
                                  fontSize: 11,
                                }}
                                title="Export Markdown for this meeting"
                              >
                                ⤓ MD
                              </button>
                            </div>
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              marginTop: 4,
                              color: isDark ? "#9ca3af" : "#6b7280",
                            }}
                          >
                            Status: {m.status}
                            {actionStats.total > 0 && (
                              <span
                                style={{
                                  marginLeft: 8,
                                  color: isDark ? "#22c55e" : "#16a34a",
                                }}
                              >
                                • {actionStats.total} action item
                                {actionStats.total > 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                          {m.summary && (
                            <div
                              style={{
                                fontSize: 13,
                                marginTop: 4,
                                color: isDark ? "#e5e7eb" : "#111827",
                              }}
                            >
                              {getSummaryPreview(m.summary)}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
      {isCommandPaletteOpen && (
        <CommandPalette
          commands={filteredCommands}
          query={paletteQuery}
          setQuery={setPaletteQuery}
          onClose={() => {
            setCommandPaletteOpen(false);
            setPaletteQuery("");
          }}
          isDark={isDark}
          inputRef={paletteInputRef}
        />
      )}
      {toastElement}
    </div>
  );
}

// --------- MeetingDetail component ---------

interface MeetingDetailProps {
  meetingId: string;
  onBack: () => void;
  onDeleted: (id: string) => void;
  folders: Folder[];
  onFolderChanged: (meetingId: string, folderId: string | null) => void;
  onFavoriteChanged: (meetingId: string, isFavorite: boolean) => void;
  calendarEvents: CalendarEvent[];
  theme: "light" | "dark";
  isDark: boolean;
  onMeetingUpdated?: (meeting: Meeting) => void;
  hasLlmKey: boolean;
}

function MeetingDetail({
  meetingId,
  onBack,
  onDeleted,
  folders,
  onFolderChanged,
  onFavoriteChanged,
  calendarEvents,
  theme,
  isDark,
  onMeetingUpdated,
  hasLlmKey,
}: MeetingDetailProps) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingMeta, setSavingMeta] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [extractingActions, setExtractingActions] = useState(false);
  const [savingActions, setSavingActions] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Editable title state
  const [localTitle, setLocalTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);

  // Editable action items
  const [localActions, setLocalActions] = useState<ActionItem[]>([]);
  const [calendarStartLocal, setCalendarStartLocal] = useState("");
  const [calendarEndLocal, setCalendarEndLocal] = useState("");
  const [linkingCalendar, setLinkingCalendar] = useState(false);
  const [linkingError, setLinkingError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | "new">("new");

  // Load meeting details

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const m = await fetchMeeting(meetingId);
        setMeeting(m);
        setLocalTitle(m.title);
        setLocalActions(parseActionItemsFromMeeting(m));

        const toLocalInput = (iso?: string | null) => {
          if (!iso) return "";
          const d = new Date(iso);
          if (isNaN(d.getTime())) return "";
          const pad = (n: number) => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
            d.getDate()
          )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };

        const defaultStart = m.start_time || m.created_at;
        const defaultEnd = m.end_time || m.start_time || m.created_at;
        setCalendarStartLocal(toLocalInput(defaultStart));
        setCalendarEndLocal(toLocalInput(defaultEnd));
        setSelectedEventId(m.calendar_event_id || "new");

        if (onMeetingUpdated) onMeetingUpdated(m);
      } catch (e) {
        console.error(e);
        alert("Failed to load meeting.");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [meetingId]);







  const parsedActionItems = localActions;
  const [smartMode, setSmartMode] = useState<SmartSummaryMode | null>(null);
  const [smartSummary, setSmartSummary] = useState<string | null>(null);
  const [smartPersona, setSmartPersona] = useState("");
  const [smartLoading, setSmartLoading] = useState(false);
  const [smartError, setSmartError] = useState<string | null>(null);

  const handleSyncCalendar = async () => {
    if (!meeting) return;
    setLinkingCalendar(true);
    setLinkingError(null);

    const toIso = (value: string): string | null => {
      if (!value) return null;
      const d = new Date(value);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    };

    const startIso = toIso(calendarStartLocal);
    const endIso = toIso(calendarEndLocal);

    try {
      const updated = await syncMeetingCalendar(meeting.id, {
        start_time: startIso ?? undefined,
        end_time: endIso ?? undefined,
        event_id: selectedEventId === "new" ? undefined : selectedEventId,
      });
      setMeeting(updated);
      if (onMeetingUpdated) onMeetingUpdated(updated);
    } catch (e: any) {
      console.error(e);
      setLinkingError(
        e?.message || "Failed to sync meeting with Google Calendar."
      );
    } finally {
      setLinkingCalendar(false);
    }
  };

  const handleExtractActions = async () => {
    if (!meeting) return;

    if (!meeting.transcript) {
      alert("No transcript available yet to extract action items from.");
      return;
    }

    setExtractingActions(true);
    try {
      const updated = await extractActionItems(meeting.id);
      setMeeting(updated);
      const items = parseActionItemsFromMeeting(updated);
      setLocalActions(items);
      if (onMeetingUpdated) onMeetingUpdated(updated);
    } catch (e) {
      console.error(e);
      alert("Failed to extract action items.");
    } finally {
      setExtractingActions(false);
    }
  };

  const handleSaveActions = async () => {
    if (!meeting) return;
    setSavingActions(true);
    try {
      const updated = await updateMeetingActionItems(meeting.id, localActions);
      setMeeting(updated);
      setLocalActions(parseActionItemsFromMeeting(updated));
      if (onMeetingUpdated) onMeetingUpdated(updated);
    } catch (e) {
      console.error(e);
      alert("Failed to save action items.");
    } finally {
      setSavingActions(false);
    }
  };

  const updateLocalAction = (
    index: number,
    patch: Partial<ActionItem>
  ) => {
    setLocalActions((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], ...patch };
      return copy;
    });
  };

  const handleDelete = async () => {
    if (!meeting) return;
    const ok = window.confirm(
      "Delete this meeting and its transcript/summary? This cannot be undone."
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await apiDeleteMeeting(meeting.id);
      onDeleted(meeting.id);
    } catch (e) {
      console.error(e);
      alert("Failed to delete meeting.");
      setDeleting(false);
    }
  };

  const toggleFavorite = async () => {
    if (!meeting) return;
    const current = (meeting as any).is_favorite as boolean | undefined;
    try {
      const updated = await updateMeetingFavorite(meeting.id, !current);
      const newMeeting = {
        ...meeting,
        is_favorite: updated.is_favorite,
      } as Meeting;
      setMeeting(newMeeting);
      onFavoriteChanged(meeting.id, !!updated.is_favorite);
      if (onMeetingUpdated) onMeetingUpdated(newMeeting);
    } catch (e) {
      console.error(e);
      alert("Failed to update favorite.");
    }
  };

  const handleFolderChange = async (e: ChangeEvent<HTMLSelectElement>) => {
    if (!meeting) return;
    const newFolderId = e.target.value || null;
    setSavingMeta(true);
    try {
      await updateMeetingFolder(meeting.id, newFolderId);
      const updated = { ...meeting, folder_id: newFolderId } as Meeting;
      setMeeting(updated);
      onFolderChanged(meeting.id, newFolderId);
      if (onMeetingUpdated) onMeetingUpdated(updated);
    } catch (e) {
      console.error(e);
      alert("Failed to move meeting.");
    } finally {
      setSavingMeta(false);
    }
  };

  const handleSaveTitle = async () => {
    if (!meeting) return;
    const newTitle = localTitle.trim();
    if (!newTitle) {
      alert("Title cannot be empty.");
      return;
    }
    if (newTitle === meeting.title) {
      setEditingTitle(false);
      return;
    }
    setSavingMeta(true);
    try {
      const updated = await updateMeetingMetadata(meeting.id, {
        title: newTitle,
      });
      const merged = { ...meeting, title: updated.title } as Meeting;
      setMeeting(merged);
      setEditingTitle(false);
      if (onMeetingUpdated) onMeetingUpdated(merged);
    } catch (e) {
      console.error(e);
      alert("Failed to update title.");
    } finally {
      setSavingMeta(false);
    }
  };

  const copyToClipboard = async (kind: "summary" | "transcript") => {
    if (!meeting) return;
    const text =
      kind === "summary"
        ? meeting.summary || ""
        : meeting.transcript || "";
    if (!text.trim()) {
      alert(`No ${kind} to copy.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch (e) {
      console.error(e);
      alert("Failed to copy to clipboard.");
    }
  };

  const copyAllToClipboard = async () => {
    if (!meeting) return;
    const markdown = buildMarkdownForMeeting(meeting);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied("all");
      setTimeout(() => setCopied(null), 1500);
    } catch (e) {
      console.error(e);
      alert("Failed to copy all content.");
    }
  };

  const downloadMarkdown = () => {
    if (!meeting) return;
    const md = buildMarkdownForMeeting(meeting);
    const blob = new Blob([md], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugifyForFilename(meeting.title)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runSmartSummary = async (mode: SmartSummaryMode) => {
    if (!meeting) return;
    if (mode === "persona" && !smartPersona.trim()) {
      alert("Please enter a name for the per-person recap.");
      return;
    }
    setSmartMode(mode);
    setSmartLoading(true);
    setSmartError(null);
    try {
      const res = await smartSummarizeMeeting(
        meeting.id,
        mode,
        mode === "persona" ? smartPersona.trim() : undefined
      );
      setSmartSummary(res.summary);
    } catch (e: any) {
      console.error(e);
      setSmartError(
        e?.message || "Failed to generate this summary view. Please try again."
      );
    } finally {
      setSmartLoading(false);
    }
  };

  const exportPdfViaPrint = () => {
    if (!meeting) return;

    const items = parseActionItemsFromMeeting(meeting);

    const actionsHtml =
      items.length > 0
        ? `<div class="section"><h2>Action Items</h2><ul>${items
            .map((item) => {
              const bits = [item.task];
              if (item.owner) bits.push("(Owner: " + item.owner + ")");
              if (item.due_date) bits.push("(Due: " + item.due_date + ")");
              return "<li>" + bits.join(" ") + "</li>";
            })
            .join("")}</ul></div>`
        : "";

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${meeting.title}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 24px;
      color: #111827;
    }
    h1, h2, h3 {
      color: #111827;
    }
    h1 {
      margin-bottom: 4px;
    }
    .meta {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 16px;
    }
    .section {
      margin-bottom: 20px;
    }
    .section h2 {
      font-size: 16px;
      margin-bottom: 6px;
    }
    pre {
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.5;
    }
    ul {
      font-size: 13px;
    }
  </style>
</head>
<body>
  <h1>${meeting.title}</h1>
  <div class="meta">Created: ${new Date(
    meeting.created_at
  ).toLocaleString()}</div>

  ${
    meeting.summary
      ? `<div class="section"><h2>Summary</h2><pre>${meeting.summary
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</pre></div>`
      : ""
  }

  ${actionsHtml}

  ${
    meeting.transcript
      ? `<div class="section"><h2>Transcript</h2><pre>${meeting.transcript
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</pre></div>`
      : ""
  }
</body>
</html>`;

    const w = window.open("", "_blank");
    if (!w) {
      alert("Popup blocked. Please allow popups to export PDF.");
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => {
      w.print();
    }, 300);
  };

  // Detail-level keyboard shortcuts:
  // Shift+D -> delete
  // F -> favorite
  // S -> copy summary
  // T -> copy transcript
  useEffect(() => {
    if (!meeting) return;

    function handleKey(e: KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.getAttribute("contenteditable") === "true")
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      // Let Cmd+K be handled by the App-level palette
      if (e.metaKey && key === "k") return;

      // Shift + D => delete
      if (e.shiftKey && key === "d") {
        e.preventDefault();
        void handleDelete();
        return;
      }

      // F => favorite toggle
      if (!e.shiftKey && key === "f") {
        e.preventDefault();
        void toggleFavorite();
        return;
      }

      // S => copy summary
      if (!e.shiftKey && key === "s") {
        e.preventDefault();
        void copyToClipboard("summary");
        return;
      }

      // T => copy transcript
      if (!e.shiftKey && key === "t") {
        e.preventDefault();
        void copyToClipboard("transcript");
        return;
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [meeting]);

  if (loading || !meeting) {
    return (
      <div style={{ padding: 16 }}>
        <button
          onClick={onBack}
          style={{
            marginBottom: 12,
            borderRadius: 999,
            padding: "6px 12px",
            border: "none",
            background: isDark ? "#111827" : "#e5e7eb",
            color: isDark ? "#e5e7eb" : "#111827",
            cursor: "pointer",
          }}
        >
          ← Back
        </button>
        <p>Loading meeting…</p>
      </div>
    );
  }

  const createdLabel = new Date(meeting.created_at).toLocaleString();
  const isFavorite = !!(meeting as any).is_favorite;

  const audioUrl = meeting.audio_path
    ? meeting.audio_path.startsWith("http")
      ? meeting.audio_path
      : `${API_BASE}/${meeting.audio_path}`
    : null;

  const openItems = parsedActionItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.status || item.status === "open");
  const doneItems = parsedActionItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === "done");
  const detailStats = getActionItemStats(meeting);

  return (
    <div
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: "100%",
        boxSizing: "border-box",
        overflowY: "auto",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={onBack}
            style={{
              borderRadius: 999,
              padding: "6px 12px",
              border: "none",
              background: isDark ? "#111827" : "#e5e7eb",
              color: isDark ? "#e5e7eb" : "#111827",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            ← Back
          </button>
          {/* Editable title */}
          {editingTitle ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                value={localTitle}
                onChange={(e) => setLocalTitle(e.target.value)}
                style={{
                  padding: 6,
                  borderRadius: 8,
                  border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                  background: isDark ? "#020617" : "#ffffff",
                  color: isDark ? "#e5e7eb" : "#111827",
                  fontSize: 16,
                  minWidth: 220,
                }}
              />
              <button
                onClick={() => void handleSaveTitle()}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "none",
                  background: "#1677ff",
                  color: "white",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Save
              </button>
              <button
                onClick={() => {
                  setLocalTitle(meeting.title);
                  setEditingTitle(false);
                }}
                style={{
                  padding: "4px 8px",
                  borderRadius: 999,
                  border: "none",
                  background: isDark ? "#111827" : "#e5e7eb",
                  color: isDark ? "#e5e7eb" : "#111827",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>{meeting.title}</h2>
              <button
                onClick={() => setEditingTitle(true)}
                style={{
                  padding: "4px 8px",
                  borderRadius: 999,
                  border: "none",
                  background: isDark ? "#111827" : "#e5e7eb",
                  color: isDark ? "#e5e7eb" : "#111827",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                Edit title
              </button>
              {isFavorite && (
                <span
                  style={{
                    padding: "2px 6px",
                    borderRadius: 999,
                    fontSize: 11,
                    background: isDark ? "#78350f" : "#fef3c7",
                    color: isDark ? "#fed7aa" : "#92400e",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span aria-hidden="true">📌</span>
                  <span>Favorite</span>
                </span>
              )}
              {detailStats.total > 0 && detailStats.allDone && (
                <span
                  style={{
                    padding: "2px 6px",
                    borderRadius: 999,
                    fontSize: 11,
                    background: isDark ? "#064e3b" : "#dcfce7",
                    color: isDark ? "#bbf7d0" : "#166534",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span aria-hidden="true">✅</span>
                  <span>All actions done</span>
                </span>
              )}
              {detailStats.overdue > 0 && (
                <span
                  style={{
                    padding: "2px 6px",
                    borderRadius: 999,
                    fontSize: 11,
                    background: isDark ? "#7f1d1d" : "#fee2e2",
                    color: isDark ? "#fecaca" : "#b91c1c",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span aria-hidden="true">⚠️</span>
                  <span>
                    {detailStats.overdue} overdue
                    {detailStats.overdue > 1 ? " items" : " item"}
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={toggleFavorite}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              background: isFavorite
                ? "#f59e0b"
                : theme === "dark"
                ? "#111827"
                : "#e5e7eb",
              color: isFavorite
                ? "#111827"
                : theme === "dark"
                ? "#e5e7eb"
                : "#111827",
              fontSize: 12,
            }}
            title="Toggle favorite (F)"
          >
            {isFavorite ? "★ Favorited" : "☆ Favorite"}
          </button>
          <button
            onClick={() => void copyToClipboard("summary")}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "none",
              background: isDark ? "#111827" : "#e5e7eb",
              color: isDark ? "#e5e7eb" : "#111827",
              cursor: "pointer",
              fontSize: 12,
            }}
            title="Copy summary (S)"
          >
            {copied === "summary" ? "Copied!" : "Copy summary"}
          </button>
          <button
            onClick={() => void copyToClipboard("transcript")}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "none",
              background: isDark ? "#111827" : "#e5e7eb",
              color: isDark ? "#e5e7eb" : "#111827",
              cursor: "pointer",
              fontSize: 12,
            }}
            title="Copy transcript (T)"
          >
            {copied === "transcript" ? "Copied!" : "Copy transcript"}
          </button>
          <button
            onClick={() => void copyAllToClipboard()}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "none",
              background: isDark ? "#0f766e" : "#14b8a6",
              color: "#f9fafb",
              cursor: "pointer",
              fontSize: 12,
            }}
            title="Copy everything (summary, transcript, action items)"
          >
            {copied === "all" ? "Copied all!" : "Copy all"}
          </button>
          <button
            onClick={downloadMarkdown}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "none",
              background: "#1677ff",
              color: "white",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Export Markdown
          </button>
          <button
            onClick={exportPdfViaPrint}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "none",
              background: isDark ? "#7c3aed" : "#8b5cf6",
              color: "white",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Export PDF
          </button>
          <button
            onClick={() => void handleDelete()}
            disabled={deleting}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "none",
              background: deleting ? "#7f1d1d" : "#b91c1c",
              color: "white",
              cursor: deleting ? "not-allowed" : "pointer",
              fontSize: 12,
            }}
            title="Delete meeting (Shift+D)"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </header>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          flexWrap: "wrap",
          fontSize: 12,
          color: isDark ? "#9ca3af" : "#6b7280",
        }}
      >
        <div>Created: {createdLabel}</div>
        <div>
          Shortcuts:{" "}
          <span>
            F = favorite • S = copy summary • T = copy transcript • Shift+D =
            delete
          </span>
        </div>
      </div>

      {/* Folder selector */}
      <section
        style={{
          borderRadius: 12,
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          padding: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          background: isDark ? "#020617" : "#ffffff",
        }}
      >
        <span>Folder:</span>
        <select
          value={meeting.folder_id ?? ""}
          onChange={handleFolderChange}
          disabled={savingMeta}
          style={{
            padding: 4,
            borderRadius: 8,
            border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
            background: isDark ? "#020617" : "#ffffff",
            color: isDark ? "#e5e7eb" : "#111827",
          }}
        >
          <option value="">All meetings</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {savingMeta && (
          <span
            style={{
              fontSize: 12,
              color: isDark ? "#9ca3af" : "#6b7280",
            }}
          >
            Updating…
          </span>
        )}
      </section>

      {/* Audio */}
      {audioUrl && (
        <section
          style={{
            borderRadius: 12,
            border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
            padding: 10,
            background: isDark ? "#020617" : "#ffffff",
          }}
        >
          <div
            style={{
              marginBottom: 6,
              fontSize: 13,
              color: isDark ? "#e5e7eb" : "#111827",
            }}
          >
            Recording
          </div>
          <audio
            ref={audioRef}
            controls
            src={audioUrl}
            style={{ width: "100%" }}
          />
        </section>
      )}

      {/* AI Summary */}
      <section
        style={{
          borderRadius: 12,
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          padding: 10,
          background: isDark ? "#020617" : "#ffffff",
        }}
      >
        <h3 style={{ marginTop: 0 }}>AI Summary</h3>
        {meeting.summary ? (
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            <ReactMarkdown
              components={{
                ul: (props) => (
                  <ul
                    style={{
                      paddingLeft: 20,
                      marginTop: 4,
                      marginBottom: 4,
                    }}
                    {...props}
                  />
                ),
                li: (props) => (
                  <li
                    style={{
                      marginBottom: 4,
                    }}
                    {...props}
                  />
                ),
              }}
            >
              {meeting.summary}
            </ReactMarkdown>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: isDark ? "#9ca3af" : "#6b7280" }}>
            No AI-generated summary yet.{" "}
            {hasLlmKey
              ? "Record a longer meeting or try regenerating below."
              : "Set an AI API key above to enable automatic summaries, or keep using the app without them."}
          </p>
        )}
      </section>
      {/* Smart summaries */}
      <section
        style={{
          borderRadius: 12,
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          padding: 10,
          background: isDark ? "#020617" : "#ffffff",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Alternate views (AI)</h3>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <button
            onClick={() => void runSmartSummary("executive")}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              background:
                smartMode === "executive"
                  ? isDark
                    ? "#111827"
                    : "#e0edff"
                  : isDark
                  ? "#020617"
                  : "#f3f4f6",
              color:
                smartMode === "executive"
                  ? isDark
                    ? "#e5e7eb"
                    : "#1d4ed8"
                  : isDark
                  ? "#e5e7eb"
                  : "#111827",
            }}
          >
            Executive summary
          </button>
          <button
            onClick={() => void runSmartSummary("detailed")}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              background:
                smartMode === "detailed"
                  ? isDark
                    ? "#111827"
                    : "#e0edff"
                  : isDark
                  ? "#020617"
                  : "#f3f4f6",
              color:
                smartMode === "detailed"
                  ? isDark
                    ? "#e5e7eb"
                    : "#1d4ed8"
                  : isDark
                  ? "#e5e7eb"
                  : "#111827",
            }}
          >
            Detailed notes
          </button>
          <button
            onClick={() => void runSmartSummary("decisions")}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              background:
                smartMode === "decisions"
                  ? isDark
                    ? "#111827"
                    : "#e0edff"
                  : isDark
                  ? "#020617"
                  : "#f3f4f6",
              color:
                smartMode === "decisions"
                  ? isDark
                    ? "#e5e7eb"
                    : "#1d4ed8"
                  : isDark
                  ? "#e5e7eb"
                  : "#111827",
            }}
          >
            Decisions vs discussion
          </button>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexWrap: "wrap",
            }}
          >
            <input
              type="text"
              value={smartPersona}
              onChange={(e) => setSmartPersona(e.target.value)}
              placeholder="Per-person recap (e.g., Alex)"
              style={{
                padding: 4,
                borderRadius: 999,
                border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                background: isDark ? "#020617" : "#ffffff",
                color: isDark ? "#e5e7eb" : "#111827",
                fontSize: 11,
                minWidth: 160,
              }}
            />
            <button
              onClick={() => void runSmartSummary("persona")}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                background:
                  smartMode === "persona"
                    ? isDark
                      ? "#111827"
                      : "#e0edff"
                    : isDark
                    ? "#020617"
                    : "#f3f4f6",
                color:
                  smartMode === "persona"
                    ? isDark
                      ? "#e5e7eb"
                      : "#1d4ed8"
                    : isDark
                    ? "#e5e7eb"
                    : "#111827",
              }}
            >
              Recap for person
            </button>
          </div>
        </div>
        <div
          style={{
            borderRadius: 10,
            border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
            padding: 8,
            minHeight: 40,
            fontSize: 13,
            color: isDark ? "#e5e7eb" : "#111827",
          }}
        >
          {smartLoading ? (
            <span>Generating {smartMode || ""} summary…</span>
          ) : smartError ? (
            <span
              style={{
                color: isDark ? "#fecaca" : "#b91c1c",
              }}
            >
              {smartError}
            </span>
          ) : smartSummary ? (
            <ReactMarkdown>{smartSummary}</ReactMarkdown>
          ) : (
            <span
              style={{
                fontSize: 12,
                color: isDark ? "#9ca3af" : "#6b7280",
              }}
            >
              Choose a view above to generate another style of summary.
            </span>
          )}
        </div>
      </section>

      {/* Google Calendar link */}
      <section
        style={{
          borderRadius: 12,
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          padding: 10,
          background: isDark ? "#020617" : "#ffffff",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Google Calendar</h3>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            marginBottom: 8,
            fontSize: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <label style={{ fontSize: 11 }}>Start time</label>
            <input
              type="datetime-local"
              value={calendarStartLocal}
              onChange={(e) => setCalendarStartLocal(e.target.value)}
              style={{
                padding: 4,
                borderRadius: 8,
                border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                background: isDark ? "#020617" : "#ffffff",
                color: isDark ? "#e5e7eb" : "#111827",
                fontSize: 12,
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <label style={{ fontSize: 11 }}>End time</label>
            <input
              type="datetime-local"
              value={calendarEndLocal}
              onChange={(e) => setCalendarEndLocal(e.target.value)}
              style={{
                padding: 4,
                borderRadius: 8,
                border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                background: isDark ? "#020617" : "#ffffff",
                color: isDark ? "#e5e7eb" : "#111827",
                fontSize: 12,
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              minWidth: 220,
            }}
          >
            <label style={{ fontSize: 11 }}>Existing event (optional)</label>
            <select
              value={selectedEventId}
              onChange={(e) =>
                setSelectedEventId(
                  e.target.value === "new" ? "new" : e.target.value
                )
              }
              style={{
                padding: 4,
                borderRadius: 8,
                border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
                background: isDark ? "#020617" : "#ffffff",
                color: isDark ? "#e5e7eb" : "#111827",
                fontSize: 12,
              }}
            >
              <option value="new">Create new event</option>
              {calendarEvents.map((ev) => {
                const d = new Date(ev.start_time);
                const label = isNaN(d.getTime())
                  ? ev.title
                  : `${ev.title} — ${d.toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}`;
                return (
                  <option key={ev.id} value={ev.id}>
                    {label}
                  </option>
                );
              })}
            </select>
          </div>
          <button
            onClick={() => void handleSyncCalendar()}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              background: "#22c55e",
              color: "white",
            }}
          >
            {linkingCalendar
              ? "Syncing with Google Calendar…"
              : selectedEventId === "new"
              ? "Create calendar event"
              : "Append to selected event"}
          </button>
        </div>
        {linkingError && (
          <p
            style={{
              fontSize: 12,
              color: isDark ? "#fecaca" : "#b91c1c",
              marginTop: 4,
            }}
          >
            {linkingError}
          </p>
        )}
        {meeting.calendar_event_id && !linkingError && (
          <p
            style={{
              fontSize: 11,
              color: isDark ? "#9ca3af" : "#6b7280",
              marginTop: 4,
            }}
          >
            Linked to Google Calendar event ID: {meeting.calendar_event_id}
          </p>
        )}
      </section>
            {/* Action items (editable) */}
      <section
        style={{
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          borderRadius: 16,
          padding: 16,
          background: isDark ? "#020617" : "#ffffff",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>Action items</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleExtractActions}
              disabled={!meeting || !meeting.transcript || extractingActions}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: "none",
                fontSize: 12,
                cursor:
                  !meeting || !meeting.transcript || extractingActions
                    ? "default"
                    : "pointer",
                background: isDark ? "#111827" : "#e5e7eb",
                color: isDark ? "#e5e7eb" : "#111827",
                opacity: !meeting || !meeting.transcript ? 0.5 : 1,
              }}
            >
              {extractingActions
                ? "Extracting..."
                : parsedActionItems.length === 0
                ? "Extract"
                : "Re-extract"}
            </button>
            <button
              onClick={handleSaveActions}
              disabled={savingActions}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: "none",
                fontSize: 12,
                cursor: savingActions ? "default" : "pointer",
                background: "#1677ff",
                color: "white",
              }}
            >
              {savingActions ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>

        {parsedActionItems.length === 0 ? (
          <p style={{ fontSize: 13, color: isDark ? "#9ca3af" : "#6b7280" }}>
            No action items extracted yet. Click “Extract” to generate tasks from
            the transcript, then edit and save them here.
          </p>
        ) : (
          <>
            {openItems.length > 0 && (
              <>
                <h4
                  style={{
                    margin: "4px 0",
                    fontSize: 13,
                    color: isDark ? "#e5e7eb" : "#111827",
                  }}
                >
                  Open
                </h4>
                <ul
                  style={{
                    fontSize: 13,
                    paddingLeft: 18,
                    margin: 0,
                  }}
                >
                  {openItems.map(({ item, index }) => (
                    <li key={`open-${index}`} style={{ marginBottom: 8 }}>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        <input
                          value={item.task}
                          onChange={(e) =>
                            updateLocalAction(index, { task: e.target.value })
                          }
                          style={{
                            flex: 1,
                            minWidth: 160,
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        />
                        <input
                          placeholder="Owner"
                          value={item.owner ?? ""}
                          onChange={(e) =>
                            updateLocalAction(index, { owner: e.target.value })
                          }
                          style={{
                            width: 120,
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        />
                        <input
                          type="date"
                          value={item.due_date ?? ""}
                          onChange={(e) =>
                            updateLocalAction(index, {
                              due_date: e.target.value || null,
                            })
                          }
                          style={{
                            width: 140,
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        />
                        <select
                          value={item.status || "open"}
                          onChange={(e) =>
                            updateLocalAction(index, {
                              status: e.target.value,
                            })
                          }
                          style={{
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        >
                          <option value="open">Open</option>
                          <option value="done">Done</option>
                        </select>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {doneItems.length > 0 && (
              <>
                <h4
                  style={{
                    margin: "8px 0 4px",
                    fontSize: 13,
                    color: isDark ? "#9ca3af" : "#6b7280",
                  }}
                >
                  Done
                </h4>
                <ul
                  style={{
                    fontSize: 13,
                    paddingLeft: 18,
                    margin: 0,
                  }}
                >
                  {doneItems.map(({ item, index }) => (
                    <li key={`done-${index}`} style={{ marginBottom: 8 }}>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        <input
                          value={item.task}
                          onChange={(e) =>
                            updateLocalAction(index, { task: e.target.value })
                          }
                          style={{
                            flex: 1,
                            minWidth: 160,
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        />
                        <input
                          placeholder="Owner"
                          value={item.owner ?? ""}
                          onChange={(e) =>
                            updateLocalAction(index, { owner: e.target.value })
                          }
                          style={{
                            width: 120,
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        />
                        <input
                          type="date"
                          value={item.due_date ?? ""}
                          onChange={(e) =>
                            updateLocalAction(index, {
                              due_date: e.target.value || null,
                            })
                          }
                          style={{
                            width: 140,
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        />
                        <select
                          value={item.status || "done"}
                          onChange={(e) =>
                            updateLocalAction(index, {
                              status: e.target.value,
                            })
                          }
                          style={{
                            padding: 4,
                            borderRadius: 6,
                            border: `1px solid ${
                              isDark ? "#374151" : "#d1d5db"
                            }`,
                            background: isDark ? "#020617" : "#ffffff",
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        >
                          <option value="open">Open</option>
                          <option value="done">Done</option>
                        </select>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      {/* Transcript */}
      <section
        style={{
          borderRadius: 12,
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          padding: 10,
          background: isDark ? "#020617" : "#ffffff",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Transcript</h3>
        {meeting.transcript ? (
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {meeting.transcript}
          </p>
        ) : (
          <p style={{ fontSize: 13, color: isDark ? "#9ca3af" : "#6b7280" }}>
            No transcript available.
          </p>
        )}
      </section>
    </div>
  );
}

// --------- CalendarView component ---------

interface CalendarViewProps {
  meetings: Meeting[];
  onOpenMeeting: (meetingId: string) => void;
  onStartRecordingForDate: (date: Date) => void;
  isRecording: boolean;
  calendarEvents: CalendarEvent[];
  theme: "light" | "dark";
  isDark: boolean;
}

function CalendarView({
  meetings,
  onOpenMeeting,
  onStartRecordingForDate,
  isRecording,
  calendarEvents,
  theme,
  isDark,
}: CalendarViewProps) {
  const [mode, setMode] = useState<"month" | "week">("month");
  const [focusDate, setFocusDate] = useState<Date>(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  });
  const [selectedDate, setSelectedDate] = useState<Date | null>(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  });

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const openCalendarEvent = (ev: CalendarEvent) => {
    if (typeof window === "undefined") return;
    const url =
      ev.html_link ||
      `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(
        ev.id
      )}`;
    window.open(url, "_blank");
  };

  const [expandedAgendaKey, setExpandedAgendaKey] = useState<string | null>(
    null
  );

  const meetingsByDay = useMemo(() => {
    const map = new Map<string, Meeting[]>();
    for (const m of meetings) {
      const d = getMeetingStartDate(m);
      if (!d) continue;
      const key = getDayKey(d);
      const existing = map.get(key);
      if (existing) {
        existing.push(m);
      } else {
        map.set(key, [m]);
      }
    }
    return map;
  }, [meetings]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of calendarEvents) {
      const d = new Date(ev.start_time);
      if (isNaN(d.getTime())) continue;
      const key = getDayKey(d);
      const existing = map.get(key);
      if (existing) {
        existing.push(ev);
      } else {
        map.set(key, [ev]);
      }
    }
    return map;
  }, [calendarEvents]);

  const visibleDays = useMemo(() => {
    const days: Date[] = [];
    if (mode === "month") {
      const firstOfMonth = new Date(focusDate);
      firstOfMonth.setDate(1);
      const startDay = firstOfMonth.getDay(); // 0 (Sun) - 6 (Sat)
      const startDate = new Date(firstOfMonth);
      startDate.setDate(firstOfMonth.getDate() - startDay);
      for (let i = 0; i < 42; i++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + i);
        d.setHours(0, 0, 0, 0);
        days.push(d);
      }
    } else {
      const startOfWeek = new Date(focusDate);
      const day = startOfWeek.getDay();
      startOfWeek.setDate(startOfWeek.getDate() - day);
      startOfWeek.setHours(0, 0, 0, 0);
      for (let i = 0; i < 7; i++) {
        const d = new Date(startOfWeek);
        d.setDate(startOfWeek.getDate() + i);
        d.setHours(0, 0, 0, 0);
        days.push(d);
      }
    }
    return days;
  }, [focusDate, mode]);

  const selectedKey = selectedDate ? getDayKey(selectedDate) : null;
  const selectedMeetings =
    selectedKey && meetingsByDay.get(selectedKey)
      ? [...(meetingsByDay.get(selectedKey) as Meeting[])].sort((a, b) => {
          const ad = getMeetingStartDate(a);
          const bd = getMeetingStartDate(b);
          if (!ad || !bd) return 0;
          return ad.getTime() - bd.getTime();
        })
      : [];

  const selectedEvents =
    selectedKey && eventsByDay.get(selectedKey)
      ? [...(eventsByDay.get(selectedKey) as CalendarEvent[])].sort(
          (a, b) => {
            const ad = new Date(a.start_time).getTime();
            const bd = new Date(b.start_time).getTime();
            if (isNaN(ad) || isNaN(bd)) return 0;
            return ad - bd;
          }
        )
      : [];

  const agenda = useMemo(() => {
    const days: {
      date: Date;
      key: string;
      meetings: Meeting[];
      events: CalendarEvent[];
    }[] = [];
    for (let offset = 0; offset <= 7; offset++) {
      const d = new Date(today);
      d.setDate(today.getDate() + offset);
      d.setHours(0, 0, 0, 0);
      const key = getDayKey(d);
      const meetingsForDay = meetingsByDay.get(key) ?? [];
      const eventsForDay = eventsByDay.get(key) ?? [];

      if (meetingsForDay.length === 0 && eventsForDay.length === 0) continue;

      const sortedMeetings = [...meetingsForDay].sort((a, b) => {
        const ad = getMeetingStartDate(a);
        const bd = getMeetingStartDate(b);
        if (!ad || !bd) return 0;
        return ad.getTime() - bd.getTime();
      });

      const sortedEvents = [...eventsForDay].sort((a, b) => {
        const ad = new Date(a.start_time).getTime();
        const bd = new Date(b.start_time).getTime();
        if (isNaN(ad) || isNaN(bd)) return 0;
        return ad - bd;
      });

      days.push({ date: d, key, meetings: sortedMeetings, events: sortedEvents });
    }
    return days;
  }, [meetingsByDay, eventsByDay, today]);

  function moveFocus(delta: number) {
    const next = new Date(focusDate);
    if (mode === "month") {
      next.setMonth(focusDate.getMonth() + delta);
    } else {
      next.setDate(focusDate.getDate() + delta * 7);
    }
    next.setHours(0, 0, 0, 0);
    setFocusDate(next);
  }

  const monthLabel = focusDate.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          fontSize: 13,
          color: isDark ? "#e5e7eb" : "#111827",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => moveFocus(-1)}
            style={{
              padding: "4px 8px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              background: isDark ? "#111827" : "#e5e7eb",
              color: isDark ? "#e5e7eb" : "#111827",
              fontSize: 12,
            }}
          >
            ←
          </button>
          <div style={{ fontWeight: 500 }}>{monthLabel}</div>
          <button
            onClick={() => moveFocus(1)}
            style={{
              padding: "4px 8px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              background: isDark ? "#111827" : "#e5e7eb",
              color: isDark ? "#e5e7eb" : "#111827",
              fontSize: 12,
            }}
          >
            →
          </button>
          <button
            onClick={() => {
              const now = new Date();
              now.setHours(0, 0, 0, 0);
              setFocusDate(now);
              setSelectedDate(now);
            }}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              background: isDark ? "#0f172a" : "#e0edff",
              color: isDark ? "#e5e7eb" : "#1d4ed8",
              fontSize: 12,
            }}
          >
            Today
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: isDark ? "#9ca3af" : "#6b7280",
            }}
          >
            View:
          </span>
          <button
            onClick={() => setMode("week")}
            style={{
              padding: "4px 8px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              background:
                mode === "week"
                  ? isDark
                    ? "#111827"
                    : "#e0edff"
                  : "transparent",
              color:
                mode === "week"
                  ? isDark
                    ? "#e5e7eb"
                    : "#1d4ed8"
                  : isDark
                  ? "#9ca3af"
                  : "#6b7280",
            }}
          >
            Week
          </button>
          <button
            onClick={() => setMode("month")}
            style={{
              padding: "4px 8px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              background:
                mode === "month"
                  ? isDark
                    ? "#111827"
                    : "#e0edff"
                  : "transparent",
              color:
                mode === "month"
                  ? isDark
                    ? "#e5e7eb"
                    : "#1d4ed8"
                  : isDark
                  ? "#9ca3af"
                  : "#6b7280",
            }}
          >
            Month
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          flex: 1,
          minHeight: mode === "week" ? 260 : 360,
          flexWrap: "wrap",
        }}
      >
        {/* Calendar grid */}
        <div
          style={{
            flex: mode === "week" ? 2 : 3,
            minWidth: 340,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            className="view-transition"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
              fontSize: 12,
              color: isDark ? "#9ca3af" : "#4b5563",
              marginBottom: 4,
              textAlign: "center",
            }}
          >
            {weekdayLabels.map((label) => (
              <div
                key={label}
                style={{
                  padding: "4px 0",
                }}
              >
                {label}
              </div>
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
              fontSize: 12,
              gridAutoRows: "1fr",
              alignContent: "stretch",
              flex: 1,
            }}
          >
            {visibleDays.map((day) => {
              const key = getDayKey(day);
              const dayMeetings = meetingsByDay.get(key) ?? [];
              const dayEvents = eventsByDay.get(key) ?? [];
              const isToday = isSameDay(day, today);
              const isSelected =
                selectedDate && isSameDay(day, selectedDate);
              const inCurrentMonth =
                day.getMonth() === focusDate.getMonth();

              return (
                <button
                  key={key}
                  onClick={() => setSelectedDate(new Date(day))}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    borderRadius: 10,
                    border: isSelected
                      ? `2px solid ${theme === "dark" ? "#3b82f6" : "#2563eb"}`
                      : `1px solid ${
                          isDark ? "#1f2937" : "#e5e7eb"
                        }`,
                    background: isSelected
                      ? theme === "dark"
                        ? "#020617"
                        : "#dbeafe"
                      : isDark
                      ? "#020617"
                      : "#f9fafb",
                    padding: 8,
                    textAlign: "left",
                    cursor: "pointer",
                    height: "100%",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: isToday ? 700 : 500,
                        color: inCurrentMonth
                          ? isDark
                            ? "#e5e7eb"
                            : "#111827"
                          : isDark
                          ? "#4b5563"
                          : "#d1d5db",
                      }}
                    >
                      {day.getDate()}
                    </span>
                    {isToday && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "0 4px",
                          borderRadius: 999,
                          background: theme === "dark"
                            ? "#0f766e"
                            : "#22c55e",
                          color: "#f9fafb",
                        }}
                      >
                        Today
                      </span>
                    )}
                  </div>
                  {dayMeetings.length > 0 && (
                    <div
                      style={{
                        fontSize: 10,
                        color: isDark ? "#9ca3af" : "#6b7280",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "block",
                      }}
                    >
                      {dayMeetings.slice(0, 3).map((m) => (
                        <div
                          key={m.id}
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          • {m.title}
                        </div>
                      ))}
                      {dayMeetings.length > 3 && (
                        <div>+{dayMeetings.length - 3} more</div>
                      )}
                    </div>
                  )}
                  {dayEvents.length > 0 && (
                    <div
                      style={{
                        fontSize: 10,
                        color: isDark ? "#a5b4fc" : "#4b5563",
                        marginTop: dayMeetings.length > 0 ? 2 : 0,
                        overflow: "hidden",
                      }}
                    >
                      {dayEvents.slice(0, 2).map((ev) => (
                        <div
                          key={ev.id}
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          📅 {ev.title}
                        </div>
                      ))}
                      {dayEvents.length > 2 && (
                        <div>+{dayEvents.length - 2} more event(s)</div>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Day details + agenda */}
        <div
          style={{
            flex: 1,
            minWidth: 220,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <section
            style={{
              borderRadius: 10,
              border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
              padding: 8,
              fontSize: 12,
              background: isDark ? "#020617" : "#ffffff",
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontWeight: 500,
                  color: isDark ? "#e5e7eb" : "#111827",
                }}
              >
                {selectedDate
                  ? selectedDate.toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })
                  : "Select a day"}
              </div>
              <button
                onClick={() => {
                  if (!selectedDate || isRecording) return;
                  const d = new Date(selectedDate);
                  d.setHours(new Date().getHours(), new Date().getMinutes(), 0, 0);
                  onStartRecordingForDate(d);
                }}
                disabled={!selectedDate || isRecording}
                style={{
                  padding: "4px 8px",
                  borderRadius: 999,
                  border: "none",
                  cursor:
                    !selectedDate || isRecording ? "not-allowed" : "pointer",
                  background:
                    !selectedDate || isRecording
                      ? isDark
                        ? "#111827"
                        : "#e5e7eb"
                      : "#ef4444",
                  color:
                    !selectedDate || isRecording
                      ? isDark
                        ? "#6b7280"
                        : "#9ca3af"
                      : "#ffffff",
                }}
              >
                {isRecording ? "Recording…" : "Record on this day"}
              </button>
            </div>

            {selectedMeetings.length === 0 && selectedEvents.length === 0 ? (
              <p
                style={{
                  margin: 0,
                  color: isDark ? "#9ca3af" : "#6b7280",
                }}
              >
                No meetings or events on this day yet.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {selectedMeetings.map((m) => {
                  const start = getMeetingStartDate(m);
                  const timeLabel =
                    start &&
                    start.toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    });
                  return (
                    <li
                      key={m.id}
                      style={{
                        padding: 6,
                        borderRadius: 8,
                        cursor: "pointer",
                        border: `1px solid ${
                          isDark ? "#111827" : "#e5e7eb"
                        }`,
                      }}
                      onClick={() => onOpenMeeting(m.id)}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 500,
                            color: isDark ? "#e5e7eb" : "#111827",
                          }}
                        >
                          {m.title}
                        </span>
                        {timeLabel && (
                          <span
                            style={{
                              fontSize: 11,
                              color: isDark ? "#9ca3af" : "#6b7280",
                            }}
                          >
                            {timeLabel}
                          </span>
                        )}
                      </div>
                      {m.summary && (
                        <div
                          style={{
                            marginTop: 2,
                            fontSize: 11,
                            color: isDark ? "#9ca3af" : "#6b7280",
                          }}
                        >
                          {getSummaryPreview(m.summary)}
                        </div>
                      )}
                    </li>
                  );
                })}
                {selectedEvents.map((ev) => {
                  const d = new Date(ev.start_time);
                  const timeLabel = isNaN(d.getTime())
                    ? ""
                    : d.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      });
                  return (
                    <li
                      key={ev.id}
                      style={{
                        padding: 6,
                        borderRadius: 8,
                        cursor: "pointer",
                        border: `1px solid ${
                          isDark ? "#111827" : "#e5e7eb"
                        }`,
                        background: isDark ? "#020617" : "#f9fafb",
                      }}
                      onClick={() => openCalendarEvent(ev)}
                      title="Open in Google Calendar"
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            color: isDark ? "#a5b4fc" : "#4338ca",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <span aria-hidden="true">📅</span>
                          {ev.title || "(No title)"}
                        </span>
                        {timeLabel && (
                          <span
                            style={{
                              fontSize: 11,
                              color: isDark ? "#9ca3af" : "#6b7280",
                            }}
                          >
                            {timeLabel}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section
            style={{
              borderRadius: 10,
              border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
              padding: 8,
              fontSize: 12,
              background: isDark ? "#020617" : "#ffffff",
              flex: 1,
              overflow: "auto",
            }}
          >
            <div
              style={{
                marginBottom: 6,
                fontWeight: 500,
                color: isDark ? "#e5e7eb" : "#111827",
              }}
            >
              Agenda (today + next 7 days)
            </div>
            {agenda.length === 0 ? (
              <p
                style={{
                  margin: 0,
                  color: isDark ? "#9ca3af" : "#6b7280",
                }}
              >
                No upcoming meetings scheduled in this range.
              </p>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {agenda.map(
                  ({ date, key, meetings: dayMeetings, events: dayEvents }) => {
                    const label =
                      isSameDay(date, today)
                        ? "Today"
                        : isSameDay(
                            date,
                            new Date(
                              today.getFullYear(),
                              today.getMonth(),
                              today.getDate() + 1
                            )
                          )
                        ? "Tomorrow"
                        : date.toLocaleDateString(undefined, {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                          });

                    const isExpanded = expandedAgendaKey === key;

                    return (
                      <div
                        key={key}
                        style={{
                          borderRadius: 8,
                          border: `1px solid ${
                            isDark ? "#111827" : "#e5e7eb"
                          }`,
                          padding: 6,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedAgendaKey((prev) =>
                              prev === key ? null : key
                            )
                          }
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            width: "100%",
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            marginBottom: isExpanded ? 4 : 0,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 500,
                              color: isDark ? "#e5e7eb" : "#111827",
                            }}
                          >
                            {label}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              color: isDark ? "#9ca3af" : "#6b7280",
                            }}
                          >
                            {isExpanded ? "Hide" : "Show"}{" "}
                            {dayMeetings.length + dayEvents.length} event
                            {dayMeetings.length + dayEvents.length === 1
                              ? ""
                              : "s"}
                          </span>
                        </button>
                        {isExpanded && (
                          <ul
                            style={{
                              listStyle: "none",
                              padding: 0,
                              margin: 0,
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                            }}
                          >
                            {dayMeetings.map((m) => {
                              const start = getMeetingStartDate(m);
                              const timeLabel =
                                start &&
                                start.toLocaleTimeString(undefined, {
                                  hour: "numeric",
                                  minute: "2-digit",
                                });
                              return (
                                <li
                                  key={m.id}
                                  style={{
                                    cursor: "pointer",
                                    borderRadius: 6,
                                    padding: 4,
                                    background: isDark
                                      ? "#020617"
                                      : "#f9fafb",
                                  }}
                                  onClick={() => onOpenMeeting(m.id)}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 6,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 12,
                                        fontWeight: 500,
                                        color: isDark
                                          ? "#e5e7eb"
                                          : "#111827",
                                      }}
                                    >
                                      {m.title}
                                    </span>
                                    {timeLabel && (
                                      <span
                                        style={{
                                          fontSize: 11,
                                          color: isDark
                                            ? "#9ca3af"
                                            : "#6b7280",
                                        }}
                                      >
                                        {timeLabel}
                                      </span>
                                    )}
                                  </div>
                                  {m.summary && (
                                    <div
                                      style={{
                                        marginTop: 2,
                                        fontSize: 11,
                                        color: isDark
                                          ? "#9ca3af"
                                          : "#6b7280",
                                      }}
                                    >
                                      {getSummaryPreview(m.summary)}
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                            {dayEvents.map((ev) => {
                              const d = new Date(ev.start_time);
                              const timeLabel = isNaN(d.getTime())
                                ? ""
                                : d.toLocaleTimeString(undefined, {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  });
                              return (
                                <li
                                  key={ev.id}
                                  style={{
                                    cursor: "pointer",
                                    borderRadius: 6,
                                    padding: 4,
                                    background: isDark
                                      ? "#020617"
                                      : "#f9fafb",
                                  }}
                                  onClick={() => openCalendarEvent(ev)}
                                  title="Open in Google Calendar"
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 6,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 12,
                                        color: isDark
                                          ? "#a5b4fc"
                                          : "#4338ca",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 4,
                                      }}
                                    >
                                      <span aria-hidden="true">📅</span>
                                      {ev.title || "(No title)"}
                                    </span>
                                    {timeLabel && (
                                      <span
                                        style={{
                                          fontSize: 11,
                                          color: isDark
                                            ? "#9ca3af"
                                            : "#6b7280",
                                        }}
                                      >
                                        {timeLabel}
                                      </span>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  }
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// --------- ActionItemsView component ---------

interface ActionItemsViewProps {
  meetings: Meeting[];
  onOpenMeeting: (meetingId: string) => void;
  isDark: boolean;
}

function ActionItemsView({
  meetings,
  onOpenMeeting,
  isDark,
}: ActionItemsViewProps) {
  const [statusFilter, setStatusFilter] = useState<"open" | "done" | "all">(
    "open"
  );
  const [dueFilter, setDueFilter] = useState<"all" | "overdue" | "week">(
    "all"
  );

  const items = useMemo<AggregatedActionItem[]>(() => {
    const result: AggregatedActionItem[] = [];

    for (const m of meetings) {
      const actionItems = parseActionItemsFromMeeting(m);
      if (actionItems.length === 0) continue;

      actionItems.forEach((item, idx) => {
        if (!item) return;
        const task = String(item.task || "").trim();
        if (!task) return;

        result.push({
          id: `${m.id}-${idx}`,
          meetingId: m.id,
          meetingTitle: m.title,
          createdAt: m.created_at,
          itemIndex: idx,
          task,
          owner: item.owner ?? undefined,
          dueDate: item.due_date ?? undefined,
          status: item.status ?? "open",
        });
      });
    }

    // Sort: due date first, then created_at
    result.sort((a, b) => {
      const aHasDue = !!a.dueDate;
      const bHasDue = !!b.dueDate;
      if (aHasDue && !bHasDue) return -1;
      if (!aHasDue && bHasDue) return 1;

      if (a.dueDate && b.dueDate) {
        const ad = new Date(a.dueDate).getTime();
        const bd = new Date(b.dueDate).getTime();
        if (!isNaN(ad) && !isNaN(bd)) return ad - bd;
      }

      const ac = new Date(a.createdAt).getTime();
      const bc = new Date(b.createdAt).getTime();
      return ac - bc;
    });

    return result;
  }, [meetings]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - startOfWeek.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const status = (item.status || "open").toLowerCase();

      if (statusFilter === "open" && status === "done") return false;
      if (statusFilter === "done" && status !== "done") return false;

      if (dueFilter !== "all") {
        if (!item.dueDate) return false;
        const dt = new Date(item.dueDate);
        if (isNaN(dt.getTime())) return false;
        const dayOnly = new Date(dt);
        dayOnly.setHours(0, 0, 0, 0);

        if (dueFilter === "overdue" && dayOnly >= today) return false;
        if (
          dueFilter === "week" &&
          (dayOnly < startOfWeek || dayOnly > endOfWeek)
        ) {
          return false;
        }
      }

      return true;
    });
  }, [items, statusFilter, dueFilter, today, startOfWeek, endOfWeek]);

  function formatDueLabel(due?: string) {
    if (!due) return "No due date";
    const dt = new Date(due);
    if (isNaN(dt.getTime())) return due;

    const dayOnly = new Date(dt);
    dayOnly.setHours(0, 0, 0, 0);
    const diffDays =
      (dayOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);

    if (diffDays < 0) {
      return `Overdue • ${dt.toLocaleDateString()}`;
    }
    if (diffDays === 0) {
      return `Today • ${dt.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }
    if (diffDays === 1) {
      return `Tomorrow • ${dt.toLocaleDateString()}`;
    }
    return dt.toLocaleDateString();
  }

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          fontSize: 14,
          color: isDark ? "#9ca3af" : "#6b7280",
        }}
      >
        No open action items found. Try recording a meeting with clear next
        steps, or run “Extract / Re-extract” on existing meetings.
      </div>
    );
  }

  const meetingCount = new Set(filteredItems.map((i) => i.meetingId)).size;

  const handleToggleStatus = async (item: AggregatedActionItem) => {
    const meeting = meetings.find((m) => m.id === item.meetingId);
    if (!meeting) return;
    const parsed = parseActionItemsFromMeeting(meeting);
    if (item.itemIndex < 0 || item.itemIndex >= parsed.length) return;

    const current = parsed[item.itemIndex];
    const nextStatus =
      (current.status || "open").toLowerCase() === "done" ? "open" : "done";

    const updated = parsed.map((ai, idx) =>
      idx === item.itemIndex ? { ...ai, status: nextStatus } : ai
    );

    try {
      await updateMeetingActionItems(meeting.id, updated);
    } catch (e) {
      console.error(e);
      alert("Failed to update action item status.");
    }
  };

  const handleExport = () => {
    if (filteredItems.length === 0) {
      alert("No action items in the current filters to export.");
      return;
    }

    const byMeeting = new Map<string, AggregatedActionItem[]>();
    filteredItems.forEach((item) => {
      const key = `${item.meetingTitle} (${new Date(
        item.createdAt
      ).toLocaleDateString()})`;
      const arr = byMeeting.get(key);
      if (arr) {
        arr.push(item);
      } else {
        byMeeting.set(key, [item]);
      }
    });

    const parts: string[] = [];
    parts.push("# Action items");
    parts.push("");
    for (const [label, group] of byMeeting.entries()) {
      parts.push(`## ${label}`);
      parts.push("");
      for (const item of group) {
        const status = item.status || "open";
        const due = item.dueDate ? ` • Due: ${item.dueDate}` : "";
        const owner = item.owner ? ` • Owner: ${item.owner}` : "";
        parts.push(`- [${status === "done" ? "x" : " "}] ${item.task}${owner}${due}`);
      }
      parts.push("");
    }

    const blob = new Blob([parts.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "action-items.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: 8 }}>
      <div
        style={{
          marginBottom: 8,
          fontSize: 13,
          color: isDark ? "#9ca3af" : "#6b7280",
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span>
          {filteredItems.length} action item
          {filteredItems.length === 1 ? "" : "s"} across{" "}
          {meetingCount} meeting{meetingCount > 1 ? "s" : ""}
        </span>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 4,
              alignItems: "center",
              fontSize: 12,
            }}
          >
            <span>Status:</span>
            <button
              onClick={() => setStatusFilter("open")}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                background:
                  statusFilter === "open"
                    ? isDark
                      ? "#111827"
                      : "#e0edff"
                    : "transparent",
                color:
                  statusFilter === "open"
                    ? isDark
                      ? "#e5e7eb"
                      : "#1d4ed8"
                    : isDark
                    ? "#9ca3af"
                    : "#6b7280",
              }}
            >
              Open
            </button>
            <button
              onClick={() => setStatusFilter("done")}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                background:
                  statusFilter === "done"
                    ? isDark
                      ? "#111827"
                      : "#e0edff"
                    : "transparent",
                color:
                  statusFilter === "done"
                    ? isDark
                      ? "#e5e7eb"
                      : "#1d4ed8"
                    : isDark
                    ? "#9ca3af"
                    : "#6b7280",
              }}
            >
              Done
            </button>
            <button
              onClick={() => setStatusFilter("all")}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                background:
                  statusFilter === "all"
                    ? isDark
                      ? "#111827"
                      : "#e0edff"
                    : "transparent",
                color:
                  statusFilter === "all"
                    ? isDark
                      ? "#e5e7eb"
                      : "#1d4ed8"
                    : isDark
                    ? "#9ca3af"
                    : "#6b7280",
              }}
            >
              All
            </button>
          </div>
          <div
            style={{
              display: "flex",
              gap: 4,
              alignItems: "center",
              fontSize: 12,
            }}
          >
            <span>Due:</span>
            <button
              onClick={() => setDueFilter("all")}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                background:
                  dueFilter === "all"
                    ? isDark
                      ? "#111827"
                      : "#e5e7eb"
                    : "transparent",
                color:
                  dueFilter === "all"
                    ? isDark
                      ? "#e5e7eb"
                      : "#111827"
                    : isDark
                    ? "#9ca3af"
                    : "#6b7280",
              }}
            >
              Any time
            </button>
            <button
              onClick={() => setDueFilter("overdue")}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                background:
                  dueFilter === "overdue"
                    ? isDark
                      ? "#7f1d1d"
                      : "#fee2e2"
                    : "transparent",
                color:
                  dueFilter === "overdue"
                    ? isDark
                      ? "#fecaca"
                      : "#b91c1c"
                    : isDark
                    ? "#9ca3af"
                    : "#6b7280",
              }}
            >
              Overdue
            </button>
            <button
              onClick={() => setDueFilter("week")}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                background:
                  dueFilter === "week"
                    ? isDark
                      ? "#065f46"
                      : "#dcfce7"
                    : "transparent",
                color:
                  dueFilter === "week"
                    ? isDark
                      ? "#bbf7d0"
                      : "#166534"
                    : isDark
                    ? "#9ca3af"
                    : "#6b7280",
              }}
            >
              This week
            </button>
          </div>
          <button
            onClick={handleExport}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              background: "#1677ff",
              color: "#ffffff",
            }}
          >
            Export action items
          </button>
        </div>
      </div>

      <div
        style={{
          borderRadius: 12,
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          overflow: "hidden",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead
            style={{
              background: isDark ? "#020617" : "#f9fafb",
              color: isDark ? "#e5e7eb" : "#111827",
            }}
          >
            <tr>
              <th
                style={{
                  width: 36,
                  padding: "8px 10px",
                  borderBottom: `1px solid ${
                    isDark ? "#111827" : "#e5e7eb"
                  }`,
                }}
              ></th>
              <th
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderBottom: `1px solid ${
                    isDark ? "#111827" : "#e5e7eb"
                  }`,
                  fontWeight: 500,
                }}
              >
                Task
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderBottom: `1px solid ${
                    isDark ? "#111827" : "#e5e7eb"
                  }`,
                  fontWeight: 500,
                  width: 160,
                }}
              >
                Due
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderBottom: `1px solid ${
                    isDark ? "#111827" : "#e5e7eb"
                  }`,
                  fontWeight: 500,
                  width: 140,
                }}
              >
                Owner
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderBottom: `1px solid ${
                    isDark ? "#111827" : "#e5e7eb"
                  }`,
                  fontWeight: 500,
                  width: 260,
                }}
              >
                Meeting
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => (
              <tr
                key={item.id}
                style={{
                  cursor: "pointer",
                  backgroundColor: isDark ? "#020617" : "#ffffff",
                }}
                onClick={() => onOpenMeeting(item.meetingId)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = isDark
                    ? "#050816"
                    : "#f9fafb";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = isDark
                    ? "#020617"
                    : "#ffffff";
                }}
              >
                <td
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${
                      isDark ? "#111827" : "#f3f4f6"
                    }`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleToggleStatus(item);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={(item.status || "open") === "done"}
                    readOnly
                  />
                </td>
                <td
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${
                      isDark ? "#111827" : "#f3f4f6"
                    }`,
                  }}
                >
                  {item.task}
                </td>
                <td
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${
                      isDark ? "#111827" : "#f3f4f6"
                    }`,
                    color: isDark ? "#eab308" : "#b45309",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatDueLabel(item.dueDate)}
                </td>
                <td
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${
                      isDark ? "#111827" : "#f3f4f6"
                    }`,
                    color: isDark ? "#e5e7eb" : "#111827",
                  }}
                >
                  {item.owner || "—"}
                </td>
                <td
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${
                      isDark ? "#111827" : "#f3f4f6"
                    }`,
                    color: isDark ? "#9ca3af" : "#6b7280",
                  }}
                >
                  {item.meetingTitle}
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      color: isDark ? "#6b7280" : "#9ca3af",
                    }}
                  >
                    ({new Date(item.createdAt).toLocaleDateString()})
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --------- CommandPalette component ---------

interface CommandPaletteProps {
  commands: Command[];
  query: string;
  setQuery: (value: string) => void;
  onClose: () => void;
  isDark: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function CommandPalette({
  commands,
  query,
  setQuery,
  onClose,
  isDark,
  inputRef,
}: CommandPaletteProps) {
  const sections: Array<Command["section"]> = [
    "General",
    "Navigation",
    "Filters",
  ];

  const handleOverlayClick = () => {
    onClose();
  };

  const handleInnerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  const firstCommand = commands[0];

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (firstCommand) {
        firstCommand.run();
        onClose();
      }
    }
  };

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 80,
        zIndex: 9999,
      }}
    >
      <div
        onClick={handleInnerClick}
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          border: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          background: isDark ? "#020617" : "#ffffff",
          boxShadow: isDark
            ? "0 24px 60px rgba(0,0,0,0.85)"
            : "0 24px 60px rgba(15,23,42,0.2)",
          overflow: "hidden",
          fontFamily: "system-ui",
        }}
      >
        {/* Search input */}
        <div
          style={{
            padding: 10,
            borderBottom: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
          }}
        >
          <input
            ref={inputRef}
            autoFocus
            type="text"
            placeholder="Type a command or search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 999,
              border: `1px solid ${isDark ? "#374151" : "#d1d5db"}`,
              background: isDark ? "#020617" : "#ffffff",
              color: isDark ? "#e5e7eb" : "#111827",
              fontSize: 14,
            }}
          />
        </div>

        {/* Commands list */}
        <div
          style={{
            maxHeight: 320,
            overflowY: "auto",
            padding: 8,
          }}
        >
          {commands.length === 0 ? (
            <div
              style={{
                padding: 16,
                fontSize: 13,
                color: isDark ? "#9ca3af" : "#6b7280",
              }}
            >
              No commands match “{query}”.
            </div>
          ) : (
            sections.map((section) => {
              const items = commands.filter((c) => c.section === section);
              if (items.length === 0) return null;
              return (
                <div key={section} style={{ marginBottom: 8 }}>
                  <div
                    style={{
                      padding: "4px 8px",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.06,
                      color: isDark ? "#6b7280" : "#9ca3af",
                    }}
                  >
                    {section}
                  </div>
                  {items.map((cmd) => (
                    <button
                      key={cmd.id}
                      onClick={() => {
                        cmd.run();
                        onClose();
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontSize: 13,
                        color: isDark ? "#e5e7eb" : "#111827",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = isDark
                          ? "#020617"
                          : "#f3f4f6";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      <span>{cmd.label}</span>
                      {cmd.hint && (
                        <span
                          style={{
                            fontSize: 11,
                            color: isDark ? "#9ca3af" : "#6b7280",
                          }}
                        >
                          {cmd.hint}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>

        {/* Footer helper */}
        <div
          style={{
            padding: 8,
            borderTop: `1px solid ${isDark ? "#1f2937" : "#e5e7eb"}`,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: isDark ? "#6b7280" : "#9ca3af",
          }}
        >
          <span>Enter to run • Esc to close</span>
          <span>Cmd + K</span>
        </div>
      </div>
    </div>
  );
}

// ---- default export ----
export default App;
