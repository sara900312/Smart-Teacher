import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Sparkles } from "lucide-react";

function fmt(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const bars = [6, 11, 16, 9, 14, 20, 8, 13, 18, 10, 15, 7, 12, 17, 9, 13, 6, 11, 16, 8];

type Props = {
  duration: number;
  variant: "student" | "teacher";
  src?: string | null;
  autoPlay?: boolean;
};

/** Compact voice card used for both student recordings and teacher voice answers. */
export function AudioCard({ duration, variant, src, autoPlay }: Props) {
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isTeacher = variant === "teacher";

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setElapsed((e) => {
        if (e + 0.2 >= duration) {
          setPlaying(false);
          return 0;
        }
        return e + 0.2;
      });
    }, 200);
    return () => window.clearInterval(id);
  }, [playing, duration]);

  useEffect(() => {
    if (autoPlay) setPlaying(true);
  }, [autoPlay]);

  const toggle = () => {
    const audio = audioRef.current;
    if (audio) {
      if (playing) audio.pause();
      else void audio.play().catch(() => undefined);
    }
    setPlaying((p) => !p);
  };

  const progress = duration ? elapsed / duration : 0;

  return (
    <div
      className={[
        "flex w-[min(20rem,78vw)] items-center gap-3 rounded-2xl border px-3 py-2.5",
        isTeacher
          ? "border-border bg-surface shadow-soft"
          : "border-primary/25 bg-primary-soft",
      ].join(" ")}
    >
      {src ? <audio ref={audioRef} src={src} onEnded={() => setPlaying(false)} hidden /> : null}
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "إيقاف مؤقت" : "تشغيل"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95"
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {isTeacher ? (
          <span className="flex items-center gap-1.5 text-[0.7rem] font-medium text-muted-foreground">
            <Sparkles className="size-3 text-primary" />
            المدرس الذكي
          </span>
        ) : null}
        <div className="flex h-5 items-center gap-[3px]" aria-hidden>
          {bars.map((h, i) => {
            const active = i / bars.length <= progress;
            return (
              <span
                key={i}
                style={{ height: `${h}px` }}
                className={[
                  "w-[3px] rounded-full transition-colors",
                  active ? "bg-primary" : "bg-primary/25",
                ].join(" ")}
              />
            );
          })}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
        {!isTeacher ? <Mic className="size-3.5" /> : null}
        {fmt(playing ? duration - elapsed : duration)}
      </div>
    </div>
  );
}
