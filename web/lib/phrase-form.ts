// The phrase editor's form fields → the raw `PhraseInput` (validated by its Zod schema).
import type { PhraseInputRaw } from "./domain/phrase";

export const MAX_EXAMPLE_ROWS = 3;

const str = (fd: FormData, key: string): string => {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
};

/** Tags are typed comma-separated (English or Chinese commas). */
export const splitTags = (s: string): string[] => s.split(/[,，、]/u);

export function phraseFormToInput(fd: FormData): PhraseInputRaw {
  const hanzi = str(fd, "hanzi");
  const examples = Array.from({ length: MAX_EXAMPLE_ROWS }, (_, i) => ({
    hanzi: str(fd, `example${i}Hanzi`),
    english: str(fd, `example${i}English`),
  }));
  // Syllable inputs line up with the hanzi they were rendered for; if Will changed the hanzi in
  // the same save, they no longer apply.
  const pinyinFor = fd.get("pinyinFor");
  const count = Number(str(fd, "pinyinCount")) || 0;
  const pinyinEdits =
    typeof pinyinFor === "string" && pinyinFor === hanzi && count > 0
      ? Array.from({ length: count }, (_, i) => str(fd, `py${i}`))
      : undefined;

  return {
    kind: str(fd, "kind") as PhraseInputRaw["kind"],
    hanzi,
    english: str(fd, "english"),
    addressee: str(fd, "addressee"),
    heardAs: str(fd, "heardAs"),
    note: str(fd, "note"),
    tags: splitTags(str(fd, "tags")),
    examples,
    cardTypes: fd
      .getAll("cardTypes")
      .filter((v): v is string => typeof v === "string") as PhraseInputRaw["cardTypes"],
    pinyinEdits,
  };
}
