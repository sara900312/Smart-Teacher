import { Fragment, type ReactNode } from "react";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-accent-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic text-muted-foreground">
          {token.slice(1, -1)}
        </em>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.map((n, idx) => <Fragment key={`${keyPrefix}-f-${idx}`}>{n}</Fragment>);
}

/** Lightweight, tidy renderer for the teacher's formatted answers. */
export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = (key: string) => {
    if (!list) return;
    const items = list.items.map((item, i) => (
      <li key={`${key}-li-${i}`} className="marker:text-primary">
        {inline(item, `${key}-li-${i}`)}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={key} className="me-1 list-decimal space-y-1.5 ps-5 text-[0.95rem] leading-7">
          {items}
        </ol>
      ) : (
        <ul key={key} className="me-1 list-disc space-y-1.5 ps-5 text-[0.95rem] leading-7">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    const key = `b-${index}`;
    if (!line.trim()) {
      flush(`${key}-l`);
      return;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush(`${key}-l`);
      const level = (heading[1] ?? "#").length;
      blocks.push(
        <p
          key={key}
          className={
            level <= 2
              ? "pt-1 text-base font-semibold text-foreground"
              : "pt-1 text-[0.95rem] font-semibold text-foreground"
          }
        >
          {inline(heading[2] ?? "", key)}
        </p>,
      );
      return;
    }
    if (line.startsWith("> ")) {
      flush(`${key}-l`);
      blocks.push(
        <p
          key={key}
          className="rounded-xl border-s-2 border-primary bg-primary-soft/60 px-3 py-2 text-[0.92rem] leading-7"
        >
          {inline(line.slice(2), key)}
        </p>,
      );
      return;
    }
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (ordered || bullet) {
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flush(`${key}-l`);
        list = { ordered: isOrdered, items: [] };
      }
      const item = (ordered ? ordered[1] : bullet?.[1]) ?? "";
      (list as { ordered: boolean; items: string[] }).items.push(item.replace(/\\_/g, "_"));
      return;
    }
    flush(`${key}-l`);
    blocks.push(
      <p key={key} className="text-[0.95rem] leading-8">
        {inline(line, key)}
      </p>,
    );
  });
  flush("b-final");

  return <div className="space-y-3">{blocks}</div>;
}
