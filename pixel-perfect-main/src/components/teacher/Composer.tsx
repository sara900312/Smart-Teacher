import { useEffect, useRef, useState } from "react";
import { Camera, ImageIcon, Mic, Paperclip, Plus, RotateCcw, Send, Square, X } from "lucide-react";
import { useRecorder } from "./useRecorder";
import { Waveform } from "./Waveform";

function fmt(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

type Props = {
  disabled?: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onSendText: (text: string, image?: { name: string; url: string }) => void;
  onSendVoice: (seconds: number, url: string | null) => void;
};

export function Composer({ disabled, draft, onDraftChange, onSendText, onSendVoice }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [image, setImage] = useState<{ name: string; url: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const recorder = useRecorder();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const send = () => {
    if (disabled) return;
    const text = draft.trim();
    if (!text && !image) return;
    onSendText(text, image ?? undefined);
    setImage(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const pickFile = (accept: string) => {
    setMenuOpen(false);
    if (fileRef.current) {
      fileRef.current.accept = accept;
      fileRef.current.click();
    }
  };

  if (recorder.state !== "idle") {
    const recording = recorder.state === "recording";
    return (
      <div className="rounded-3xl border border-border bg-surface p-3 shadow-lift">
        <div className="flex items-center gap-3">
          <span
            className={[
              "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium",
              recording ? "bg-destructive/10 text-destructive" : "bg-primary-soft text-primary",
            ].join(" ")}
          >
            {recording ? <span className="size-2 animate-pulse rounded-full bg-destructive" /> : null}
            {recording ? "جاري التسجيل" : "معاينة التسجيل"}
          </span>
          <Waveform levels={recorder.levels} compact />
          <span className="ms-auto text-sm tabular-nums text-muted-foreground">
            {fmt(recorder.seconds)}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {recording ? (
            <button
              type="button"
              onClick={recorder.stop}
              className="flex items-center gap-2 rounded-full bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
            >
              <Square className="size-3.5" /> إيقاف
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  onSendVoice(recorder.seconds, recorder.url);
                  recorder.reset();
                }}
                className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.02]"
              >
                <Send className="size-4 -scale-x-100" /> إرسال
              </button>
              <button
                type="button"
                onClick={() => void recorder.start()}
                className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-2"
              >
                <RotateCcw className="size-4" /> إعادة
              </button>
            </>
          )}
          <button
            type="button"
            onClick={recorder.reset}
            className="ms-auto rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            إلغاء
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-border bg-surface p-2 shadow-lift transition-shadow focus-within:border-primary/40">
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) setImage({ name: file.name, url: URL.createObjectURL(file) });
          e.target.value = "";
        }}
      />

      {image ? (
        <div className="fade-rise mb-2 flex items-center gap-2 rounded-2xl border border-border bg-surface-2 px-3 py-2">
          <img src={image.url} alt="" className="size-9 rounded-lg object-cover" />
          <span className="truncate text-sm text-foreground">{image.name}</span>
          <button
            type="button"
            onClick={() => setImage(null)}
            aria-label="إزالة الصورة"
            className="ms-auto rounded-full p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      <div className="flex items-end gap-1.5">
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="إضافة مرفق"
            className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Plus className={`size-5 transition-transform ${menuOpen ? "rotate-45" : ""}`} />
          </button>
          {menuOpen ? (
            <div className="fade-rise absolute bottom-12 start-0 z-20 w-44 overflow-hidden rounded-2xl border border-border bg-popover p-1 shadow-lift">
              {[
                { icon: Camera, label: "صورة", accept: "image/*" },
                { icon: ImageIcon, label: "صورة من الجهاز", accept: "image/*" },
                { icon: Paperclip, label: "ملف", accept: "*/*" },
              ].map(({ icon: Icon, label, accept }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => pickFile(accept)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-surface-2"
                >
                  <Icon className="size-4 text-primary" />
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={image ? "اكتب ماذا تريد مني أن أفعل بهذه الصورة..." : "اكتب سؤالك..."}
          className="max-h-40 flex-1 resize-none bg-transparent px-1 py-2.5 text-[0.95rem] leading-7 outline-none placeholder:text-muted-foreground"
        />

        <button
          type="button"
          onClick={() => void recorder.start()}
          aria-label="تسجيل صوتي"
          className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-primary"
        >
          <Mic className="size-5" />
        </button>

        <button
          type="button"
          onClick={send}
          disabled={disabled || (!draft.trim() && !image)}
          aria-label="إرسال"
          className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-105 disabled:scale-100 disabled:bg-surface-2 disabled:text-muted-foreground"
        >
          <Send className="size-[18px] -scale-x-100" />
        </button>
      </div>
    </div>
  );
}
