import { IconBook2, IconChevronDown, IconFileText, IconLoader2, IconMessageCircle, IconRefresh, IconSend, IconUser } from "@tabler/icons-react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import { supabase, supabaseKey, supabaseUrl } from "@/lib/supabase";

type Metadata = { subject?: string; grade?: string; stage?: string; processing_error?: string };
type Book = { id: string; title: string; processing_status: string; page_count: number | null; text_length: number | null; metadata: Metadata | null; created_at: string; updated_at?: string | null };
type Section = { id: string; document_id: string; title: string; section_type: string | null; chapter_number: number | null; lesson_number: number | null; page_start: number | null; page_end: number | null; summary: string | null };
type KnowledgeRecord = { id: string; section_id: string; page_start?: number | null; chunk_index?: number | null; content?: string | null };
type ExplanationCache = { id: string; answer_markdown: string; document_id: string; section_id: string; status: string; updated_at?: string | null };
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
type Source = { page?: number; page_number?: number; title?: string; content?: string };

function getErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
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
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[“”„«»]/g, '"')
      .replace(/[‘’‚]/g, "'")
      .toLocaleLowerCase();

    if (/\s/.test(original)) {
      if (normalizedCharacters.length > 0 && !previousWasSpace) {
        pendingSpaceSourceOffset = index;
      }
      previousWasSpace = true;
      continue;
    }

    if (pendingSpaceSourceOffset !== null) {
      normalizedCharacters.push(" ");
      sourceOffsets.push(pendingSpaceSourceOffset);
      pendingSpaceSourceOffset = null;
    }

    previousWasSpace = false;
    if (/[*_`~>#-]/.test(original)) continue;
    normalizedCharacters.push(normalized);
    sourceOffsets.push(index);
  }

  while (normalizedCharacters.length > 0 && normalizedCharacters[normalizedCharacters.length - 1] === " ") {
    normalizedCharacters.pop();
    sourceOffsets.pop();
  }

  return { text: normalizedCharacters.join(""), map: sourceOffsets };
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
  if (eventType !== "response.output_text.delta" && eventType !== "delta" && eventType !== "message.delta") {
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
  if (typeof event.assistant_message_id === "string") return event.assistant_message_id;
  if (isRecord(event.data)) {
    if (typeof event.data.message_id === "string") return event.data.message_id;
    if (typeof event.data.assistant_message_id === "string") return event.data.assistant_message_id;
  }
  return null;
}

function extractExplanationCacheId(event: Record<string, unknown>): string | null {
  for (const key of ["explanation_cache_id", "explanationCacheId"]) {
    if (typeof event[key] === "string" && event[key].trim()) return event[key].trim();
    if (isRecord(event.data) && typeof event.data[key] === "string" && event.data[key].trim()) return event.data[key].trim();
  }
  return null;
}

function extractBooleanField(event: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof event[key] === "boolean") return event[key];
    if (isRecord(event.data) && typeof event.data[key] === "boolean") return event.data[key];
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

    const resolvedEventType = extractEventType(
      parsed,
      explicitEventType,
    );
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

    const delta = extractDeltaFromEvent(
      resolvedEventType,
      parsed,
    );

    if (delta) {
      console.log(
        "[frontend-stream DELTA RAW]",
        JSON.stringify(delta),
      );
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
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [topic, setTopic] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [items, setItems] = useState<KnowledgeRecord[]>([]);
  const [chunks, setChunks] = useState<KnowledgeRecord[]>([]);
  const [isLoadingBooks, setIsLoadingBooks] = useState(true);
  const [isLoadingSections, setIsLoadingSections] = useState(false);
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(false);
  const [booksError, setBooksError] = useState("");
  const [sectionsError, setSectionsError] = useState("");
  const [knowledgeError, setKnowledgeError] = useState("");
  const [studyExplanation, setStudyExplanation] = useState<ExplanationCache | null>(null);
  const [isLoadingStudy, setIsLoadingStudy] = useState(false);
  const [studyError, setStudyError] = useState("");
  const [explanationCached, setExplanationCached] = useState(false);
  const [voiceCached, setVoiceCached] = useState(false);
  const [voiceContentTarget, setVoiceContentTarget] = useState<"study" | "chat">("chat");
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"connected" | "disconnected">(supabase ? "connected" : "disconnected");
  const [userLabel, setUserLabel] = useState("");
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [isVoicePlaying, setIsVoicePlaying] = useState(false);
  const [isVoiceLoading, setIsVoiceLoading] = useState(false);
  const [voiceSegments, setVoiceSegments] = useState<VoiceSegment[]>([]);
  const [activeVoiceSegment, setActiveVoiceSegment] = useState<number | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "loading" | "ready" | "playing" | "paused" | "error">("idle");
  const [voiceError, setVoiceError] = useState("");
  const chatPanelRef = useRef<HTMLElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const questionInputRef = useRef<HTMLInputElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceSegmentsRef = useRef<VoiceSegment[]>([]);
  const voiceIndexRef = useRef(0);
  const voiceObjectUrlRef = useRef<string | null>(null);
  const voiceRunIdRef = useRef(0);
  const teacherMarkdownRef = useRef<HTMLDivElement | null>(null);
  const voiceAbortControllerRef = useRef<AbortController | null>(null);
  const voicePlaybackCancelRef = useRef<(() => void) | null>(null);
  const isVoiceEnabledRef = useRef(true);
  const isAskingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadBooks = useCallback(async () => {
    if (!supabase) { setIsLoadingBooks(false); return; }
    setIsLoadingBooks(true);
    setBooksError("");
    const { data, error: queryError } = await supabase.from("knowledge_documents").select("*").order("created_at", { ascending: false });
    console.log("[AI Teacher] documents:", (data ?? []).map((document) => ({
      id: document.id,
      title: document.title,
      processing_status: document.processing_status,
      page_count: document.page_count,
      created_at: document.created_at,
      updated_at: document.updated_at,
    })));
    if (queryError) console.error("[AI Teacher] documents error:", queryError);
    if (queryError) { setBooksError("تعذر تحميل الكتب من Supabase. تحقق من صلاحيات القراءة."); setConnection("disconnected"); }
    else { setBooks((data ?? []) as Book[]); setConnection("connected"); }
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
    if (!supabase || !selectedDocumentId) { setSections([]); setItems([]); setChunks([]); return; }
    setIsLoadingSections(true);
    setSectionsError("");
    setSelectedSectionId("");
    setItems([]);
    setChunks([]);
    void supabase.from("knowledge_sections").select("id, document_id, title, section_type, chapter_number, lesson_number, page_start, page_end, summary").eq("document_id", selectedDocumentId).order("page_start", { ascending: true }).then(({ data, error: queryError }) => {
      console.log("[AI Teacher] sections:", data);
      if (queryError) console.error("[AI Teacher] sections error:", queryError);
      if (queryError) setSectionsError("تعذر تحميل دروس هذا الكتاب. تحقق من صلاحيات القراءة.");
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
      setVoiceCached(false);
      setVoiceContentTarget("chat");
      setStudyError("");
      return;
    }
    setIsLoadingKnowledge(true);
    setKnowledgeError("");
    void Promise.all([
      supabase.from("knowledge_items").select("*").eq("section_id", selectedSectionId).order("page_start", { ascending: true }),
      supabase.from("knowledge_chunks").select("*").eq("section_id", selectedSectionId).order("chunk_index", { ascending: true }),
    ]).then(([itemsResult, chunksResult]) => {
      console.log("[AI Teacher] items:", itemsResult.data);
      console.log("[AI Teacher] chunks:", chunksResult.data);
      if (itemsResult.error) console.error("[AI Teacher] items error:", itemsResult.error);
      if (chunksResult.error) console.error("[AI Teacher] chunks error:", chunksResult.error);
      if (itemsResult.error || chunksResult.error) setKnowledgeError("تعذر تحميل المعرفة المستخرجة لهذا الدرس. تحقق من صلاحيات القراءة.");
      setItems((itemsResult.data ?? []) as KnowledgeRecord[]);
      setChunks((chunksResult.data ?? []) as KnowledgeRecord[]);
      setIsLoadingKnowledge(false);
    });
  }, [selectedSectionId]);

  useEffect(() => {
    if (!supabase || !supabaseUrl || !supabaseKey || !selectedDocumentId || !selectedSectionId) return;

    let active = true;
    setIsLoadingStudy(true);
    setStudyError("");
    setStudyExplanation(null);
    setExplanationCached(false);
    setVoiceCached(false);
    console.log("[study] LOAD EXPLANATION", { documentId: selectedDocumentId, sectionId: selectedSectionId });

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
        const payload = await response.json().catch(() => null) as {
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
        if (!payload?.cached || !payload.answer?.trim() || !payload.explanation_cache_id) {
          console.log("[study] EXPLANATION CACHE MISS", { documentId: selectedDocumentId, sectionId: selectedSectionId });
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

        console.log("[study] EXPLANATION CACHE HIT", { explanationCacheId: explanation.id });
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

  const selectedBook = useMemo(() => books.find((book) => book.id === selectedDocumentId), [books, selectedDocumentId]);
  const selectedSection = useMemo(() => sections.find((section) => section.id === selectedSectionId), [sections, selectedSectionId]);

  const normalizeComparableText = (value: string) => normalizeVoiceChars(value).text;

  const clearVoiceHighlight = useCallback(() => {
    const root = teacherMarkdownRef.current;
    if (!root) return;
    const highlights = root.querySelectorAll(".teacher-voice-highlight, .voice-highlight");
    if (highlights.length) console.log("[voice-sync] HIGHLIGHT REMOVED");
    highlights.forEach((highlight) => {
      const parent = highlight.parentNode;
      if (!parent) return;
      while (highlight.firstChild) parent.insertBefore(highlight.firstChild, highlight);
      parent.removeChild(highlight);
      parent.normalize();
    });
  }, []);

  const highlightVoiceSegment = useCallback((segment: VoiceSegment) => {
    clearVoiceHighlight();
    const root = teacherMarkdownRef.current;
    if (!root || !segment.text.trim()) return;

    const ignoredSelector = ".katex, pre, code, script, style";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode: Node | null = walker.nextNode();
    while (currentNode) {
      const textNode = currentNode as Text;
      if (!textNode.parentElement?.closest(ignoredSelector)) textNodes.push(textNode);
      currentNode = walker.nextNode();
    }

    const points: Array<{ node: Text; offset: number }> = [];
    let comparableText = "";
    textNodes.forEach((textNode, nodeIndex) => {
      const value = textNode.textContent || "";
      const normalized = normalizeComparableText(value);
      if (nodeIndex > 0 && comparableText && normalized) {
        comparableText += " ";
        points.push({ node: textNode, offset: 0 });
      }
      const sourceMap = normalizeVoiceChars(value).map;
      for (let index = 0; index < normalized.length; index += 1) {
        comparableText += normalized[index];
        points.push({ node: textNode, offset: sourceMap[index] ?? value.length });
      }
    });

    const target = normalizeComparableText(segment.text);
    const start = target ? comparableText.indexOf(target) : -1;
    if (start < 0) {
      console.warn("[voice-sync] segment text not found", {
        segmentIndex: segment.segment_index,
        text: segment.text.slice(0, 120),
      });
      return;
    }

    const endIndex = start + target.length - 1;
    const startPoint = points[start];
    const endPoint = points[endIndex];
    if (!startPoint || !endPoint) return;

    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset + 1);
    const highlight = document.createElement("span");
    highlight.className = "teacher-voice-highlight";
    const highlightedContent = range.extractContents();
    highlight.appendChild(highlightedContent);
    range.insertNode(highlight);
    console.log("[voice-sync] HIGHLIGHT APPLIED", {
      segmentIndex: segment.segment_index,
      text: segment.text.slice(0, 100),
    });

    const rect = range.getBoundingClientRect();
    const scrollContainer = root.closest<HTMLElement>(".messages-area");
    const containerRect = scrollContainer?.getBoundingClientRect();
    if (scrollContainer && containerRect && (rect.top < containerRect.top || rect.bottom > containerRect.bottom)) {
      highlight.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [clearVoiceHighlight]);

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
    setIsVoiceLoading(false);
    setIsVoicePlaying(false);
    setActiveVoiceSegment(null);
    setVoiceStatus(voiceSegmentsRef.current.length ? "ready" : "idle");
    clearVoiceHighlight();
  }, [clearVoiceHighlight]);

  const playVoiceSegments = useCallback(async (segments: VoiceSegment[], startIndex = 0) => {
    const audio = voiceAudioRef.current;
    if (!audio || !segments.length) return;

    const runId = ++voiceRunIdRef.current;
    voiceIndexRef.current = startIndex;
    setIsVoicePlaying(true);
    setVoiceStatus("playing");
    setActiveVoiceSegment(segments[startIndex]?.segment_index ?? null);

    try {
      for (let index = startIndex; index < segments.length; index += 1) {
        const segment = segments[index];
        if (runId !== voiceRunIdRef.current || !isVoiceEnabledRef.current) return;
        if (!segment.audio_url) {
          console.warn("[voice-sync] AUDIO URL MISSING", { segmentIndex: segment.segment_index });
          continue;
        }

        voiceIndexRef.current = index;
        setActiveVoiceSegment(segment.segment_index);
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
            setIsVoicePlaying(true);
            setVoiceStatus("playing");
          };
          const onPause = () => {
            if (!settled) {
              setIsVoicePlaying(false);
              setVoiceStatus("paused");
              console.log("[voice-sync] PAUSE", { segmentIndex: segment.segment_index });
            }
          };
          const onEnded = () => finish(true);
          const onError = () => {
            console.error("[voice-sync] AUDIO ERROR", { segmentIndex: segment.segment_index, src: audio.src });
            fail("تعذر تشغيل الصوت.");
          };
          const onTimeUpdate = () => {
            const currentTimeMs = audio.currentTime * 1000;
            console.log("[voice-sync] TIME", {
              segmentIndex: segment.segment_index,
              currentTimeMs,
              startTimeMs: segment.start_time_ms,
              endTimeMs: segment.end_time_ms,
              text: segment.text.slice(0, 100),
            });
            if (voiceIndexRef.current === index) {
              console.log("[voice-sync] ACTIVE SEGMENT", {
                segmentIndex: segment.segment_index,
                currentTimeMs,
                startTimeMs: segment.start_time_ms,
                endTimeMs: segment.end_time_ms,
              });
              setActiveVoiceSegment(segment.segment_index);
            }
          };

          voicePlaybackCancelRef.current = () => finish(false);
          audio.addEventListener("play", onPlay);
          audio.addEventListener("pause", onPause);
          audio.addEventListener("ended", onEnded);
          audio.addEventListener("error", onError);
          audio.addEventListener("timeupdate", onTimeUpdate);

          void audio.play().catch((error: unknown) => {
            if (error instanceof DOMException && error.name === "NotAllowedError") {
              fail("اضغط تشغيل الصوت للسماح بالقراءة الصوتية.");
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
      setVoiceStatus("ready");
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch (error) {
      if (runId === voiceRunIdRef.current) {
        setVoiceError(getErrorMessage(error));
        setIsVoicePlaying(false);
        setVoiceStatus("error");
      }
    }
  }, [clearVoiceHighlight]);

  const generateTeacherVoice = useCallback(async ({
    text,
    documentId,
    sectionId,
    conversationId: responseConversationId,
    messageId,
    explanationCacheId: responseExplanationCacheId,
    enabled = true,
  }: {
    text: string;
    documentId: string;
    sectionId: string;
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
      isVoiceEnabled,
    });

    if (!isVoiceEnabledRef.current || !text.trim() || !documentId || !sectionId || !supabase || !supabaseUrl || !supabaseKey) return;

    const runId = ++voiceRunIdRef.current;
    voiceAbortControllerRef.current?.abort();
    const controller = new AbortController();
    voiceAbortControllerRef.current = controller;
    setIsVoiceLoading(true);
    setVoiceError("");
    setVoiceStatus("loading");
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, voice_loading: true } : message));

    try {
      const sessionResult = await supabase.auth.getSession();
      const accessToken = sessionResult.data.session?.access_token || supabaseKey;
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
      const response = await fetch(`${supabaseUrl}/functions/v1/teacher-voice`, {
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
      });

      const rawResponse = await response.text();
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(rawResponse);
        if (isRecord(parsed)) data = parsed;
      } catch {
        if (!response.ok) throw new Error(rawResponse || `HTTP ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : rawResponse || `HTTP ${response.status}`);
      }
      console.log(data.cached === true ? "[voice-sync] CACHE HIT" : "[voice-sync] CACHE MISS", {
        messageId,
        segmentCount: Array.isArray(data.segments) ? data.segments.length : 0,
      });
      if (runId !== voiceRunIdRef.current) return;
      if (data.success !== true) throw new Error(typeof data.error === "string" ? data.error : "لم يتم إنشاء الصوت.");

      const nextSegments = Array.isArray(data.segments)
        ? data.segments
            .filter((segment): segment is VoiceSegment => isRecord(segment) && typeof segment.text === "string" && typeof segment.segment_index === "number" && typeof segment.start_time_ms === "number" && typeof segment.end_time_ms === "number" && typeof segment.audio_url === "string")
            .sort((a, b) => a.segment_index - b.segment_index)
        : [];

      if (!nextSegments.length) {
        console.warn("[voice-sync] NO SEGMENTS", data);
        setIsVoiceLoading(false);
        setVoiceStatus("ready");
        return;
      }
      voiceSegmentsRef.current = nextSegments;
      setVoiceSegments(nextSegments);
      console.log("[voice-sync] READY", { segments: nextSegments.length });
      voiceSegmentsRef.current = nextSegments;
      setVoiceStatus("ready");
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, voice_segments: nextSegments, voice_ready: true, voice_loading: false } : message));
      setIsVoiceLoading(false);
      await playVoiceSegments(nextSegments);
    } catch (error) {
      if (controller.signal.aborted || runId !== voiceRunIdRef.current) return;
      setVoiceError(getErrorMessage(error));
      setIsVoiceLoading(false);
      setVoiceStatus("error");
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, voice_loading: false } : message));
    } finally {
      if (voiceAbortControllerRef.current === controller) voiceAbortControllerRef.current = null;
    }
  }, [isVoiceEnabled, playVoiceSegments]);

  const playStudyVoice = useCallback(() => {
    if (!studyExplanation || !isVoiceEnabled || isVoiceLoading || !selectedDocumentId || !selectedSectionId) return;

    setVoiceContentTarget("study");
    console.log("[study] LOAD VOICE", { explanationCacheId: studyExplanation.id, cached: voiceCached });
    void generateTeacherVoice({
      text: studyExplanation.answer_markdown,
      documentId: selectedDocumentId,
      sectionId: selectedSectionId,
      explanationCacheId: studyExplanation.id,
      enabled: true,
    }).then(() => {
      setVoiceCached(true);
    });
  }, [generateTeacherVoice, isVoiceEnabled, isVoiceLoading, selectedDocumentId, selectedSectionId, studyExplanation, voiceCached]);

  const clearVoiceContext = useCallback(() => {
    stopTeacherVoice();
    voiceSegmentsRef.current = [];
    setVoiceSegments([]);
    setActiveVoiceSegment(null);
    setVoiceStatus("idle");
    setVoiceError("");
  }, [stopTeacherVoice]);

  const toggleVoice = useCallback(() => {
    if (isVoiceEnabled) {
      isVoiceEnabledRef.current = false;
      stopTeacherVoice();
      setIsVoiceEnabled(false);
      return;
    }

    isVoiceEnabledRef.current = true;
    setIsVoiceEnabled(true);
    const cachedSegments = voiceSegmentsRef.current;
    if (cachedSegments.length) void playVoiceSegments(cachedSegments);
  }, [isVoiceEnabled, playVoiceSegments, stopTeacherVoice]);

  const replayVoice = useCallback(() => {
    if (!isVoiceEnabledRef.current || isVoiceLoading || !voiceSegmentsRef.current.length) return;
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
      setVoiceStatus("error");
    });
  }, []);

  const seekVoiceSegment = useCallback((segmentIndex: number) => {
    if (!isVoiceEnabledRef.current || isVoiceLoading) return;
    const index = voiceSegmentsRef.current.findIndex((segment) => segment.segment_index === segmentIndex);
    if (index < 0) return;
    setVoiceError("");
    void playVoiceSegments(voiceSegmentsRef.current, index);
  }, [isVoiceLoading, playVoiceSegments]);

  const handleTeacherMarkdownClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const text = event.target instanceof HTMLElement ? event.target.textContent || "" : "";
    if (!text.trim()) return;
    const segment = voiceSegmentsRef.current.find((voiceSegment) => normalizeComparableText(text).includes(normalizeComparableText(voiceSegment.text)));
    if (segment) seekVoiceSegment(segment.segment_index);
  }, [seekVoiceSegment]);

  useEffect(() => {
    voiceSegmentsRef.current = voiceSegments;
  }, [voiceSegments]);

  useEffect(() => {
    isVoiceEnabledRef.current = isVoiceEnabled;
    if (!isVoiceEnabled) stopTeacherVoice();
  }, [isVoiceEnabled, stopTeacherVoice]);

  useEffect(() => {
    clearVoiceContext();
  }, [clearVoiceContext, selectedDocumentId, selectedSectionId]);

  useEffect(() => {
    if (activeVoiceSegment == null) {
      clearVoiceHighlight();
      return;
    }
    const segment = voiceSegmentsRef.current.find((item) => item.segment_index === activeVoiceSegment);
    if (segment) highlightVoiceSegment(segment);
  }, [activeVoiceSegment, clearVoiceHighlight, highlightVoiceSegment]);

  useEffect(() => {
    return () => stopTeacherVoice();
  }, [stopTeacherVoice]);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();

      if (
        !trimmed ||
        !selectedDocumentId ||
        !supabase ||
        isAskingRef.current
      ) {
        return;
      }

      isAskingRef.current = true;
      clearVoiceContext();
      setIsAsking(true);
      setError("");
      setQuestion("");

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        created_at: new Date().toISOString(),
      };

      const streamingMessageId = crypto.randomUUID();
      let assistantMessageId: string | null = null;
      const assistantMessage: Message = {
        id: streamingMessageId,
        role: "assistant",
        content: "",
        sources: [],
        created_at: new Date().toISOString(),
      };

      setMessages((current) => [
        ...current,
        userMessage,
        assistantMessage,
      ]);

      let accumulatedText = "";
      let finalSources: Source[] = [];
      let finalConversationId = conversationId;
      let finalExplanationCacheId: string | null = null;
      let finalExplanationCached = false;
      let streamError = "";

      const conversationHistory = [
        ...messages,
        userMessage,
      ]
        .filter((message) =>
          message.role === "user" || message.role === "assistant",
        )
        .slice(-10);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const patchAssistant = (patch: Partial<Message>) => {
        setMessages((current) =>
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
          messagesEndRef.current?.scrollIntoView({
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
          sessionResult.data.session?.access_token ||
          supabaseKey;

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
            body: JSON.stringify({
              question: trimmed,
              document_id: selectedDocumentId,
              section_id: selectedSectionId || null,
              conversation_id: conversationId || null,
              conversation_history: conversationHistory,
            }),
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

          throw new Error(
            `فشل الاتصال بالمدرس الذكي: ${message}`,
          );
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

        if (!accumulatedText.trim()) {
          throw new Error("لم يصل محتوى من المدرس الذكي.");
        }

        setConversationId(finalConversationId);
        if (finalExplanationCacheId) {
          setStudyExplanation({
            id: finalExplanationCacheId,
            answer_markdown: accumulatedText,
            document_id: selectedDocumentId,
            section_id: selectedSectionId,
            status: "ready",
          });
          setExplanationCached(true);
          console.log("[study] EXPLANATION CACHE HIT", { explanationCacheId: finalExplanationCacheId, source: "teacher-chat" });
        }
        patchAssistant({
          content: accumulatedText,
          sources: finalSources,
          explanation_cache_id: finalExplanationCacheId,
          explanation_cached: finalExplanationCached,
        });

        console.log("[frontend] BEFORE TEACHER VOICE", {
          isVoiceEnabled,
          selectedDocumentId,
          selectedSectionId,
          finalConversationId,
          assistantMessageId,
          explanationCacheId: finalExplanationCacheId,
          accumulatedTextLength: accumulatedText.length,
        });

        if (
          isVoiceEnabledRef.current &&
          selectedSectionId &&
          accumulatedText.trim() &&
          finalConversationId &&
          assistantMessageId
        ) {
          try {
            setVoiceContentTarget("chat");
            console.log("[frontend] CALLING TEACHER VOICE", {
              messageId: assistantMessageId,
              conversationId: finalConversationId,
              sectionId: selectedSectionId,
              explanationCacheId: finalExplanationCacheId,
            });
            await generateTeacherVoice({
              text: accumulatedText,
              documentId: selectedDocumentId,
              sectionId: selectedSectionId,
              conversationId: finalConversationId,
              messageId: assistantMessageId,
              explanationCacheId: finalExplanationCacheId,
              enabled: isVoiceEnabled,
            });
          } catch (voiceError) {
            console.warn("[teacher-voice] Voice generation failed:", voiceError);
          }
        } else {
          console.warn("[frontend] TEACHER VOICE SKIPPED", {
            isVoiceEnabled,
            selectedSectionId,
            hasText: Boolean(accumulatedText.trim()),
            assistantMessageId,
          });
        }
      } catch (requestError) {
        setMessages((current) =>
          current.filter(
            (message) => message.id !== streamingMessageId,
          ),
        );

        if (
          requestError instanceof DOMException &&
          requestError.name === "AbortError"
        ) {
          return;
        }

        setError(
          requestError instanceof Error
            ? requestError.message
            : "حدث خطأ أثناء الاتصال بالمدرس الذكي.",
        );
      } finally {
        abortControllerRef.current = null;
        isAskingRef.current = false;
        setIsAsking(false);

        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "end",
          });

          questionInputRef.current?.focus();
        });
      }
    },
    [
      conversationId,
      clearVoiceContext,
      generateTeacherVoice,
      messages,
      selectedDocumentId,
      selectedSectionId,
    ],
  );

  function askTeacher(event: FormEvent) {
    event.preventDefault();
    void sendMessage(question);
  }

  function explainTopic() {
    if (!topic.trim() || !selectedDocumentId || !selectedSectionId || isAsking || explanationCached) return;
    const generatedQuestion = `اشرح لي موضوع "${topic.trim()}" من درس "${selectedSection?.title || "الدرس المحدد"}".`;
    void sendMessage(generatedQuestion);
  }

  const canWork = Boolean(selectedDocumentId && supabase);

  return (
    <main dir="rtl" className="teacher-app min-h-screen bg-[#f5f7f8] text-[#17323a]">
      <header className="teacher-header border-b border-[#dce7e7] bg-[#fbfdfc]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="brand-mark"><IconBook2 size={22} stroke={1.8} /></div>
            <div><h1 className="text-lg font-semibold tracking-tight">AI Teacher</h1><p className="text-xs text-[#6b8184]">المدرس الذكي</p></div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {userLabel && <span className="hidden text-[#6b8184] sm:inline">مرحبًا، {userLabel}</span>}
            <span className={`connection-status ${connection === "connected" ? "is-connected" : "is-disconnected"}`}><span className="status-dot" />{connection === "connected" ? "متصل" : "غير متصل"}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <section className="mb-7 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div><p className="section-kicker">مساحة التعلم</p><h2 className="mt-2 text-3xl font-semibold tracking-tight text-[#17323a]">ابدأ من كتابك</h2></div>
          <button className="quiet-button" type="button" onClick={() => { clearVoiceContext(); setMessages([]); setConversationId(null); }}><IconRefresh size={16} /> محادثة جديدة</button>
        </section>

        <section className="control-panel" aria-label="اختيار المادة">
          <div className="control-field wide"><label htmlFor="book">الكتاب</label><div className="select-wrap"><select id="book" value={selectedDocumentId} onChange={(event) => { setSelectedDocumentId(event.target.value); clearVoiceContext(); }}><option value="">{isLoadingBooks ? "جاري تحميل الكتب..." : booksError ? "تعذر تحميل الكتب" : books.length ? "اختر كتابًا" : "لم تُرجع صلاحية المستخدم كتبًا معالجة"}</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title} · {book.metadata?.grade || book.metadata?.stage || ""}</option>)}</select><IconChevronDown size={17} /></div></div>
          <div className="control-field"><label htmlFor="section">الدرس</label><div className="select-wrap"><select id="section" value={selectedSectionId} disabled={!selectedDocumentId || isLoadingSections} onChange={(event) => { setSelectedSectionId(event.target.value); clearVoiceContext(); }}><option value="">{isLoadingSections ? "جاري تحميل الدروس..." : sectionsError ? "تعذر تحميل الدروس" : sections.length ? "اختر درسًا" : "لم تُرجع صلاحية المستخدم دروسًا لهذا الكتاب"}</option>{sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}</select><IconChevronDown size={17} /></div></div>
          <div className="control-field topic-field"><label htmlFor="topic">الموضوع</label><input id="topic" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="ماذا تريد أن تتعلم؟" /><button className="topic-action" type="button" disabled={!canWork || !selectedSectionId || !topic.trim() || isAsking || explanationCached} onClick={explainTopic}><IconMessageCircle size={17} /> {explanationCached ? "الشرح محفوظ" : "اشرح لي هذا الموضوع"}</button></div>
        </section>

        {selectedBook && <div className="book-context"><IconFileText size={16} /><span>{selectedBook.title}</span><span className="context-separator">/</span><span>{selectedBook.metadata?.subject || "مادة تعليمية"}</span>{selectedSection && <><span className="context-separator">/</span><span>{selectedSection.title}</span></>}</div>}
        {(error || booksError || sectionsError || knowledgeError) && <div className="error-banner" role="alert">{error || booksError || sectionsError || knowledgeError}<button type="button" onClick={() => { setError(""); setBooksError(""); setSectionsError(""); setKnowledgeError(""); }}>إغلاق</button></div>}

        <section className="study-panel mt-7" aria-labelledby="study-heading">
          <div className="panel-heading"><div><p className="section-kicker">المادة الدراسية</p><h2 id="study-heading">الشرح المحفوظ</h2></div><div className="study-statuses"><span className={`study-status ${explanationCached ? "is-ready" : ""}`}>{isLoadingStudy ? "جاري التحميل..." : explanationCached ? "شرح محفوظ" : "لا يوجد شرح محفوظ"}</span>{explanationCached && <><span className="study-status is-ready">{voiceCached ? "الصوت جاهز" : "جاهز للدراسة"}</span><button className="voice-talk" type="button" onClick={playStudyVoice} disabled={!isVoiceEnabled || isVoiceLoading}>{voiceCached ? "تشغيل الصوت المحفوظ" : "تشغيل صوت المادة"}</button></>}</div></div>
          <div className="study-content">
            {studyError ? <div className="study-empty error-text">{studyError}</div> : isLoadingStudy ? <div className="study-empty">جاري تحميل المادة الدراسية...</div> : studyExplanation ? <div ref={voiceContentTarget === "study" ? teacherMarkdownRef : undefined} className="teacher-markdown" data-study-explanation="true"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{renderTeacherMarkdown(studyExplanation.answer_markdown)}</ReactMarkdown></div> : <div className="study-empty"><IconFileText size={24} /><p>لا يوجد شرح محفوظ لهذا الدرس.</p><small>سيظهر هنا الشرح المحفوظ عند توفره لهذا الدرس.</small></div>}
          </div>
        </section>

        <div className="workspace-grid mt-7">
          <section ref={chatPanelRef} className="chat-panel">
            <div className="panel-heading"><div><p className="section-kicker">أسئلة خاصة</p><h2>اسأل المدرس</h2></div><div className="voice-controls"><button className={`voice-toggle ${isVoiceEnabled ? "is-active" : ""}`} type="button" onClick={toggleVoice} disabled={!canWork || isVoiceLoading}>{isVoiceEnabled ? "الصوت مفعّل" : "الصوت متوقف"}</button>{isVoicePlaying && <button className="voice-talk" type="button" onClick={pauseVoice}>إيقاف مؤقت</button>}{voiceStatus === "paused" && <button className="voice-talk" type="button" onClick={resumeVoice}>متابعة الصوت</button>}{voiceSegments.length > 0 && !isVoicePlaying && voiceStatus !== "paused" && !isVoiceLoading && <button className="voice-talk" type="button" onClick={replayVoice} disabled={!isVoiceEnabled}>تشغيل الصوت</button>}<span className={`voice-status ${isVoicePlaying ? "voice-status-speaking" : ""}`}>{voiceError || (!isVoiceEnabled ? "الصوت متوقف" : isVoiceLoading ? "جاري تجهيز الصوت..." : voiceStatus === "paused" ? "متوقف" : isVoicePlaying ? "يقرأ الآن" : voiceStatus === "ready" ? "الصوت جاهز" : "بانتظار الإجابة")}</span></div></div>
            <div className="messages-area" aria-live="polite">
              {!messages.length && <div className="empty-chat"><div className="empty-icon"><IconMessageCircle size={24} /></div><h3>اسأل المدرس عن سؤال خاص</h3><p>{canWork ? "اكتب سؤالًا جديدًا، وسأبحث عن إجابته من محتوى الكتاب." : "اختر كتابًا لتبدأ."}</p></div>}
              {messages.map((message, index) => <article key={`${message.created_at}-${index}`} className={`message ${message.role === "user" ? "user-message" : "assistant-message"}`}><div className="message-avatar">{message.role === "user" ? <IconUser size={16} /> : <IconBook2 size={16} />}</div><div className="message-body"><span className="message-role">{message.role === "user" ? "الطالب" : "المدرس"}</span>{message.role === "assistant" ? <div ref={voiceContentTarget === "chat" ? teacherMarkdownRef : undefined} className="teacher-markdown" onClick={handleTeacherMarkdownClick}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{renderTeacherMarkdown(message.content)}</ReactMarkdown></div> : <p>{message.content}</p>}{message.sources?.length ? <div className="sources"><span>المصادر</span>{message.sources.map((source, sourceIndex) => <small key={sourceIndex}>صفحة {source.page || source.page_number || "—"}{source.title ? ` · ${source.title}` : ""}</small>)}</div> : null}</div></article>)}
              {isAsking && <div className="thinking"><span className="status-dot" /> المدرس يكتب...</div>}
              <div ref={messagesEndRef} />
            </div>
            <form className="question-form" onSubmit={askTeacher}><input ref={questionInputRef} value={question} onChange={(event) => setQuestion(event.target.value)} disabled={!canWork || isAsking} placeholder="اكتب سؤالك..." aria-label="اكتب سؤالك" /><button type="submit" disabled={!canWork || !question.trim() || isAsking}>{isAsking ? <IconLoader2 className="spin" size={18} /> : <IconSend size={18} />}<span>اسأل المدرس</span></button></form>
            <audio ref={voiceAudioRef} preload="auto" aria-hidden="true" />
          </section>

          <section className="lesson-panel">
            <div className="panel-heading"><div><p className="section-kicker">اختيارك الحالي</p><h2>تفاصيل الدرس</h2></div><IconBook2 size={20} /></div>
            <div className="lesson-content selection-info">
              {selectedSection ? <><h3>{selectedSection.title}</h3>{selectedSection.summary && <p>{selectedSection.summary}</p>}{selectedSection.page_start && <p className="selection-page">الصفحات {selectedSection.page_start}{selectedSection.page_end && selectedSection.page_end !== selectedSection.page_start ? `–${selectedSection.page_end}` : ""}</p>}</> : <div className="lesson-empty"><IconBook2 size={26} /><p>اختر درسًا لبدء التعلم.</p></div>}
            </div>
          </section>
        </div>

        {selectedBook && <details className="debug-panel"><summary>تشخيص الكتاب للمطور</summary><div className="debug-grid"><div><span>الحالة</span><strong>{selectedBook.processing_status}</strong></div><div><span>الدروس</span><strong>{sections.length}</strong></div><div><span>العناصر</span><strong>{isLoadingKnowledge ? "..." : items.length}</strong></div><div><span>المقاطع</span><strong>{isLoadingKnowledge ? "..." : chunks.length}</strong></div><div className="debug-error"><span>خطأ المعالجة</span><strong>{selectedBook.metadata?.processing_error || "لا يوجد"}</strong></div></div></details>}
      </div>
    </main>
  );
}
