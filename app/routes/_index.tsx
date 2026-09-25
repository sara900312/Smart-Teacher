import {
  IconBook2,
  IconChevronDown,
  IconFileText,
  IconLoader2,
  IconMessageCircle,
  IconPaperclip,
  IconRefresh,
  IconSend,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";

import "katex/dist/katex.min.css";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { supabase, supabaseKey, supabaseUrl } from "@/lib/supabase";

type Metadata = {
  subject?: string;
  grade?: string;
  stage?: string;
  processing_error?: string;
};
type Book = {
  id: string;
  title: string;
  processing_status: string;
  page_count: number | null;
  text_length: number | null;
  metadata: Metadata | null;
  created_at: string;
  updated_at?: string | null;
};
type Section = {
  id: string;
  document_id: string;
  title: string;
  section_type: string | null;
  chapter_number: number | null;
  lesson_number: number | null;
  page_start: number | null;
  page_end: number | null;
  summary: string | null;
};
type KnowledgeRecord = {
  id: string;
  section_id: string;
  page_start?: number | null;
  chunk_index?: number | null;
  content?: string | null;
};
type ExplanationCache = {
  id: string;
  answer_markdown: string;
  document_id: string;
  section_id: string;
  status: string;
  updated_at?: string | null;
};
type SavedLesson = {
  id: string;
  document_id: string;
  section_id: string;
  document_title: string | null;
  section_title: string | null;
  lesson_number: number | null;
  chapter_number: number | null;
  updated_at: string | null;
  source_count: number | null;
  cache_version: string | null;
  voice_cached?: boolean;
};
type VoiceSegment = {
  id?: string;
  segment_index: number;
  text: string;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms?: number;
  audio_url?: string | null;
  metadata?: Record<string, unknown>;
};
type Message = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  image_preview_url?: string;
  voice_only?: boolean;
  input_source?: "text" | "voice";
  created_at?: string;
  sources?: Source[];
  voice_segments?: VoiceSegment[];
  voice_ready?: boolean;
  voice_loading?: boolean;
  voice_playing?: boolean;
  explanation_cache_id?: string | null;
  explanation_cached?: boolean;
  voice_cached?: boolean;
};
type Source = {
  page?: number;
  page_number?: number;
  title?: string;
  content?: string;
};
type TeacherChatInput = {
  question: string;
  documentId: string | null;
  sectionId: string | null;
  conversationId: string | null;
  conversationHistory: Message[];
  inputSource: "text" | "voice";
  imageDataUrl: string | null;
};

function buildTeacherChatPayload({
  question,
  documentId,
  sectionId,
  conversationId,
  conversationHistory,
  inputSource,
  imageDataUrl,
}: TeacherChatInput) {
  return {
    question,
    document_id: documentId || null,
    section_id: sectionId || null,
    conversation_id: conversationId || null,
    conversation_history: conversationHistory.map(({ role, content }) => ({
      role,
      content,
    })),
    input_source: inputSource,
    ...(imageDataUrl
      ? { image: { data_url: imageDataUrl, detail: "auto" as const } }
      : {}),
  };
}

async function optimizeChatImage(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create image canvas");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (imageBlob) =>
          imageBlob
            ? resolve(imageBlob)
            : reject(new Error("Unable to encode image")),
        "image/jpeg",
        0.8,
      );
    });
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Unable to read optimized image"));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, size: blob.size, width, height };
  } finally {
    bitmap.close();
  }
}

function getErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return "حدث خطأ أثناء الاتصال بالمدرس الذكي.";
}

