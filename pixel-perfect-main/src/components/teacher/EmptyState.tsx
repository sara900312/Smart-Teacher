import { GraduationCap } from "lucide-react";

const suggestions = [
  "اشرح لي هذا الموضوع ببساطة",
  "ما الفرق بين Ahmed و Sally؟",
  "اختبرني في هذا الدرس",
  "اشرح لي هذا المثال",
];

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="fade-rise mx-auto flex max-w-xl flex-col items-center px-4 py-10 text-center sm:py-16">
      <div className="pulse-ring relative flex size-16 items-center justify-center rounded-full bg-primary-soft text-primary">
        <GraduationCap className="size-8" />
      </div>
      <h2 className="mt-6 text-2xl font-semibold tracking-tight">مرحبًا 👋</h2>
      <p className="mt-1 text-lg font-medium text-primary">أنا مدرسك الذكي</p>
      <p className="mt-2 max-w-sm text-sm leading-7 text-muted-foreground">
        يمكنك سؤالي عن الدرس، كتابة سؤال، أو التحدث معي صوتيًا.
      </p>

      <div className="mt-7 grid w-full gap-2.5 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-2xl border border-border bg-surface px-4 py-3 text-start text-sm text-foreground shadow-soft transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary-soft/50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
