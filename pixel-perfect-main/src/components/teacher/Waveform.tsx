export function Waveform({ levels, compact }: { levels: number[]; compact?: boolean }) {
  const max = compact ? 22 : 44;
  return (
    <div
      className={compact ? "flex h-6 items-center gap-[3px]" : "flex h-12 items-center gap-[3px]"}
      aria-hidden
    >
      {levels.map((l, i) => (
        <span
          key={i}
          style={{ height: `${Math.max(3, l * max)}px` }}
          className="w-[3px] rounded-full bg-primary/70 transition-[height] duration-100"
        />
      ))}
    </div>
  );
}