function renderTeacherMarkdown(content: string) {
  return content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `$$${math}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math: string) => `$${math}$`);
}

function normalizeVoiceChars(value: string) {
  const normalizedCharacters: string[] = [];
  const sourceOffsets: number[] = [];
  let pendingSpaceSourceOffset: number | null = null;
  let previousWasSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const original = value[index];
    const normalized = original
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[“”„«»]/g, '"')
      .replace(/[‘’‚]/g, "'")
      .toLocaleLowerCase();

    if (
      /\s/.test(original) ||
      (/[\p{P}\p{S}]/u.test(original) && !/[’'‘]/.test(original))
    ) {
      if (normalizedCharacters.length > 0 && !previousWasSpace) {
        pendingSpaceSourceOffset = index;
      }
      previousWasSpace = true;
      continue;
    }

    if (/[’'‘]/.test(original) || !normalized) continue;

    if (pendingSpaceSourceOffset !== null) {
      normalizedCharacters.push(" ");
      sourceOffsets.push(pendingSpaceSourceOffset);
      pendingSpaceSourceOffset = null;
    }

    previousWasSpace = false;
    normalizedCharacters.push(normalized);
    sourceOffsets.push(index);
  }

  while (
    normalizedCharacters.length > 0 &&
    normalizedCharacters[normalizedCharacters.length - 1] === " "
  ) {
    normalizedCharacters.pop();
    sourceOffsets.pop();
  }

  return { text: normalizedCharacters.join(""), map: sourceOffsets };
}

function normalizeForVoiceMatching(value: string) {
  return normalizeVoiceChars(value).text;
}

type TeacherStreamCallbacks = {
  onDelta: (text: string) => void;
  onMeta: (data: Record<string, unknown>) => void;
  onDone: (data?: Record<string, unknown>) => void;
  onError: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function extractDeltaFromEvent(
  eventType: string,
  parsed: Record<string, unknown>,
): string {
  const data = isRecord(parsed.data) ? parsed.data : parsed;
  if (
    eventType !== "response.output_text.delta" &&
    eventType !== "delta" &&
    eventType !== "message.delta"
  ) {
    return "";
  }
  if (typeof data.delta === "string") return data.delta;
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  if (typeof data.output_text === "string") return data.output_text;
  return "";
}

function extractEventType(
  parsed: Record<string, unknown>,
  explicitEventType: string,
) {
  if (explicitEventType) {
    return explicitEventType;
  }

  if (typeof parsed.type === "string") {
    return parsed.type;
  }

  if (isRecord(parsed.data) && typeof parsed.data.type === "string") {
    return parsed.data.type;
  }

  return "";
}

function extractEventPayload(parsed: Record<string, unknown>) {
  return isRecord(parsed.data) ? parsed.data : parsed;
}

function extractAssistantMessageId(event: Record<string, unknown>) {
  if (typeof event.message_id === "string") return event.message_id;
  if (typeof event.assistant_message_id === "string")
    return event.assistant_message_id;
  if (isRecord(event.data)) {
    if (typeof event.data.message_id === "string") return event.data.message_id;
    if (typeof event.data.assistant_message_id === "string")
      return event.data.assistant_message_id;
  }
  return null;
}

function extractExplanationCacheId(
  event: Record<string, unknown>,
): string | null {
  for (const key of ["explanation_cache_id", "explanationCacheId"]) {
    if (typeof event[key] === "string" && event[key].trim())
      return event[key].trim();
    if (
      isRecord(event.data) &&
      typeof event.data[key] === "string" &&
      event.data[key].trim()
    )
      return event.data[key].trim();
  }
  return null;
}

function extractBooleanField(
  event: Record<string, unknown>,
  keys: string[],
): boolean | null {
  for (const key of keys) {
    if (typeof event[key] === "boolean") return event[key];
    if (isRecord(event.data) && typeof event.data[key] === "boolean")
      return event.data[key];
  }
  return null;
}

async function readTeacherStream(
  response: Response,
  callbacks: TeacherStreamCallbacks,
): Promise<void> {
  if (!response.body) {
    throw new Error("استجابة البث غير متاحة.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lastEvent: Record<string, unknown> | undefined;
  let finished = false;

  const emitEvent = (rawEvent: string) => {
    if (!rawEvent.trim() || finished) {
      return;
    }

    const lines = rawEvent.split(/\r?\n/);
    let explicitEventType = "";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        explicitEventType = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
        dataLines.push(value);
      }
    }

    const payload = dataLines.join("\n").trim();
    if (!payload) {
      return;
    }

    if (payload === "[DONE]") {
      finished = true;
      callbacks.onDone(lastEvent);
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      const json: unknown = JSON.parse(payload);
      if (!isRecord(json)) {
        return;
      }
      parsed = json;
    } catch {
      console.warn(
        "[frontend-stream] Invalid JSON SSE payload:",
        payload.slice(0, 300),
      );
      return;
    }

    const resolvedEventType = extractEventType(parsed, explicitEventType);
    const data = extractEventPayload(parsed);

    console.log("[frontend-stream RAW EVENT]", {
      eventType: resolvedEventType,
      parsed,
    });

    lastEvent = parsed;
    callbacks.onMeta({ ...parsed, ...data });

    if (
      resolvedEventType === "error" ||
      resolvedEventType === "response.failed"
    ) {
      const errorMessage =
        typeof data.message === "string"
          ? data.message
          : typeof data.error === "string"
            ? data.error
            : typeof parsed.message === "string"
              ? parsed.message
              : "حدث خطأ أثناء بث إجابة المدرس الذكي.";

      callbacks.onError(errorMessage);
      finished = true;
      return;
    }

    const delta = extractDeltaFromEvent(resolvedEventType, parsed);

    if (delta) {
      console.log("[frontend-stream DELTA RAW]", JSON.stringify(delta));
      callbacks.onDelta(delta);
    }

    if (
      resolvedEventType === "response.completed" ||
      resolvedEventType === "response.output_text.done" ||
      resolvedEventType === "done"
    ) {
      finished = true;
      callbacks.onDone(data);
    }
  };

  const processBuffer = () => {
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index == null) {
        break;
      }

      const eventBlock = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      emitEvent(eventBlock);

      if (finished) {
        buffer = "";
        break;
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      processBuffer();

      if (finished) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation failures.
        }
        break;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim() && !finished) {
      emitEvent(buffer);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures.
    }
  }
}

export function meta() {
  return [
    { title: "AI Teacher | المدرس الذكي" },
    { name: "description", content: "مساحة تعلم تفاعلية مبنية على كتبك" },
  ];
}

export default function HomeRoute() {
  const [books, setBooks] = useState<Book[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    null,
  );
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    null,
  );
  const [studyMode, setStudyMode] = useState<"new" | "saved">("new");
  const [savedLessons, setSavedLessons] = useState<SavedLesson[]>([]);
  const [savedLessonsLoaded, setSavedLessonsLoaded] = useState(false);
  const [isLoadingSavedLessons, setIsLoadingSavedLessons] = useState(false);
  const [savedLessonsError, setSavedLessonsError] = useState("");
  const [savedLessonsSearch, setSavedLessonsSearch] = useState("");
  const [topic, setTopic] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachedImage, setAttachedImage] = useState<File | null>(null);
  const [attachedImageUrl, setAttachedImageUrl] = useState<string | null>(null);
  const [attachedImageDataUrl, setAttachedImageDataUrl] = useState<
    string | null
  >(null);
  const [isImageProcessing, setIsImageProcessing] = useState(false);
  const [isSendingImage, setIsSendingImage] = useState(false);
  const [imageError, setImageError] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [items, setItems] = useState<KnowledgeRecord[]>([]);
  const [chunks, setChunks] = useState<KnowledgeRecord[]>([]);
  const [isLoadingBooks, setIsLoadingBooks] = useState(true);
  const [isLoadingSections, setIsLoadingSections] = useState(false);
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(false);
  const [booksError, setBooksError] = useState("");
  const [sectionsError, setSectionsError] = useState("");
  const [knowledgeError, setKnowledgeError] = useState("");
  const [studyExplanation, setStudyExplanation] =
    useState<ExplanationCache | null>(null);
  const [isLoadingStudy, setIsLoadingStudy] = useState(false);
  const [studyError, setStudyError] = useState("");
  const [explanationCached, setExplanationCached] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingError, setRecordingError] = useState("");
  const [recordedAudioBlob, setRecordedAudioBlob] = useState<Blob | null>(null);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"connected" | "disconnected">(
    "disconnected",
  );
  const [userLabel, setUserLabel] = useState("");
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(false);
  const [isVoicePlaying, setIsVoicePlaying] = useState(false);
  const [isVoiceLoading, setIsVoiceLoading] = useState(false);
  const [voiceSegments, setVoiceSegments] = useState<VoiceSegment[]>([]);
  const [activeVoiceSegment, setActiveVoiceSegment] = useState<number | null>(
    null,
  );
  const [activeVoiceMessageId, setActiveVoiceMessageId] = useState<
    string | null
  >(null);
  const [voiceUiState, setVoiceUiState] = useState<
    "idle" | "thinking" | "speaking" | "paused" | "error" | "ready"
  >("idle");
  const [voiceError, setVoiceError] = useState("");
  const chatPanelRef = useRef<HTMLElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachedImageUrlRef = useRef<string | null>(null);
  const imageProcessingRunIdRef = useRef(0);
  const messageImageUrlsRef = useRef(new Set<string>());
  const transcribeAbortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const questionInputRef = useRef<HTMLInputElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceSegmentsRef = useRef<VoiceSegment[]>([]);
  const voiceIndexRef = useRef(0);
  const voiceObjectUrlRef = useRef<string | null>(null);
  const voiceRunIdRef = useRef(0);
  const voiceTimelineSegmentRef = useRef<number | null>(null);
  const voiceAnswerRef = useRef<{
    text: string;
    documentId: string | null;
    sectionId: string | null;
    conversationId: string | null;
    messageId: string | null;
  } | null>(null);
  const activeVoiceMessageIdRef = useRef<string | null>(null);
  const voiceHighlightLayerRef = useRef<HTMLDivElement | null>(null);
  const voiceHighlightRangeRef = useRef<Range | null>(null);
  const voiceAbortControllerRef = useRef<AbortController | null>(null);
  const voicePlaybackCancelRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserFrameRef = useRef<number | null>(null);
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const voiceLevelRef = useRef(0);
  const analyserLastLogRef = useRef(0);
  const voiceReplyEnabledRef = useRef(false);
  const isAskingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const isRecordingRef = useRef(false);
  const recordingCancelledRef = useRef(false);
  const recordingAutoSubmitRef = useRef(false);
  const recordingDurationRef = useRef(0);

  const clearAttachedImage = useCallback((logRemoval = true) => {
    imageProcessingRunIdRef.current += 1;
    const url = attachedImageUrlRef.current;
    if (url) URL.revokeObjectURL(url);
    attachedImageUrlRef.current = null;
    setAttachedImage(null);
    setAttachedImageUrl(null);
    setAttachedImageDataUrl(null);
    setIsImageProcessing(false);
    setImageError("");
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (logRemoval && url) console.log("[teacher-chat-ui] IMAGE REMOVED");
  }, []);

  const clearMessageImageUrls = useCallback(() => {
    for (const url of messageImageUrlsRef.current) URL.revokeObjectURL(url);
    messageImageUrlsRef.current.clear();
  }, []);

  const attachChatImage = useCallback(
    async (file: File) => {
      if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) {
        console.error("[teacher-chat-ui] IMAGE ERROR", "unsupported type");
        setImageError("نوع الصورة غير مدعوم. اختر JPG أو PNG أو WebP.");
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        console.error("[teacher-chat-ui] IMAGE ERROR", "file exceeds 5 MB");
        setImageError("حجم الصورة كبير، اختر صورة أصغر.");
        return;
      }

      clearAttachedImage(false);
      const runId = ++imageProcessingRunIdRef.current;
      const previewUrl = URL.createObjectURL(file);
      attachedImageUrlRef.current = previewUrl;
      setAttachedImage(file);
      setAttachedImageUrl(previewUrl);
      setImageError("");
      setIsImageProcessing(true);
      console.log("[teacher-chat-ui] IMAGE ATTACHED", {
        mimeType: file.type,
        size: file.size,
      });

      try {
        const optimized = await optimizeChatImage(file);
        if (runId !== imageProcessingRunIdRef.current) return;
        setAttachedImageDataUrl(optimized.dataUrl);
        console.log("[teacher-chat-ui] IMAGE OPTIMIZED", {
          size: optimized.size,
          width: optimized.width,
          height: optimized.height,
        });
      } catch (imageError) {
        if (runId !== imageProcessingRunIdRef.current) return;
        console.error("[teacher-chat-ui] IMAGE ERROR", imageError);
        setImageError("تعذر إرسال الصورة.");
      } finally {
        if (runId === imageProcessingRunIdRef.current)
          setIsImageProcessing(false);
      }
    },
    [clearAttachedImage],
  );

  const loadSavedLessons = useCallback(
    async (force = false) => {
      if (
        !supabase ||
        !supabaseUrl ||
        !supabaseKey ||
        (savedLessonsLoaded && !force)
      )
        return;

      setIsLoadingSavedLessons(true);
      setSavedLessonsError("");
      console.log("[study] LOAD SAVED MATERIALS");

      try {
        const response = await fetch(
          `${supabaseUrl}/functions/v1/lesson-explanation`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${supabaseKey}`,
              apikey: supabaseKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "list" }),
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          success?: boolean;
          materials?: SavedLesson[];
          error?: string;
        } | null;
        if (!response.ok || payload?.success !== true)
          throw new Error(payload?.error || `HTTP ${response.status}`);

        const materials = [...(payload.materials ?? [])].sort(
          (a, b) =>
            (Date.parse(b.updated_at || "") || 0) -
            (Date.parse(a.updated_at || "") || 0),
        );
        setSavedLessons(materials);
        setSavedLessonsLoaded(true);
        console.log("[study] SAVED MATERIALS LOADED", {
          count: materials.length,
        });
      } catch (requestError) {
        console.error("[study] SAVED MATERIALS ERROR", requestError);
        setSavedLessonsError("تعذر تحميل المواد المحفوظة.");
      } finally {
        setIsLoadingSavedLessons(false);
      }
    },
    [savedLessonsLoaded],
  );

  const loadBooks = useCallback(async () => {
    if (!supabase) {
      setIsLoadingBooks(false);
      return;
    }
    setIsLoadingBooks(true);
    setBooksError("");
    const { data, error: queryError } = await supabase
      .from("knowledge_documents")
      .select("*")
      .order("created_at", { ascending: false });
    console.log(
      "[AI Teacher] documents:",
      (data ?? []).map((document) => ({
        id: document.id,
        title: document.title,
        processing_status: document.processing_status,
        page_count: document.page_count,
        created_at: document.created_at,
        updated_at: document.updated_at,
      })),
    );
    if (queryError) console.error("[AI Teacher] documents error:", queryError);
    if (queryError) {
      setBooksError("تعذر تحميل الكتب من Supabase. تحقق من صلاحيات القراءة.");
      setConnection("disconnected");
    } else {
      setBooks((data ?? []) as Book[]);
      setConnection("connected");
    }
    setIsLoadingBooks(false);
  }, []);

  useEffect(() => {
    void loadBooks();
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      const email = data.session?.user?.email;
      if (email) setUserLabel(email.split("@")[0]);
    });
  }, [loadBooks]);

  useEffect(() => {
    if (studyMode === "saved") {
      console.log("[study] MODE SAVED");
      void loadSavedLessons();
    } else {
      console.log("[study] MODE NEW");
    }
  }, [loadSavedLessons, studyMode]);

  useEffect(() => {
    if (!supabase || !selectedDocumentId) {
      setSections([]);
      setSelectedSectionId(null);
      setItems([]);
      setChunks([]);
      return;
    }
    setIsLoadingSections(true);
    setSectionsError("");
    setSelectedSectionId(null);
    setItems([]);
    setChunks([]);
    void supabase
      .from("knowledge_sections")
      .select(
        "id, document_id, title, section_type, chapter_number, lesson_number, page_start, page_end, summary",
      )
      .eq("document_id", selectedDocumentId)
      .order("page_start", { ascending: true })
      .then(({ data, error: queryError }) => {
        console.log("[AI Teacher] sections:", data);
        if (queryError)
          console.error("[AI Teacher] sections error:", queryError);
        if (queryError)
          setSectionsError(
            "تعذر تحميل دروس هذا الكتاب. تحقق من صلاحيات القراءة.",
          );
        else setSections((data ?? []) as Section[]);
        setIsLoadingSections(false);
      });
  }, [selectedDocumentId]);

  useEffect(() => {
    if (!supabase || !selectedSectionId) {
      setItems([]);
      setChunks([]);
      setStudyExplanation(null);
      setExplanationCached(false);

      setStudyError("");
      return;
    }
    setIsLoadingKnowledge(true);
    setKnowledgeError("");
    void Promise.all([
      supabase
        .from("knowledge_items")
        .select("*")
        .eq("section_id", selectedSectionId)
        .order("page_start", { ascending: true }),
      supabase
        .from("knowledge_chunks")
        .select("*")
        .eq("section_id", selectedSectionId)
        .order("chunk_index", { ascending: true }),
    ]).then(([itemsResult, chunksResult]) => {
      console.log("[AI Teacher] items:", itemsResult.data);
      console.log("[AI Teacher] chunks:", chunksResult.data);
      if (itemsResult.error)
        console.error("[AI Teacher] items error:", itemsResult.error);
      if (chunksResult.error)
        console.error("[AI Teacher] chunks error:", chunksResult.error);
      if (itemsResult.error || chunksResult.error)
        setKnowledgeError(
          "تعذر تحميل المعرفة المستخرجة لهذا الدرس. تحقق من صلاحيات القراءة.",
        );
      setItems((itemsResult.data ?? []) as KnowledgeRecord[]);
      setChunks((chunksResult.data ?? []) as KnowledgeRecord[]);
      setIsLoadingKnowledge(false);
    });
  }, [selectedSectionId]);

  useEffect(() => {
    if (
      !supabase ||
      !supabaseUrl ||
      !supabaseKey ||
      !selectedDocumentId ||
      !selectedSectionId
    )
      return;

    let active = true;
    setIsLoadingStudy(true);
    setStudyError("");
    setStudyExplanation(null);
    setExplanationCached(false);

    console.log("[study] LOAD EXPLANATION", {
      documentId: selectedDocumentId,
      sectionId: selectedSectionId,
    });

    void fetch(`${supabaseUrl}/functions/v1/lesson-explanation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        document_id: selectedDocumentId,
        section_id: selectedSectionId,
      }),
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          success?: boolean;
          cached?: boolean;
          explanation_cache_id?: string | null;
          answer?: string | null;
          answer_hash?: string | null;
          cache_key?: string | null;
          source_hash?: string | null;
          model?: string | null;
          cache_version?: string | null;
          source_count?: number | null;
          created_at?: string | null;
          updated_at?: string | null;
          error?: string;
        } | null;

        if (!response.ok || payload?.success !== true) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }

        return payload;
      })
      .then((payload) => {
        if (!active) return;
        if (
          !payload?.cached ||
          !payload.answer?.trim() ||
          !payload.explanation_cache_id
        ) {
          console.log("[study] EXPLANATION CACHE MISS", {
            documentId: selectedDocumentId,
            sectionId: selectedSectionId,
          });
          setIsLoadingStudy(false);
          return;
        }

        const explanation: ExplanationCache = {
          id: payload.explanation_cache_id,
          answer_markdown: payload.answer,
          document_id: selectedDocumentId,
          section_id: selectedSectionId,
          status: "ready",
          updated_at: payload.updated_at,
        };

        console.log("[study] EXPLANATION CACHE HIT", {
          explanationCacheId: explanation.id,
        });
        console.log("[study] EXPLANATION CACHE ID", explanation.id);
        setStudyExplanation(explanation);
        setExplanationCached(true);
        setIsLoadingStudy(false);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        console.error("[study] EXPLANATION CACHE ERROR", requestError);
        setStudyError("تعذر تحميل الشرح المحفوظ لهذا الدرس.");
        setIsLoadingStudy(false);
      });

    return () => {
      active = false;
    };
  }, [selectedDocumentId, selectedSectionId]);

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedDocumentId),
    [books, selectedDocumentId],
  );
  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedSectionId),
    [sections, selectedSectionId],
  );
  const filteredSavedLessons = useMemo(() => {
    const query = savedLessonsSearch.trim().toLocaleLowerCase();
    if (!query) return savedLessons;
    return savedLessons.filter((lesson) =>
      [
        lesson.document_title,
        lesson.section_title,
        lesson.lesson_number == null ? "" : String(lesson.lesson_number),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [savedLessons, savedLessonsSearch]);

  const normalizeComparableText = normalizeForVoiceMatching;

  const clearVoiceHighlight = useCallback(() => {
    voiceHighlightRangeRef.current = null;
    const layer = voiceHighlightLayerRef.current;
    if (!layer?.childElementCount) return;
    layer.replaceChildren();
    console.log("[voice-sync] HIGHLIGHT CLEARED");
  }, []);

  const renderVoiceOverlayRects = useCallback(() => {
    const layer = voiceHighlightLayerRef.current;
    const range = voiceHighlightRangeRef.current;
    if (!layer || !range) return;

    layer.replaceChildren();
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    rects.forEach((rect) => {
      const highlight = document.createElement("div");
      highlight.className = "teacher-voice-overlay";
      highlight.style.top = `${rect.top}px`;
      highlight.style.left = `${rect.left}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      highlight.style.setProperty(
        "--voice-level",
        String(voiceLevelRef.current),
      );
      layer.appendChild(highlight);
    });
  }, []);

  const highlightVoiceSegment = useCallback(
    (segment: VoiceSegment) => {
      clearVoiceHighlight();
      const messageId = activeVoiceMessageIdRef.current;
      const messageContainer = messageId
        ? Array.from(
            chatPanelRef.current?.querySelectorAll<HTMLElement>(
              "[data-assistant-message-id]",
            ) ?? [],
          ).find(
            (container) => container.dataset.assistantMessageId === messageId,
          )
        : null;
      const root =
        messageContainer?.querySelector<HTMLElement>(".teacher-markdown");
      if (
        !messageId ||
        !root ||
        !voiceReplyEnabledRef.current ||
        !segment.text.trim()
      )
        return;

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      let currentNode: Node | null = walker.nextNode();
      while (currentNode) {
        const textNode = currentNode as Text;
        if (
          !textNode.parentElement?.closest("script, style, pre, code, .katex")
        )
          textNodes.push(textNode);
        currentNode = walker.nextNode();
      }

      const rawCharacters: string[] = [];
      const rawPoints: Array<{ node: Text; offset: number }> = [];
      let previousBlock: Element | null = null;
      let previousTextNode: Text | null = null;
      textNodes.forEach((textNode, nodeIndex) => {
        const value = textNode.textContent || "";
        const currentBlock =
          textNode.parentElement?.closest(
            "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th",
          ) ?? null;
        let hasLineBreak = false;
        if (previousTextNode && nodeIndex > 0) {
          const betweenNodes = document.createRange();
          betweenNodes.setStart(previousTextNode, previousTextNode.length);
          betweenNodes.setEnd(textNode, 0);
          const ancestor = betweenNodes.commonAncestorContainer;
          const ancestorElement =
            ancestor instanceof Element ? ancestor : ancestor.parentElement;
          hasLineBreak = Array.from(
            ancestorElement?.querySelectorAll("br") ?? [],
          ).some((lineBreak) => betweenNodes.intersectsNode(lineBreak));
        }
        if (nodeIndex > 0 && (currentBlock !== previousBlock || hasLineBreak)) {
          rawCharacters.push(" ");
          rawPoints.push({ node: textNode, offset: 0 });
        }
        previousBlock = currentBlock;
        previousTextNode = textNode;
        for (let offset = 0; offset < value.length; offset += 1) {
          rawCharacters.push(value[offset]);
          rawPoints.push({ node: textNode, offset });
        }
      });

      const rawText = rawCharacters.join("");
      const exactStart = rawText.indexOf(segment.text);
      let startPoint: { node: Text; offset: number } | undefined;
      let endPoint: { node: Text; offset: number } | undefined;

      if (exactStart >= 0) {
        startPoint = rawPoints[exactStart];
        endPoint = rawPoints[exactStart + segment.text.length - 1];
        console.log("[voice-sync] SEGMENT MATCH", {
          messageId,
          segmentIndex: segment.segment_index,
          match: "exact",
        });
      } else {
        const normalizedSource = normalizeVoiceChars(rawText);
        const normalizedTarget = normalizeComparableText(segment.text);
        const normalizedStart = normalizedTarget
          ? normalizedSource.text.indexOf(normalizedTarget)
          : -1;
        if (normalizedStart >= 0) {
          const sourceStart = normalizedSource.map[normalizedStart];
          const sourceEnd =
            normalizedSource.map[normalizedStart + normalizedTarget.length - 1];
          startPoint = rawPoints[sourceStart];
          endPoint = rawPoints[sourceEnd];
          console.log("[voice-sync] SEGMENT MATCH", {
            messageId,
            segmentIndex: segment.segment_index,
            match: "normalized",
          });
        }
      }

      if (!startPoint || !endPoint) {
        console.warn("[voice-sync] SEGMENT NOT FOUND", {
          messageId,
          segmentIndex: segment.segment_index,
          text: segment.text.slice(0, 120),
        });
        return;
      }

      const startOffset = Math.min(
        Math.max(startPoint.offset, 0),
        startPoint.node.length,
      );
      const endOffset = Math.min(
        Math.max(endPoint.offset + 1, 0),
        endPoint.node.length,
      );
      if (startPoint.node === endPoint.node && endOffset <= startOffset) return;

      const range = document.createRange();
      range.setStart(startPoint.node, startOffset);
      range.setEnd(endPoint.node, endOffset);
      voiceHighlightRangeRef.current = range;
      renderVoiceOverlayRects();

      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      if (!rects.length) return;
      console.log("[voice-sync] HIGHLIGHT APPLIED", {
        messageId,
        segmentIndex: segment.segment_index,
        rectCount: rects.length,
      });

      const firstRect = rects[0];
      const scrollContainer =
        messageContainer?.closest<HTMLElement>(".messages-area");
      const containerRect = scrollContainer?.getBoundingClientRect();
      if (
        firstRect &&
        scrollContainer &&
        containerRect &&
        (firstRect.top < containerRect.top ||
          firstRect.bottom > containerRect.bottom)
      ) {
        startPoint.node.parentElement?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    },
    [clearVoiceHighlight, normalizeComparableText, renderVoiceOverlayRects],
  );

  const setVoiceLevel = useCallback((level: number) => {
    const normalizedLevel = Math.min(1, Math.max(0, level));
    voiceLevelRef.current = normalizedLevel;
    const layer = voiceHighlightLayerRef.current;
    if (!layer) return;
    layer
      .querySelectorAll<HTMLElement>(".teacher-voice-overlay")
      .forEach((highlight) => {
        highlight.style.setProperty("--voice-level", String(normalizedLevel));
      });
  }, []);

  const ensureAudioAnalyser = useCallback(() => {
    const audio = voiceAudioRef.current;
    if (!audio) return null;
    if (
      audioContextRef.current &&
      analyserRef.current &&
      mediaSourceRef.current
    ) {
      return audioContextRef.current;
    }

    try {
      audio.crossOrigin = "anonymous";
      const AudioContextConstructor = window.AudioContext;
      if (!AudioContextConstructor) return null;

      const audioContext =
        audioContextRef.current ?? new AudioContextConstructor();
      if (!audioContextRef.current) {
        audioContextRef.current = audioContext;
        console.log("[voice-sync] AUDIO CONTEXT CREATED");
      }

      const mediaSource =
        mediaSourceRef.current ?? audioContext.createMediaElementSource(audio);
      const analyser = analyserRef.current ?? audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      mediaSource.connect(analyser);
      analyser.connect(audioContext.destination);
      mediaSourceRef.current = mediaSource;
      analyserRef.current = analyser;
      analyserDataRef.current = new Uint8Array(
        new ArrayBuffer(analyser.frequencyBinCount),
      );
      console.log("[voice-sync] ANALYSER CONNECTED");
      return audioContext;
    } catch (error) {
      console.error("[voice-sync] ANALYSER CORS ERROR", error);
      return null;
    }
  }, []);

  const stopAnalyser = useCallback(() => {
    if (analyserFrameRef.current !== null) {
      cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
      console.log("[voice-sync] ANALYSER STOP");
    }
    setVoiceLevel(0);
  }, [setVoiceLevel]);

  const startAnalyser = useCallback(() => {
    const analyser = analyserRef.current;
    const dataArray = analyserDataRef.current;
    if (!analyser || !dataArray || analyserFrameRef.current !== null) return;

    console.log("[voice-sync] ANALYSER START");
    const readLevel = (timestamp: number) => {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (const sample of dataArray) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      const level = Math.min(1, Math.sqrt(sumSquares / dataArray.length) * 2.4);
      setVoiceLevel(level);
      if (timestamp - analyserLastLogRef.current > 400) {
        analyserLastLogRef.current = timestamp;
        console.log("[voice-sync] ANALYSER VALUE", {
          level: Number(level.toFixed(3)),
          segmentIndex: voiceIndexRef.current,
        });
      }
      analyserFrameRef.current = requestAnimationFrame(readLevel);
    };
    analyserFrameRef.current = requestAnimationFrame(readLevel);
  }, [setVoiceLevel]);

  const stopTeacherVoice = useCallback(() => {
    voiceRunIdRef.current += 1;
    voiceAbortControllerRef.current?.abort();
    voiceAbortControllerRef.current = null;
    voicePlaybackCancelRef.current?.();
    voicePlaybackCancelRef.current = null;
    const audio = voiceAudioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute("src");
      audio.load();
    }
    if (voiceObjectUrlRef.current) {
      URL.revokeObjectURL(voiceObjectUrlRef.current);
      voiceObjectUrlRef.current = null;
    }
    voiceIndexRef.current = 0;
    stopAnalyser();
    setIsVoiceLoading(false);
    setIsVoicePlaying(false);
    setActiveVoiceSegment(null);
    setActiveVoiceMessageId(null);
    activeVoiceMessageIdRef.current = null;
    setVoiceUiState(voiceReplyEnabledRef.current ? "ready" : "idle");
    clearVoiceHighlight();
  }, [clearVoiceHighlight, stopAnalyser]);

  const playVoiceSegments = useCallback(
    async (segments: VoiceSegment[], startIndex = 0) => {
      const audio = voiceAudioRef.current;
      if (!audio || !segments.length) return;

      const audioContext = ensureAudioAnalyser();
      if (audioContext?.state === "suspended") {
        try {
          await audioContext.resume();
          console.log("[voice-sync] AUDIO CONTEXT RESUMED");
        } catch (error) {
          console.warn("[voice-sync] AUDIO CONTEXT RESUME FAILED", error);
        }
      }

      const runId = ++voiceRunIdRef.current;
      voiceIndexRef.current = startIndex;
      voiceTimelineSegmentRef.current = null;

      setVoiceUiState("thinking");
      setActiveVoiceSegment(segments[startIndex]?.segment_index ?? null);

      try {
        for (let index = startIndex; index < segments.length; index += 1) {
          const segment = segments[index];
          if (runId !== voiceRunIdRef.current || !voiceReplyEnabledRef.current)
            return;
          if (!segment.audio_url) {
            console.warn("[voice-sync] AUDIO URL MISSING", {
              segmentIndex: segment.segment_index,
            });
            continue;
          }

          voiceIndexRef.current = index;
          setActiveVoiceSegment(segment.segment_index);
          setVoiceLevel(0);
          audio.src = segment.audio_url;
          audio.currentTime = 0;
          audio.load();
          console.log("[voice-sync] PLAY", {
            segmentIndex: segment.segment_index,
            text: segment.text.slice(0, 120),
            startTimeMs: segment.start_time_ms,
            endTimeMs: segment.end_time_ms,
          });

          const completed = await new Promise<boolean>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
              audio.removeEventListener("play", onPlay);
              audio.removeEventListener("pause", onPause);
              audio.removeEventListener("ended", onEnded);
              audio.removeEventListener("error", onError);
              audio.removeEventListener("timeupdate", onTimeUpdate);
              voicePlaybackCancelRef.current = null;
            };
            const finish = (value: boolean) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(value);
            };
            const fail = (message: string) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error(message));
            };
            const onPlay = () => {
              console.log("[voice-chat] AUDIO PLAY", {
                segmentIndex: segment.segment_index,
              });
              setIsVoicePlaying(true);
              setVoiceUiState("speaking");
              startAnalyser();
            };
            const onPause = () => {
              if (!settled) {
                setIsVoicePlaying(false);
                setVoiceUiState("paused");
                stopAnalyser();
                clearVoiceHighlight();
                console.log("[voice-sync] PAUSE", {
                  segmentIndex: segment.segment_index,
                });
              }
            };
            const onEnded = () => {
              console.log("[voice-chat] AUDIO ENDED", {
                segmentIndex: segment.segment_index,
              });
              stopAnalyser();
              clearVoiceHighlight();
              finish(true);
            };
            const onError = () => {
              console.error("[voice-sync] AUDIO ERROR", {
                segmentIndex: segment.segment_index,
                src: audio.src,
              });
              fail("تعذر تشغيل الصوت.");
            };
            const onTimeUpdate = () => {
              const currentTimeMs =
                segment.start_time_ms + audio.currentTime * 1000;
              const timedSegment = segments.find(
                (candidate) =>
                  currentTimeMs >= candidate.start_time_ms &&
                  currentTimeMs < candidate.end_time_ms,
              );
              if (
                !timedSegment ||
                voiceTimelineSegmentRef.current === timedSegment.segment_index
              )
                return;
              voiceTimelineSegmentRef.current = timedSegment.segment_index;
              console.log("[voice-sync] ACTIVE SEGMENT", {
                messageId: activeVoiceMessageIdRef.current,
                segmentIndex: timedSegment.segment_index,
                currentTimeMs,
                startTimeMs: timedSegment.start_time_ms,
                endTimeMs: timedSegment.end_time_ms,
              });
              setActiveVoiceSegment(timedSegment.segment_index);
            };

            voicePlaybackCancelRef.current = () => finish(false);
            audio.addEventListener("play", onPlay);
            audio.addEventListener("pause", onPause);
            audio.addEventListener("ended", onEnded);
            audio.addEventListener("error", onError);
            audio.addEventListener("timeupdate", onTimeUpdate);

            void audio.play().catch((error: unknown) => {
              if (
                error instanceof DOMException &&
                error.name === "NotAllowedError"
              ) {
                console.warn("[voice-chat] AUDIO AUTOPLAY BLOCKED");
                setVoiceError("تعذر تشغيل صوت المدرس.");

                setVoiceUiState("error");
                setIsVoicePlaying(false);
                setActiveVoiceSegment(null);
                clearVoiceHighlight();
                stopAnalyser();
                finish(false);
                return;
              }
              fail("تعذر تشغيل الصوت.");
            });
          });

          if (!completed || runId !== voiceRunIdRef.current) return;
        }

        console.log("[voice-sync] ENDED");
        clearVoiceHighlight();
        voiceIndexRef.current = 0;
        setActiveVoiceSegment(null);
        setIsVoicePlaying(false);

        setVoiceUiState("ready");
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      } catch (error) {
        if (runId === voiceRunIdRef.current) {
          setVoiceError(getErrorMessage(error));
          setIsVoicePlaying(false);

          setVoiceUiState("error");
        }
      }
    },
    [
      clearVoiceHighlight,
      ensureAudioAnalyser,
      setVoiceLevel,
      startAnalyser,
      stopAnalyser,
    ],
  );

  const generateTeacherVoice = useCallback(
    async ({
      text,
      documentId,
      sectionId,
      conversationId: responseConversationId,
      messageId,
      explanationCacheId: responseExplanationCacheId,
      enabled = true,
    }: {
      text: string;
      documentId: string | null;
      sectionId: string | null;
      conversationId?: string | null;
      messageId?: string | null;
      explanationCacheId?: string | null;
      enabled?: boolean;
    }) => {
      console.log("[frontend] generateTeacherVoice CALLED", {
        textLength: text?.length ?? 0,
        documentId,
        sectionId,
        conversationId: responseConversationId,
        messageId,
        explanationCacheId: responseExplanationCacheId,
        voiceReplyEnabled,
      });

      if (!text.trim() || !supabase || !supabaseUrl || !supabaseKey) return;

      const runId = ++voiceRunIdRef.current;
      voiceAbortControllerRef.current?.abort();
      const controller = new AbortController();
      voiceAbortControllerRef.current = controller;
      setIsVoiceLoading(true);
      setVoiceError("");

      setVoiceUiState("thinking");
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, voice_loading: true }
            : message,
        ),
      );

      try {
        const sessionResult = await supabase.auth.getSession();
        const accessToken =
          sessionResult.data.session?.access_token || supabaseKey;
        console.log("[voice-sync] REQUEST", {
          documentId,
          sectionId,
          conversationId: responseConversationId,
          messageId,
          explanationCacheId: responseExplanationCacheId,
          enabled,
          mode: "sync",
          cache: true,
        });
        const response = await fetch(
          `${supabaseUrl}/functions/v1/teacher-voice`,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              apikey: supabaseKey,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              text,
              document_id: documentId,
              section_id: sectionId,
              conversation_id: responseConversationId || null,
              message_id: messageId || null,
              explanation_cache_id: responseExplanationCacheId || null,
              enabled,
              sync: true,
              cache: true,
              voice: "marin",
              format: "mp3",
              speed: 1,
            }),
          },
        );

        const rawResponse = await response.text();
        let data: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(rawResponse);
          if (isRecord(parsed)) data = parsed;
        } catch {
          if (!response.ok)
            throw new Error(rawResponse || `HTTP ${response.status}`);
        }

        if (!response.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : rawResponse || `HTTP ${response.status}`,
          );
        }
        console.log(
          data.cached === true
            ? "[voice-sync] CACHE HIT"
            : "[voice-sync] CACHE MISS",
          {
            messageId,
            segmentCount: Array.isArray(data.segments)
              ? data.segments.length
              : 0,
          },
        );
        if (runId !== voiceRunIdRef.current) return;
        if (data.success !== true)
          throw new Error(
            typeof data.error === "string" ? data.error : "لم يتم إنشاء الصوت.",
          );

        const nextSegments = Array.isArray(data.segments)
          ? data.segments
              .filter(
                (segment): segment is VoiceSegment =>
                  isRecord(segment) &&
                  typeof segment.text === "string" &&
                  typeof segment.segment_index === "number" &&
                  typeof segment.start_time_ms === "number" &&
                  typeof segment.end_time_ms === "number" &&
                  typeof segment.audio_url === "string",
              )
              .sort((a, b) => a.segment_index - b.segment_index)
          : [];

        if (!nextSegments.length) {
          console.warn("[voice-sync] NO SEGMENTS", data);
          setVoiceError("تعذر تشغيل صوت المدرس.");
          setIsVoiceLoading(false);

          setVoiceUiState("error");
          return;
        }
        voiceSegmentsRef.current = nextSegments;
        setVoiceSegments(nextSegments);
        console.log("[voice-sync] READY", { segments: nextSegments.length });
        voiceSegmentsRef.current = nextSegments;

        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  voice_segments: nextSegments,
                  voice_ready: true,
                  voice_loading: false,
                }
              : message,
          ),
        );
        setIsVoiceLoading(false);
        await playVoiceSegments(nextSegments);
      } catch (error) {
        if (controller.signal.aborted || runId !== voiceRunIdRef.current)
          return;
        setVoiceError("تعذر تشغيل الرد الصوتي.");
        setIsVoiceLoading(false);

        setVoiceUiState("error");
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? { ...message, voice_loading: false }
              : message,
          ),
        );
      } finally {
        if (voiceAbortControllerRef.current === controller)
          voiceAbortControllerRef.current = null;
      }
    },
    [voiceReplyEnabled, playVoiceSegments],
  );

  const clearVoiceContext = useCallback(() => {
    stopTeacherVoice();
    voiceSegmentsRef.current = [];
    voiceAnswerRef.current = null;
    setVoiceSegments([]);
    setActiveVoiceSegment(null);
    setActiveVoiceMessageId(null);
    activeVoiceMessageIdRef.current = null;
    setVoiceUiState(voiceReplyEnabledRef.current ? "ready" : "idle");
    setVoiceError("");
  }, [stopTeacherVoice]);

  const activateVoiceReply = useCallback(() => {
    setVoiceReplyEnabled(true);
    setVoiceUiState("ready");
  }, []);

  const deactivateVoiceReply = useCallback(() => {
    stopTeacherVoice();
    setVoiceReplyEnabled(false);
    setVoiceUiState("idle");
  }, [stopTeacherVoice]);

  const resetVoiceChat = useCallback(() => {
    clearVoiceContext();
    deactivateVoiceReply();
  }, [clearVoiceContext, deactivateVoiceReply]);

  const openSavedLesson = useCallback(
    (lesson: SavedLesson) => {
      console.log("[study] SAVED MATERIAL SELECTED", {
        explanationCacheId: lesson.id,
        documentId: lesson.document_id,
        sectionId: lesson.section_id,
      });
      setStudyMode("saved");
      setSelectedDocumentId(lesson.document_id);
      setSelectedSectionId(lesson.section_id);
      setTopic("");
      setMessages([]);
      setConversationId(null);
      clearAttachedImage();
      clearMessageImageUrls();
      resetVoiceChat();
      console.log("[study] OPEN SAVED LESSON", {
        explanationCacheId: lesson.id,
      });
    },
    [clearAttachedImage, clearMessageImageUrls, resetVoiceChat],
  );

  const replayVoice = useCallback(() => {
    if (
      !voiceReplyEnabledRef.current ||
      isVoiceLoading ||
      !voiceSegmentsRef.current.length
    )
      return;
    setVoiceError("");
    void playVoiceSegments(voiceSegmentsRef.current);
  }, [isVoiceLoading, playVoiceSegments]);

  const pauseVoice = useCallback(() => {
    voiceAudioRef.current?.pause();
  }, []);

  const resumeVoice = useCallback(() => {
    const audio = voiceAudioRef.current;
    if (!audio || !voiceSegmentsRef.current.length) return;
    void audio.play().catch(() => {
      setVoiceError("اضغط تشغيل الصوت للسماح بالقراءة الصوتية.");
    });
  }, []);

  const seekVoiceSegment = useCallback(
    (segmentIndex: number) => {
      if (!voiceReplyEnabledRef.current || isVoiceLoading) return;
      const index = voiceSegmentsRef.current.findIndex(
        (segment) => segment.segment_index === segmentIndex,
      );
      if (index < 0) return;
      setVoiceError("");
      void playVoiceSegments(voiceSegmentsRef.current, index);
    },
    [isVoiceLoading, playVoiceSegments],
  );

  const handleTeacherMarkdownClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const messageContainer = event.currentTarget.closest<HTMLElement>(
        "[data-assistant-message-id]",
      );
      if (
        !voiceReplyEnabledRef.current ||
        messageContainer?.dataset.assistantMessageId !==
          activeVoiceMessageIdRef.current
      )
        return;
      const text =
        event.target instanceof HTMLElement
          ? event.target.textContent || ""
          : "";
      if (!text.trim()) return;
      const segment = voiceSegmentsRef.current.find((voiceSegment) =>
        normalizeComparableText(text).includes(
          normalizeComparableText(voiceSegment.text),
        ),
      );
      if (segment) seekVoiceSegment(segment.segment_index);
    },
    [normalizeComparableText, seekVoiceSegment],
  );

  useEffect(() => {
    voiceSegmentsRef.current = voiceSegments;
  }, [voiceSegments]);

  useEffect(() => {
    voiceReplyEnabledRef.current = voiceReplyEnabled;
    if (!voiceReplyEnabled) stopTeacherVoice();
  }, [voiceReplyEnabled, stopTeacherVoice]);

  useEffect(() => {
    resetVoiceChat();
    clearAttachedImage(false);
    clearMessageImageUrls();
    setMessages([
      {
        id: selectedSectionId
          ? `teacher-greeting-${selectedSectionId}`
          : "teacher-greeting-general",
        role: "assistant",
        content: selectedSectionId
          ? "أنا جاهز، اسألني عن الدرس."
          : "أنا مدرّسك الذكي. اسأل عن أي شيء، ويمكنك إرفاق صورة.",
        created_at: new Date().toISOString(),
      },
    ]);
    setConversationId(null);
  }, [
    clearAttachedImage,
    clearMessageImageUrls,
    resetVoiceChat,
    selectedDocumentId,
    selectedSectionId,
  ]);

  useEffect(() => {
    if (
      !voiceReplyEnabled ||
      !isVoicePlaying ||
      !activeVoiceMessageId ||
      activeVoiceSegment == null
    ) {
      clearVoiceHighlight();
      return;
    }
    const segment = voiceSegmentsRef.current.find(
      (item) => item.segment_index === activeVoiceSegment,
    );
    if (segment) highlightVoiceSegment(segment);
  }, [
    activeVoiceMessageId,
    activeVoiceSegment,
    clearVoiceHighlight,
    highlightVoiceSegment,
    isVoicePlaying,
    voiceReplyEnabled,
  ]);

  useEffect(() => {
    if (!activeVoiceMessageId || !voiceReplyEnabled) return;
    const containers = chatPanelRef.current?.querySelectorAll<HTMLElement>(
      "[data-assistant-message-id]",
    );
    const messageContainer = Array.from(containers ?? []).find(
      (container) =>
        container.dataset.assistantMessageId === activeVoiceMessageId,
    );
    const scrollContainer =
      messageContainer?.closest<HTMLElement>(".messages-area");
    if (!scrollContainer) return;

    const reposition = () => renderVoiceOverlayRects();
    window.addEventListener("resize", reposition);
    scrollContainer.addEventListener("scroll", reposition, { passive: true });
    return () => {
      window.removeEventListener("resize", reposition);
      scrollContainer.removeEventListener("scroll", reposition);
    };
  }, [
    activeVoiceMessageId,
    activeVoiceSegment,
    renderVoiceOverlayRects,
    voiceReplyEnabled,
  ]);

  useEffect(() => {
    return () => {
      stopTeacherVoice();
      stopAnalyser();
      mediaSourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      mediaSourceRef.current = null;
      analyserRef.current = null;
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
      voiceHighlightLayerRef.current?.replaceChildren();
    };
  }, [stopAnalyser, stopTeacherVoice]);

  const sendMessage = useCallback(
    async (
      content: string,
      inputSource: "text" | "voice" = "text",
      target: "text" | "voice" = voiceReplyEnabled ? "voice" : "text",
    ) => {
      const imageDataUrl = attachedImageDataUrl;
      const trimmed =
        content.trim() || (imageDataUrl ? "حل وفسّر ما في الصورة." : "");

      if (
        (!trimmed && !imageDataUrl) ||
        !supabase ||
        isAskingRef.current ||
        isImageProcessing ||
        Boolean(attachedImage && !imageDataUrl)
      ) {
        return;
      }

      isAskingRef.current = true;
      setIsSendingImage(Boolean(imageDataUrl));
      setImageError("");
      clearVoiceContext();
      if (target === "voice") {
        setVoiceUiState("thinking");
      }
      setIsAsking(true);
      setError("");
      setQuestion("");

      const imagePreviewUrl = attachedImage
        ? URL.createObjectURL(attachedImage)
        : undefined;
      if (imagePreviewUrl) messageImageUrlsRef.current.add(imagePreviewUrl);
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        ...(imagePreviewUrl ? { image_preview_url: imagePreviewUrl } : {}),
        created_at: new Date().toISOString(),
        input_source: inputSource,
      };

      const streamingMessageId = crypto.randomUUID();
      let assistantMessageId: string | null = null;
      const assistantMessage: Message = {
        id: streamingMessageId,
        role: "assistant",
        content: "",
        voice_only: target === "voice",
        sources: [],
        created_at: new Date().toISOString(),
      };

      const updateMessages = setMessages;
      updateMessages((current) => [...current, userMessage, assistantMessage]);
      if (imageDataUrl) clearAttachedImage(false);
      const messagesEndTargetRef = messagesEndRef;

      const teacherChatQuestion = trimmed;
      let accumulatedText = "";
      let finalSources: Source[] = [];
      let finalConversationId = conversationId;
      let finalExplanationCacheId: string | null = null;
      let finalExplanationCached = false;
      let streamError = "";

      const conversationHistory = [...messages, userMessage]
        .sort(
          (left, right) =>
            Date.parse(left.created_at || "") -
            Date.parse(right.created_at || ""),
        )
        .filter(
          (message) => message.role === "user" || message.role === "assistant",
        )
        .slice(-10)
        .map((message) => {
          const historyMessage = { ...message };
          delete historyMessage.voice_only;
          return historyMessage;
        });

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const patchAssistant = (patch: Partial<Message>) => {
        updateMessages((current) =>
          current.map((message) =>
            message.id === streamingMessageId
              ? { ...message, ...patch }
              : message,
          ),
        );
      };

      const appendDelta = (delta: string) => {
        if (!delta) return;

        accumulatedText += delta;
        patchAssistant({ content: accumulatedText });

        requestAnimationFrame(() => {
          messagesEndTargetRef.current?.scrollIntoView({
            behavior: "auto",
            block: "end",
          });
        });
      };

      const updateStreamMetadata = (event: Record<string, unknown>) => {
        if (typeof event.conversation_id === "string") {
          finalConversationId = event.conversation_id;
        }

        if (Array.isArray(event.sources)) {
          finalSources = event.sources as Source[];
        }

        const eventMessageId = extractAssistantMessageId(event);
        if (eventMessageId) {
          assistantMessageId = eventMessageId;
        }

        const eventExplanationCacheId = extractExplanationCacheId(event);
        if (eventExplanationCacheId) {
          finalExplanationCacheId = eventExplanationCacheId;
        }

        const eventExplanationCached = extractBooleanField(event, [
          "explanation_cached",
          "cache_hit",
          "cached",
        ]);
        if (eventExplanationCached === true) {
          finalExplanationCached = true;
        }

        if (typeof event.error === "string") {
          streamError = event.error;
        }
      };

      try {
        if (!supabaseUrl || !supabaseKey) {
          throw new Error("إعدادات Supabase غير متاحة.");
        }

        const sessionResult = await supabase.auth.getSession();
        const accessToken =
          sessionResult.data.session?.access_token || supabaseKey;

        const teacherChatPayload = buildTeacherChatPayload({
          question: teacherChatQuestion,
          documentId: selectedDocumentId,
          sectionId: selectedSectionId,
          conversationId,
          conversationHistory,
          inputSource,
          imageDataUrl,
        });
        console.log("[teacher-chat-ui] CHAT REQUEST", {
          inputSource,
          documentId: selectedDocumentId,
          sectionId: selectedSectionId,
          conversationId,
          hasImage: Boolean(imageDataUrl),
        });
        if (imageDataUrl) {
          console.log("[teacher-chat-ui] IMAGE REQUEST", {
            mimeType: attachedImage?.type,
            size: attachedImage?.size,
          });
        }
        const response = await fetch(
          `${supabaseUrl}/functions/v1/teacher-chat`,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              apikey: supabaseKey,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(teacherChatPayload),
          },
        );

        if (!response.ok) {
          const rawError = await response.text();
          let message = `HTTP ${response.status}`;

          try {
            const parsed = JSON.parse(rawError) as {
              error?: string;
              message?: string;
            };

            message = parsed.error || parsed.message || message;
          } catch {
            if (rawError.trim()) {
              message = rawError.trim();
            }
          }

          throw new Error(`فشل الاتصال بالمدرس الذكي: ${message}`);
        }

        await readTeacherStream(response, {
          onDelta: appendDelta,
          onMeta: updateStreamMetadata,
          onDone: (event) => {
            if (event) {
              updateStreamMetadata(event);
            }
          },
          onError: (message) => {
            streamError = message;
          },
        });

        if (streamError) {
          throw new Error(streamError);
        }

        console.log("[frontend] STREAM MESSAGE ID", {
          streamingMessageId,
          assistantMessageId,
        });

        console.log("[frontend-stream DONE]", {
          accumulatedLength: accumulatedText.length,
        });

        const finalAssistantAnswer = accumulatedText;
        console.log("[teacher-chat-ui] CHAT COMPLETE", {
          conversationId: finalConversationId,
          messageId: assistantMessageId,
          answerLength: finalAssistantAnswer.length,
        });
        if (!finalAssistantAnswer.trim()) {
          throw new Error("لم يصل محتوى من المدرس الذكي.");
        }
        const resolvedAssistantMessageId = assistantMessageId;

        setConversationId(finalConversationId);
        if (target === "voice") {
          console.log("[voice-chat] TEACHER CHAT COMPLETE", {
            conversationId: finalConversationId,
            messageId: assistantMessageId,
            assistantMessageId,
            answerLength: accumulatedText.length,
          });
        }
        if (
          inputSource === "text" &&
          !voiceReplyEnabled &&
          selectedDocumentId &&
          selectedSectionId &&
          finalExplanationCacheId
        ) {
          setStudyExplanation({
            id: finalExplanationCacheId,
            answer_markdown: finalAssistantAnswer,
            document_id: selectedDocumentId,
            section_id: selectedSectionId,
            status: "ready",
          });
          setExplanationCached(true);
          console.log("[study] EXPLANATION CACHE HIT", {
            explanationCacheId: finalExplanationCacheId,
            source: "teacher-chat",
          });
        }
        patchAssistant({
          ...(resolvedAssistantMessageId
            ? { id: resolvedAssistantMessageId }
            : {}),
          content: finalAssistantAnswer,
          sources: finalSources,
          explanation_cache_id: finalExplanationCacheId,
          explanation_cached: finalExplanationCached,
        });

        if (
          target === "voice" &&
          voiceReplyEnabled &&
          finalAssistantAnswer.trim() &&
          finalConversationId &&
          assistantMessageId
        ) {
          try {
            voiceAnswerRef.current = {
              text: finalAssistantAnswer,
              documentId: selectedDocumentId,
              sectionId: selectedSectionId,
              conversationId: finalConversationId,
              messageId: resolvedAssistantMessageId,
            };
            setActiveVoiceMessageId(resolvedAssistantMessageId);
            activeVoiceMessageIdRef.current = resolvedAssistantMessageId;
            console.log("[voice-sync] ASSISTANT MESSAGE SET", {
              messageId: resolvedAssistantMessageId,
            });
            console.log("[voice-chat] TEACHER VOICE REQUEST", {
              messageId: resolvedAssistantMessageId,
              conversationId: finalConversationId,
              sectionId: selectedSectionId,
            });
            await generateTeacherVoice({
              text: finalAssistantAnswer,
              documentId: selectedDocumentId,
              sectionId: selectedSectionId,
              conversationId: finalConversationId,
              messageId: resolvedAssistantMessageId,
              explanationCacheId: null,
              enabled: true,
            });
            console.log("[voice-chat] TEACHER VOICE SUCCESS", {
              messageId: resolvedAssistantMessageId,
            });
          } catch (voiceError) {
            console.warn("[voice-chat] ERROR", voiceError);
            setVoiceError("تعذر تشغيل صوت المدرس.");
            setVoiceUiState("error");
          }
        } else if (target === "voice" && voiceReplyEnabled) {
          setVoiceError("تعذر تشغيل صوت المدرس.");
          setVoiceUiState("error");
        }
      } catch (requestError) {
        updateMessages((current) =>
          current.filter((message) => message.id !== streamingMessageId),
        );

        if (
          requestError instanceof DOMException &&
          requestError.name === "AbortError"
        ) {
          return;
        }
        if (imageDataUrl) {
          console.error("[teacher-chat-ui] IMAGE ERROR", requestError);
          setImageError("تعذر إرسال الصورة.");
        }

        if (target === "voice") {
          setVoiceUiState("error");
        }
        setError(
          target === "voice"
            ? "تعذر الحصول على إجابة المدرس."
            : requestError instanceof Error
              ? requestError.message
              : "حدث خطأ أثناء الاتصال بالمدرس الذكي.",
        );
      } finally {
        abortControllerRef.current = null;
        isAskingRef.current = false;
        setIsAsking(false);
        setIsSendingImage(false);

        requestAnimationFrame(() => {
          messagesEndTargetRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "end",
          });

          questionInputRef.current?.focus();
        });
      }
    },
    [
      conversationId,
      attachedImage,
      attachedImageDataUrl,
      clearAttachedImage,
      clearVoiceContext,
      generateTeacherVoice,
      isImageProcessing,
      voiceReplyEnabled,
      messages,
      selectedDocumentId,
      selectedSectionId,
      studyExplanation,
      setIsSendingImage,
    ],
  );

  function askTeacher(event: FormEvent) {
    event.preventDefault();
    void sendMessage(question, "text", voiceReplyEnabled ? "voice" : "text");
  }

  const clearRecordingPreview = useCallback(() => {
    if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
    setRecordedAudioUrl("");
    setRecordedAudioBlob(null);
    recordingDurationRef.current = 0;
    setRecordingDuration(0);
  }, [recordedAudioUrl]);

  const stopRecording = useCallback((cancelled = false) => {
    recordingCancelledRef.current = cancelled;
    recordingAutoSubmitRef.current = !cancelled;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    isRecordingRef.current = false;
    setIsRecording(false);
    console.log("[voice-chat] RECORDING STOP", { cancelled });
  }, []);

  const startRecording = useCallback(async () => {
    if (
      isRecordingRef.current ||
      isTranscribing ||
      isAsking ||
      isImageProcessing
    )
      return;
    clearRecordingPreview();
    setRecordingError("");

    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setRecordingError("المتصفح لا يدعم تسجيل الصوت.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = MediaRecorder.isTypeSupported(
        "audio/webm;codecs=opus",
      )
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);
      recordingChunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingCancelledRef.current = false;
      recordingAutoSubmitRef.current = false;
      isRecordingRef.current = true;
      setIsRecording(true);
      recordingDurationRef.current = 0;
      setRecordingDuration(0);
      console.log("[voice-chat] RECORDING START", {
        mimeType: recorder.mimeType,
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (recordingCancelledRef.current) {
          recordingChunksRef.current = [];
          clearRecordingPreview();

          return;
        }
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const url = URL.createObjectURL(blob);
        setRecordedAudioBlob(blob);
        setRecordedAudioUrl(url);
        console.log("[voice-chat] RECORDING READY", {
          bytes: blob.size,
          type: blob.type,
          autoSubmit: recordingAutoSubmitRef.current,
        });
      };
      recorder.start();
      recordingTimerRef.current = window.setInterval(() => {
        const next = Math.min(recordingDurationRef.current + 1, 60);
        recordingDurationRef.current = next;
        setRecordingDuration(next);
        if (next >= 60) {
          recordingAutoSubmitRef.current = true;
          stopRecording();
        }
      }, 1000);
    } catch (error) {
      console.error("[voice-chat] ERROR", error);
      setRecordingError(
        "اسمح للمتصفح باستخدام الميكروفون حتى تتمكن من التحدث مع المدرس.",
      );
    }
  }, [
    clearRecordingPreview,
    isAsking,
    isImageProcessing,
    isTranscribing,
    stopRecording,
  ]);

  function explainTopic() {
    if (
      !topic.trim() ||
      !selectedDocumentId ||
      !selectedSectionId ||
      isAsking ||
      explanationCached
    )
      return;
    const generatedQuestion = `اشرح لي موضوع "${topic.trim()}" من درس "${selectedSection?.title || "الدرس المحدد"}".`;
    void sendMessage(
      generatedQuestion,
      "text",
      voiceReplyEnabled ? "voice" : "text",
    );
  }

  const previewRecording = useCallback(() => {
    const audio = voiceAudioRef.current;
    if (!audio || !recordedAudioUrl) return;
    audio.src = recordedAudioUrl;
    audio.currentTime = 0;
    audio.load();
    void audio
      .play()
      .catch(() => setRecordingError("اضغط تشغيل للسماح بمعاينة التسجيل."));
  }, [recordedAudioUrl]);

  const sendVoiceRecording = useCallback(async () => {
    if (
      !recordedAudioBlob ||
      !supabaseUrl ||
      !supabaseKey ||
      isTranscribing ||
      isAsking ||
      isImageProcessing
    )
      return;

    setIsTranscribing(true);
    setRecordingError("");
    console.log("[voice-chat] TRANSCRIBE REQUEST", {
      bytes: recordedAudioBlob.size,
      type: recordedAudioBlob.type,
      documentId: selectedDocumentId,
      sectionId: selectedSectionId,
    });
    const controller = new AbortController();
    transcribeAbortControllerRef.current = controller;

    try {
      const sessionResult = await supabase?.auth.getSession();
      const accessToken =
        sessionResult?.data.session?.access_token || supabaseKey;
      const formData = new FormData();
      formData.append("audio", recordedAudioBlob, "voice-question.webm");
      formData.append("document_id", selectedDocumentId || "");
      formData.append("section_id", selectedSectionId || "");
      formData.append("conversation_id", conversationId || "");

      const response = await fetch(
        `${supabaseUrl}/functions/v1/teacher-transcribe`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: supabaseKey,
          },
          body: formData,
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        transcript?: string;
        text?: string;
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(payload?.error || `HTTP ${response.status}`);
      const transcript = (payload?.transcript || payload?.text || "").trim();
      if (!transcript) throw new Error("empty transcript");

      setIsTranscribing(false);
      console.log("[voice-chat] TRANSCRIBE SUCCESS", {
        length: transcript.length,
      });
      clearRecordingPreview();
      void sendMessage(
        transcript,
        "voice",
        voiceReplyEnabled ? "voice" : "text",
      );
    } catch (requestError) {
      if (!controller.signal.aborted) {
        console.error("[voice-chat] ERROR", requestError);
        setRecordingError("تعذر فهم التسجيل الصوتي.");
      }
    } finally {
      if (transcribeAbortControllerRef.current === controller)
        transcribeAbortControllerRef.current = null;
      setIsTranscribing(false);
    }
  }, [
    conversationId,
    clearRecordingPreview,
    isAsking,
    isTranscribing,
    recordedAudioBlob,
    selectedDocumentId,
    selectedSectionId,
    isImageProcessing,
    sendMessage,
    voiceReplyEnabled,
  ]);

  useEffect(() => {
    return () => {
      if (attachedImageUrlRef.current)
        URL.revokeObjectURL(attachedImageUrlRef.current);
      for (const url of messageImageUrlsRef.current) URL.revokeObjectURL(url);
      messageImageUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!recordingAutoSubmitRef.current || !recordedAudioBlob) return;
    recordingAutoSubmitRef.current = false;
    void sendVoiceRecording();
  }, [recordedAudioBlob, sendVoiceRecording]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current !== null)
        window.clearInterval(recordingTimerRef.current);
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
    };
  }, [recordedAudioUrl]);

  const retryVoiceAnswer = useCallback(() => {
    const answer = voiceAnswerRef.current;
    if (!answer || isVoiceLoading || !voiceReplyEnabledRef.current) return;
    setVoiceError("");
    setVoiceUiState("thinking");
    void generateTeacherVoice({ ...answer, enabled: true });
  }, [generateTeacherVoice, isVoiceLoading]);

  const canWork = Boolean(supabase);
  const renderChatMessages = (
    chatMessages: Message[],
    replyMode: "text" | "voice",
  ) =>
    chatMessages
      .filter(
        (message) =>
          !(
            replyMode === "voice" &&
            ((message.role === "assistant" && message.voice_only) ||
              (message.input_source === "voice" && !message.image_preview_url))
          ),
      )
      .map((message, index) => (
        <article
          key={`${message.id || message.created_at || "message"}-${replyMode}-${index}`}
          className={`message ${message.role === "user" ? "user-message" : "assistant-message"}`}
        >
          <div className="message-avatar">
            {message.role === "user" ? (
              <IconUser size={16} />
            ) : (
              <IconBook2 size={16} />
            )}
          </div>
          <div className="message-body">
            <span className="message-role">
              {message.role === "user" ? "الطالب" : "المدرس"}
            </span>
            {message.role === "assistant" ? (
              <div
                data-assistant-message-id={message.id}
                className="teacher-assistant-message"
              >
                <div
                  className="teacher-markdown"
                  onClick={handleTeacherMarkdownClick}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {renderTeacherMarkdown(message.content)}
                  </ReactMarkdown>
                </div>
                {message.sources?.length ? (
                  <details className="sources">
                    <summary>عرض المصادر</summary>
                    <div className="sources-list">
                      {message.sources.map((source, sourceIndex) => (
                        <small key={sourceIndex}>
                          صفحة {source.page || source.page_number || "—"}
                          {source.title ? ` · ${source.title}` : ""}
                        </small>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : (
              <>
                {message.image_preview_url && (
                  <img
                    className="message-image-preview"
                    src={message.image_preview_url}
                    alt="صورة السؤال المرفقة"
                  />
                )}
                {message.content &&
                  !(
                    replyMode === "voice" && message.input_source === "voice"
                  ) && (
                    <p>
                      {message.input_source === "voice" && (
                        <span className="message-input-source">🎙️ </span>
                      )}
                      {message.content}
                    </p>
                  )}
              </>
            )}
          </div>
        </article>
      ));

  return (
    <main
      dir="rtl"
      className="teacher-app min-h-screen bg-[#f5f7f8] text-[#17323a]"
    >
      <header className="teacher-header border-b border-[#dce7e7] bg-[#fbfdfc]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="brand-mark">
              <IconBook2 size={22} stroke={1.8} />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                AI Teacher
              </h1>
              <p className="text-xs text-[#6b8184]">المدرس الذكي</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {userLabel && (
              <span className="hidden text-[#6b8184] sm:inline">
                مرحبًا، {userLabel}
              </span>
            )}
            <span
              className={`connection-status ${connection === "connected" ? "is-connected" : "is-disconnected"}`}
            >
              <span className="status-dot" />
              {connection === "connected" ? "متصل" : "غير متصل"}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <section className="mb-7 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="section-kicker">مساحة التعلم</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[#17323a]">
              اسأل المدرس الذكي
            </h2>
            <p className="panel-subtitle">اسأل عن أي شيء، ويمكنك إرفاق صورة.</p>
          </div>
          <button
            className="quiet-button"
            type="button"
            onClick={() => {
              abortControllerRef.current?.abort();
              transcribeAbortControllerRef.current?.abort();
              if (isRecordingRef.current) stopRecording(true);
              clearRecordingPreview();
              clearAttachedImage();
              clearMessageImageUrls();
              resetVoiceChat();
              setMessages([]);
              setConversationId(null);
              setQuestion("");
              setError("");
              setTopic("");
              setRecordingError("");
            }}
          >
            <IconRefresh size={16} /> محادثة جديدة
          </button>
        </section>

        <div
          className="study-mode-tabs"
          role="tablist"
          aria-label="وضع الدراسة"
        >
          <button
            className={studyMode === "new" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={studyMode === "new"}
            onClick={() => setStudyMode("new")}
          >
            درس جديد
          </button>
          <button
            className={studyMode === "saved" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={studyMode === "saved"}
            onClick={() => setStudyMode("saved")}
          >
            المواد المحفوظة
          </button>
        </div>

        {studyMode === "new" ? (
          <section className="control-panel" aria-label="اختيار المادة">
            <div className="control-field wide">
              <label htmlFor="book">الكتاب (اختياري)</label>
              <div className="select-wrap">
                <select
                  id="book"
                  value={selectedDocumentId ?? ""}
                  onChange={(event) => {
                    setSelectedDocumentId(event.target.value || null);
                    setSelectedSectionId(null);
                    clearVoiceContext();
                  }}
                >
                  <option value="">محادثة عامة (بدون كتاب)</option>
                  {books.map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.title} ·{" "}
                      {book.metadata?.grade || book.metadata?.stage || ""}
                    </option>
                  ))}
                </select>
                <IconChevronDown size={17} />
              </div>
            </div>
            <div className="control-field">
              <label htmlFor="section">الدرس (اختياري)</label>
              <div className="select-wrap">
                <select
                  id="section"
                  value={selectedSectionId ?? ""}
                  disabled={!selectedDocumentId || isLoadingSections}
                  onChange={(event) => {
                    setSelectedSectionId(event.target.value || null);
                    clearVoiceContext();
                  }}
                >
                  <option value="">اختر درسًا (اختياري)</option>
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.title}
                    </option>
                  ))}
                </select>
                <IconChevronDown size={17} />
              </div>
            </div>
            <p className="material-optional-note">
              اترك الكتاب والدرس فارغين لمحادثة عامة.
            </p>
            <div className="control-field topic-field">
              <label htmlFor="topic">الموضوع</label>
              <input
                id="topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="ماذا تريد أن تتعلم؟"
              />
              <button
                className="topic-action"
                type="button"
                disabled={
                  !canWork ||
                  !selectedSectionId ||
                  !topic.trim() ||
                  isAsking ||
                  explanationCached
                }
                onClick={explainTopic}
              >
                <IconMessageCircle size={17} />{" "}
                {explanationCached ? "الشرح محفوظ" : "اشرح لي هذا الموضوع"}
              </button>
            </div>
          </section>
        ) : (
          <section
            className="saved-materials-panel"
            aria-labelledby="saved-materials-heading"
          >
            <div className="saved-materials-header">
              <div>
                <p className="section-kicker">مكتبتك</p>
                <h2 id="saved-materials-heading">المواد المحفوظة</h2>
              </div>
              <input
                value={savedLessonsSearch}
                onChange={(event) => setSavedLessonsSearch(event.target.value)}
                placeholder="ابحث في الكتاب أو الدرس..."
                aria-label="البحث في المواد المحفوظة"
              />
            </div>
            {isLoadingSavedLessons ? (
              <div className="saved-empty">جاري تحميل المواد المحفوظة...</div>
            ) : savedLessonsError ? (
              <div className="saved-empty error-text">
                <p>{savedLessonsError}</p>
                <button
                  className="lesson-button"
                  type="button"
                  onClick={() => void loadSavedLessons(true)}
                >
                  إعادة المحاولة
                </button>
              </div>
            ) : !filteredSavedLessons.length ? (
              <div className="saved-empty">
                <p>لا توجد مواد محفوظة بعد</p>
                <small>أنشئ أول شرح من قسم درس جديد.</small>
                <button
                  className="lesson-button"
                  type="button"
                  onClick={() => setStudyMode("new")}
                >
                  إنشاء شرح جديد
                </button>
              </div>
            ) : (
              <div className="saved-materials-list">
                {filteredSavedLessons.map((lesson) => (
                  <article className="saved-material-card" key={lesson.id}>
                    <div>
                      <h3>{lesson.section_title || "درس محفوظ"}</h3>
                      <p>
                        {lesson.document_title || "كتاب تعليمي"}
                        {lesson.lesson_number != null
                          ? ` · الدرس ${lesson.lesson_number}`
                          : ""}
                      </p>
                      <div className="saved-material-meta">
                        <span>شرح محفوظ</span>
                        {lesson.voice_cached && <span>صوت جاهز</span>}
                        {lesson.updated_at && (
                          <time dateTime={lesson.updated_at}>
                            {new Date(lesson.updated_at).toLocaleDateString(
                              "ar",
                            )}
                          </time>
                        )}
                      </div>
                    </div>
                    <button
                      className="lesson-button"
                      type="button"
                      onClick={() => openSavedLesson(lesson)}
                    >
                      فتح الدرس
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {selectedBook && (
          <div className="book-context">
            <IconFileText size={16} />
            <span>{selectedBook.title}</span>
            <span className="context-separator">/</span>
            <span>{selectedBook.metadata?.subject || "مادة تعليمية"}</span>
            {selectedSection && (
              <>
                <span className="context-separator">/</span>
                <span>{selectedSection.title}</span>
              </>
            )}
          </div>
        )}
        {(error || booksError || sectionsError || knowledgeError) && (
          <div className="error-banner" role="alert">
            {error || booksError || sectionsError || knowledgeError}
            <button
              type="button"
              onClick={() => {
                setError("");
                setBooksError("");
                setSectionsError("");
                setKnowledgeError("");
              }}
            >
              إغلاق
            </button>
          </div>
        )}

        <section className="study-panel mt-7" aria-labelledby="study-heading">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">المادة الدراسية</p>
              <h2 id="study-heading">الشرح المحفوظ</h2>
            </div>
            <div className="study-statuses">
              <span
                className={`study-status ${explanationCached ? "is-ready" : ""}`}
              >
                {isLoadingStudy
                  ? "جاري التحميل..."
                  : explanationCached
                    ? "شرح محفوظ"
                    : "لا يوجد شرح محفوظ"}
              </span>
              {explanationCached && (
                <span className="study-status is-ready">نص فقط</span>
              )}
            </div>
          </div>
          <div className="study-content">
            {studyError ? (
              <div className="study-empty error-text">{studyError}</div>
            ) : isLoadingStudy ? (
              <div className="study-empty">جاري تحميل المادة الدراسية...</div>
            ) : studyExplanation ? (
              <div className="teacher-markdown" data-study-explanation="true">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                >
                  {renderTeacherMarkdown(studyExplanation.answer_markdown)}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="study-empty">
                <IconFileText size={24} />
                <p>لا يوجد شرح محفوظ لهذا الدرس.</p>
                <small>سيظهر هنا الشرح المحفوظ عند توفره لهذا الدرس.</small>
              </div>
            )}
          </div>
        </section>

        <div className="teacher-chat-section mt-7">
          <section ref={chatPanelRef} className="chat-panel teacher-chat-panel">
            <div className="panel-heading teacher-chat-heading">
              <div>
                <p className="section-kicker">
                  {voiceReplyEnabled ? "رد صوتي" : "رد نصي"}
                </p>
                <h2>المدرس الذكي</h2>
                <p className="panel-subtitle">
                  اسأل عن أي شيء، ويمكنك إرفاق صورة.
                  {voiceReplyEnabled ? " يجيبك المدرس بالصوت." : ""}
                </p>
              </div>
              <div className="voice-controls">
                <span className="study-status is-ready">
                  {voiceReplyEnabled ? "الصوت مفعّل" : "الصوت متوقف"}
                </span>
                <button
                  className={`voice-toggle ${voiceReplyEnabled ? "is-active" : ""}`}
                  type="button"
                  onClick={
                    voiceReplyEnabled
                      ? deactivateVoiceReply
                      : activateVoiceReply
                  }
                  disabled={!canWork || isAsking || isVoiceLoading}
                  aria-pressed={voiceReplyEnabled}
                  title={
                    voiceReplyEnabled
                      ? "تعطيل الرد الصوتي"
                      : "تفعيل الرد الصوتي"
                  }
                >
                  {voiceReplyEnabled
                    ? "🔇 تعطيل الرد الصوتي"
                    : "🔊 تفعيل الرد الصوتي"}
                </button>
                {voiceReplyEnabled && (
                  <>
                    {isVoicePlaying && (
                      <button
                        className="voice-talk"
                        type="button"
                        onClick={pauseVoice}
                        aria-label="إيقاف رد المدرس مؤقتًا"
                      >
                        إيقاف مؤقت
                      </button>
                    )}
                    {voiceUiState === "paused" && (
                      <button
                        className="voice-talk"
                        type="button"
                        onClick={resumeVoice}
                        aria-label="متابعة رد المدرس"
                      >
                        متابعة الرد
                      </button>
                    )}
                    {voiceUiState === "error" && voiceAnswerRef.current && (
                      <button
                        className="voice-talk"
                        type="button"
                        onClick={retryVoiceAnswer}
                        disabled={isVoiceLoading}
                        aria-label="إعادة محاولة الرد الصوتي"
                      >
                        ▶ إعادة المحاولة
                      </button>
                    )}
                    {voiceUiState === "ready" && voiceSegments.length > 0 && (
                      <button
                        className="voice-talk"
                        type="button"
                        onClick={replayVoice}
                        aria-label="إعادة تشغيل الرد الصوتي"
                      >
                        ▶ إعادة الرد
                      </button>
                    )}
                    <span
                      className={`voice-status ${isVoicePlaying ? "voice-status-speaking" : ""}`}
                    >
                      {voiceError}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div
              className="messages-area"
              aria-live="polite"
              aria-label={
                voiceReplyEnabled ? "محادثة مدرس الصوت" : "محادثة مدرس النص"
              }
            >
              <div
                ref={voiceHighlightLayerRef}
                className="voice-highlight-layer"
                aria-hidden="true"
              />
              {!voiceReplyEnabled && !messages.length && (
                <div className="empty-chat">
                  <div className="empty-icon">
                    <IconMessageCircle size={24} />
                  </div>
                  <h3>اسأل المدرس</h3>
                  <p>
                    اسأل عن أي شيء، ويمكنك إرفاق صورة أو اختيار مادة للسياق.
                  </p>
                </div>
              )}
              {renderChatMessages(
                messages,
                voiceReplyEnabled ? "voice" : "text",
              )}
              {voiceReplyEnabled ? (
                <div
                  className="recording-ready"
                  role="status"
                  aria-live="polite"
                >
                  {isTranscribing
                    ? "🧠 أفهم سؤالك..."
                    : voiceUiState === "thinking"
                      ? "🧠 المدرس يفكر..."
                      : voiceUiState === "speaking"
                        ? "🔊 المدرس يتحدث..."
                        : voiceUiState === "paused"
                          ? "⏸️ متوقف مؤقتًا"
                          : voiceUiState === "error"
                            ? "⚠️ تعذر تشغيل الرد الصوتي"
                            : "🎙️ تحدث مرة أخرى"}
                </div>
              ) : (
                isAsking && (
                  <div className="thinking">
                    <span className="status-dot" /> المدرس يكتب...
                  </div>
                )
              )}
              <div ref={messagesEndRef} />
            </div>
            <div className="chat-composer-wrap">
              <div className={voiceReplyEnabled ? "voice-chat-composer" : ""}>
                {attachedImageUrl && (
                  <div className="composer-image-preview">
                    <img src={attachedImageUrl} alt="معاينة الصورة المرفقة" />
                    <button
                      type="button"
                      onClick={() => clearAttachedImage()}
                      aria-label="إزالة الصورة"
                      title="إزالة الصورة"
                    >
                      <IconX size={15} />
                    </button>
                  </div>
                )}
                {isImageProcessing && (
                  <p className="image-upload-status" role="status">
                    جاري تجهيز الصورة...
                  </p>
                )}
                {isSendingImage && (
                  <p className="image-upload-status" role="status">
                    جاري تحليل الصورة...
                  </p>
                )}
                <form className="question-form" onSubmit={askTeacher}>
                  <input
                    ref={imageInputRef}
                    className="chat-image-input"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="إرفاق صورة"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) void attachChatImage(file);
                    }}
                  />
                  <button
                    className="composer-image-button"
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={
                      !canWork ||
                      isAsking ||
                      isTranscribing ||
                      isRecording ||
                      isImageProcessing
                    }
                    aria-label="إرفاق صورة"
                    title="إرفاق صورة"
                  >
                    <IconPaperclip size={19} />
                  </button>
                  <button
                    className={`composer-mic-button ${isRecording ? "recording-stop" : ""}`}
                    type="button"
                    onClick={() => {
                      if (isRecording) {
                        stopRecording();
                        return;
                      }
                      if (isVoicePlaying) stopTeacherVoice();
                      void startRecording();
                    }}
                    disabled={
                      !canWork ||
                      isTranscribing ||
                      isAsking ||
                      isImageProcessing
                    }
                    aria-label={
                      isRecording
                        ? "إيقاف التسجيل وإرسال السؤال"
                        : "التحدث مع مدرس الصوت"
                    }
                    title={isRecording ? "إيقاف التسجيل" : "التحدث مع المدرس"}
                  >
                    {isRecording ? "⏹️" : "🎙️"}
                  </button>
                  <input
                    ref={questionInputRef}
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    disabled={
                      !canWork ||
                      isAsking ||
                      isTranscribing ||
                      isRecording ||
                      isImageProcessing
                    }
                    placeholder={
                      attachedImageUrl
                        ? "اكتب سؤالًا عن الصورة..."
                        : "اكتب سؤالك..."
                    }
                    aria-label="اكتب سؤالًا للمدرس"
                  />
                  <button
                    type="submit"
                    disabled={
                      !canWork ||
                      (!question.trim() && !attachedImageDataUrl) ||
                      Boolean(attachedImage && !attachedImageDataUrl) ||
                      isAsking ||
                      isTranscribing ||
                      isRecording ||
                      isImageProcessing
                    }
                  >
                    {isAsking ? (
                      <IconLoader2 className="spin" size={18} />
                    ) : (
                      <IconSend size={18} />
                    )}
                    <span>إرسال</span>
                  </button>
                </form>
                {imageError && (
                  <p className="recording-error" role="alert">
                    {imageError}
                  </p>
                )}
                {isRecording && (
                  <div className="recording-state">
                    <span className="recording-dot" /> جاري التسجيل{" "}
                    <time>00:{String(recordingDuration).padStart(2, "0")}</time>
                  </div>
                )}
                {recordingError && (
                  <p className="recording-error">{recordingError}</p>
                )}
              </div>
            </div>
            <audio ref={voiceAudioRef} preload="auto" aria-hidden="true" />
          </section>
        </div>

        {selectedBook && (
          <details className="debug-panel">
            <summary>تشخيص الكتاب للمطور</summary>
            <div className="debug-grid">
              <div>
                <span>الحالة</span>
                <strong>{selectedBook.processing_status}</strong>
              </div>
              <div>
                <span>الدروس</span>
                <strong>{sections.length}</strong>
              </div>
              <div>
                <span>العناصر</span>
                <strong>{isLoadingKnowledge ? "..." : items.length}</strong>
              </div>
              <div>
                <span>المقاطع</span>
                <strong>{isLoadingKnowledge ? "..." : chunks.length}</strong>
              </div>
              <div className="debug-error">
                <span>خطأ المعالجة</span>
                <strong>
                  {selectedBook.metadata?.processing_error || "لا يوجد"}
                </strong>
              </div>
            </div>
          </details>
        )}
      </div>
    </main>
  );
}
