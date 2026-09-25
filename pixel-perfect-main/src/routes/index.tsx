import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, GraduationCap, MessageSquareText, Mic2, X } from "lucide-react";
import { AudioCard } from "@/components/teacher/AudioCard";
import { Composer } from "@/components/teacher/Composer";
import { EmptyState } from "@/components/teacher/EmptyState";
import { MarkdownLite } from "@/components/teacher/MarkdownLite";
import { VoicePanel } from "@/components/teacher/VoicePanel";
import { mockTeacherReply, mockVoiceDuration } from "@/lib/teacher-mock";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "المدرس الذكي — محادثة تعليمية بالذكاء الاصطناعي" },
      {
        name: "description",
        content: "اسأل، ناقش، أو تحدث صوتيًا مع مدرسك الذكي حول درسك الحالي.",
      },
      { property: "og:title", content: "المدرس الذكي" },
      {
        property: "og:description",
        content: "تجربة محادثة حديثة مع مدرس ذكي: نص، صوت، وأسئلة بالصور.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TeacherPage,
});

type Message =
  | {
      id: string;
      role: "student";
      kind: "text";
      text: string;
      image?: { name: string; url: string } | undefined;
    }
  | { id: string; role: "student"; kind: "voice"; seconds: number; url: string | null }
  | { id: string; role: "teacher"; kind: "text"; text: string }
  | { id: string; role: "teacher"; kind: "voice"; seconds: number; text: string };

type Status = "idle" | "transcribing" | "thinking" | "speaking" | "playing";

const statusLabels: Record<Status, string> = {
  idle: "جاهز",
  transcribing: "أفهم كلامك...",
  thinking: "أفكر...",
  speaking: "أجهز الرد الصوتي...",
  playing: "المدرس يتحدث...",
};

let counter = 0;
const nextId = () => `m${++counter}`;

function TeacherPage() {
  const [mode, setMode] = useState<"text" | "voice">("text");
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [draft, setDraft] = useState("");
  const [showContext, setShowContext] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  const busy = status !== "idle";
  const replySeed = useMemo(() => messages.length, [messages.length]);

  const after = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const sendText = (text: string, image?: { name: string; url: string }) => {
    setMessages((m) => [...m, { id: nextId(), role: "student", kind: "text", text, image }]);
    setDraft("");
    setStatus("thinking");
    after(1200, () => {
      setMessages((m) => [
        ...m,
        { id: nextId(), role: "teacher", kind: "text", text: mockTeacherReply(replySeed) },
      ]);
      setStatus("idle");
    });
  };

  const sendVoice = (seconds: number, url: string | null) => {
    setMessages((m) => [
      ...m,
      { id: nextId(), role: "student", kind: "voice", seconds: Math.max(1, seconds), url },
    ]);
    setStatus("transcribing");
    after(900, () => setStatus("thinking"));
    after(2000, () => {
      if (mode === "voice") {
        setStatus("speaking");
        after(900, () => {
          setMessages((m) => [
            ...m,
            {
              id: nextId(),
              role: "teacher",
              kind: "voice",
              seconds: mockVoiceDuration(replySeed),
              text: mockTeacherReply(replySeed),
            },
          ]);
          setStatus("playing");
          after(1800, () => setStatus("idle"));
        });
      } else {
        setMessages((m) => [
          ...m,
          { id: nextId(), role: "teacher", kind: "text", text: mockTeacherReply(replySeed) },
        ]);
        setStatus("idle");
      }
    });
  };

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
            <GraduationCap className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[0.98rem] font-semibold leading-tight">المدرس الذكي</h1>
            <p className="truncate text-xs text-muted-foreground">
              اسأل، ناقش، أو تحدث مع مدرسك بالذكاء الاصطناعي
            </p>
          </div>

          <span className="hidden items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground sm:flex">
            <span
              className={`size-1.5 rounded-full ${busy ? "animate-pulse bg-primary" : "bg-primary"}`}
            />
            {statusLabels[status]}
          </span>

          <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-2 p-1">
            {(
              [
                { key: "text", label: "نص", icon: MessageSquareText },
                { key: "voice", label: "صوت", icon: Mic2 },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={[
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                  mode === key
                    ? "bg-surface text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="chat-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pb-6">
          {showContext ? (
            <div className="fade-rise mt-4 flex items-center gap-2.5 rounded-2xl border border-border bg-surface px-3.5 py-2.5 shadow-soft">
              <BookOpen className="size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1 text-xs leading-5">
                <p className="text-muted-foreground">المادة الحالية</p>
                <p className="truncate font-medium text-foreground">
                  كتاب الإنكليزي · Lesson 7: Good friends · صفحة 42
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowContext(false)}
                aria-label="إخفاء المادة"
                className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : null}

          {messages.length === 0 ? (
            <EmptyState
              onPick={(t) => {
                setMode("text");
                sendText(t);
              }}
            />
          ) : (
            <div className="space-y-5 py-6">
              {messages.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
              {busy ? (
                <div className="fade-rise flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        style={{ animationDelay: `${i * 0.15}s` }}
                        className="size-1.5 animate-bounce rounded-full bg-primary"
                      />
                    ))}
                  </span>
                  {statusLabels[status]}
                </div>
              ) : null}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <footer className="sticky bottom-0 border-t border-border/70 bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          {mode === "voice" ? (
            <VoicePanel
              busy={busy}
              statusLabel={statusLabels[status]}
              onSendVoice={sendVoice}
              onExit={() => setMode("text")}
            />
          ) : (
            <Composer
              disabled={busy}
              draft={draft}
              onDraftChange={setDraft}
              onSendText={sendText}
              onSendVoice={sendVoice}
            />
          )}
          <p className="mt-2 text-center text-[0.7rem] text-muted-foreground">
            اضغط Enter للإرسال · Shift + Enter لسطر جديد
          </p>
        </div>
      </footer>
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  const isStudent = message.role === "student";

  return (
    <div className={`fade-rise flex ${isStudent ? "justify-start" : "justify-end"}`}>
      <div className={`flex max-w-[88%] flex-col gap-2 ${isStudent ? "items-start" : "items-end"}`}>
        {!isStudent ? (
          <span className="flex items-center gap-1.5 text-[0.7rem] font-medium text-muted-foreground">
            <GraduationCap className="size-3.5 text-primary" />
            المدرس الذكي
          </span>
        ) : null}

        {message.kind === "voice" ? (
          <AudioCard
            duration={message.seconds}
            variant={isStudent ? "student" : "teacher"}
            src={isStudent ? (message as { url: string | null }).url : null}
            autoPlay={!isStudent}
          />
        ) : isStudent ? (
          <div className="rounded-3xl rounded-ss-md bg-primary px-4 py-2.5 text-primary-foreground shadow-soft">
            {message.image ? (
              <img
                src={message.image.url}
                alt=""
                className="mb-2 max-h-48 rounded-2xl object-cover"
              />
            ) : null}
            {message.text ? (
              <p className="whitespace-pre-wrap text-[0.95rem] leading-7">{message.text}</p>
            ) : null}
          </div>
        ) : (
          <div className="text-foreground">
            <MarkdownLite text={message.text} />
          </div>
        )}
      </div>
    </div>
  );
}
