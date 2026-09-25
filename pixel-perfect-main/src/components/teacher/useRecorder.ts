import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "stopped";

/**
 * Microphone recorder with a real waveform. Falls back to a simulated
 * waveform when the browser blocks microphone access.
 */
export function useRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(28).fill(0.12));
  const [url, setUrl] = useState<string | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) window.clearInterval(timerRef.current);
    rafRef.current = null;
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    setSeconds(0);
    setUrl(null);
    chunksRef.current = [];
    setState("recording");
    timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRef.current = recorder;
      recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      recorder.onstop = () => {
        if (chunksRef.current.length) {
          setUrl(URL.createObjectURL(new Blob(chunksRef.current, { type: "audio/webm" })));
        }
      };
      recorder.start();

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevels((prev) => [...prev.slice(1), Math.min(1, Math.max(0.08, peak * 2.2))]);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Simulated waveform when the microphone is unavailable.
      const tick = () => {
        setLevels((prev) => [...prev.slice(1), 0.15 + Math.random() * 0.7]);
        rafRef.current = window.setTimeout(tick, 90) as unknown as number;
      };
      tick();
    }
  }, []);

  const stop = useCallback(() => {
    mediaRef.current?.state === "recording" && mediaRef.current.stop();
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(rafRef.current);
    }
    if (timerRef.current) window.clearInterval(timerRef.current);
    rafRef.current = null;
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setState("stopped");
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setState("idle");
    setSeconds(0);
    setUrl(null);
    setLevels(Array(28).fill(0.12));
  }, [cleanup]);

  return { state, seconds, levels, url, start, stop, reset };
}
