// Mock teacher replies (UI-only prototype — no backend calls).

const replies: string[] = [
  `## الفكرة باختصار
الدرس يتحدث عن **الصداقة** وكيف نصف أصدقاءنا بالإنجليزية.

- نستعمل \`is / are\` للوصف
- الصفة تأتي **قبل** الاسم: *a good friend*
- ننفي بـ \`is not / isn't\`

> جرّب الآن: صف صديقك في جملتين فقط.`,
  `### الفرق بين الشخصيتين
1. **Ahmed** — يحب الرياضة ويتحدث كثيرًا مع أصدقائه.
2. **Sally** — هادئة، تحب القراءة والرسم.

المشترك بينهما أنهما **يساعدان الآخرين**، وهذا جوهر الدرس.`,
  `تمام، لنحلّها خطوة بخطوة:

1. اكتب المعطيات.
2. اختر القاعدة المناسبة.
3. عوّض ثم بسّط.

النتيجة النهائية تكون واضحة عندما ترتب خطواتك هكذا. هل تريد تمرينًا مشابهًا؟`,
  `### اختبار سريع
- ما معنى كلمة *honest*؟
- كوّن جملة تصف صديقك المفضل.
- أكمل: My friend \\_\\_\\_ very kind.

أجب وسأصحح لك مباشرة.`,
];

export function mockTeacherReply(seed: number): string {
  return replies[seed % replies.length] ?? replies[0]!;
}

export function mockVoiceDuration(seed: number): number {
  return 18 + (seed * 7) % 34;
}
