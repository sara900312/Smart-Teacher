import { useEffect } from "react";
import { Mic, PhoneOff } from "lucide-react";
import { useRecorder } from "./useRecorder";
import { Waveform } from "./Waveform";

type Props = {
  busy: boolean;
  statusLabel: string;
  onSendVoice: (seconds: number, url: string | null) => void;
  onExit: () => void;
};

/** Full voice-conversation surface: the student speaks, the teacher answers with audio. */
export function VoicePanel({ busy, statusLabel, onSendVoice, onExit }: Props) {
  const recorder = useRecorder();

  useEffect(() => {
    void recorder.start();
    return recorder.reset;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recording = recorder.state === "recording";

  return (
    <div className="fade-rise rounded-3xl border border-border bg-surface p-5 text-center shadow-lift">
      <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary-soft text-primary">
        <span className={recording ? "pulse-ring relative flex" : "flex"}>
          <Mic className="size-7" />
        </span>
      </div>
      <p className="mt-4 text-base font-semibold">تحدث مع المدرس</p>
      <p className="mt-1 text-sm text-muted-foreground">{busy ? statusLabel : "أنا أستمع..."}</p>

      <div className="mt-4 flex justify-center">
        <Waveform levels={recorder.levels} />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {recording ? (
          <button
            type="button"
            onClick={() => {
              recorder.stop();
              window.setTimeout(() => {
                onSendVoice(recorder.seconds, recorder.url);
                void recorder.start();
              }, 250);
            }}
            disabled={busy}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.02] disabled:opacity-60"
          >
            إرسال ما قلته
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void recorder.start()}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground"
          >
            تحدث مرة أخرى
          </button>
        )}
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-2 rounded-full border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <PhoneOff className="size-4" />
          إنهاء المحادثة الصوتية
        </button>
      </div>
    </div>
  );
}
