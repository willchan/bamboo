// Hanzi with ruby pinyin above each character (DESIGN §6). Non-hanzi characters render bare.
type Pairs = readonly (readonly [string, string | null])[];

export function Ruby({ pairs, className = "" }: { pairs: Pairs; className?: string }) {
  return (
    <span className={`hanzi inline-flex flex-wrap items-end ${className}`} lang="zh-CN">
      {pairs.map(([char, syllable], i) =>
        syllable ? (
          <ruby key={i} className="ruby-cell">
            {char}
            <rt>{syllable}</rt>
          </ruby>
        ) : (
          <span key={i} className={char === " " ? "w-[0.3em]" : undefined}>
            {char}
          </span>
        ),
      )}
    </span>
  );
}
