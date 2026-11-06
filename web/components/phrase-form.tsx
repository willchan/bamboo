"use client";
// The phrase editor: add or edit, with examples (terms), pinyin overrides and card types.
import Link from "next/link";
import { useActionState, useState } from "react";
import { savePhraseAction, type PhraseFormState } from "@/app/actions";
import { ADDRESSEES } from "@/lib/addressee";
import { MAX_EXAMPLE_ROWS } from "@/lib/phrase-form";

type Pairs = [string, string | null][];

export interface PhraseFormValues {
  id: string | null;
  kind: "term" | "frame" | "sentence";
  hanzi: string;
  english: string;
  addressee: string | null;
  heardAs: string | null;
  note: string | null;
  tags: string[];
  examples: { hanzi: string; english: string | null }[];
  cardTypes: ("say" | "listen")[];
  /** Computed pinyin and Will's overrides, for the saved hanzi (edit only). */
  pinyin: Pairs | null;
  pinyinOverride: Pairs | null;
}

const KIND_HELP = {
  term: "A word or short compound",
  frame: "A pattern with a slot: …",
  sentence: "A full thing to say",
} as const;

const field = "h-11 w-full rounded-xl border border-border bg-card px-3";
const label = "flex flex-col gap-1 text-sm font-medium";

export function PhraseForm({ values }: { values: PhraseFormValues }) {
  const [state, action, pending] = useActionState<PhraseFormState, FormData>(savePhraseAction, {});
  const [kind, setKind] = useState(values.kind);
  const [hanzi, setHanzi] = useState(values.hanzi);
  const hanziChanged = values.pinyin !== null && hanzi.trim() !== values.hanzi;

  return (
    <form action={action} className="flex flex-col gap-5">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      {state.errors?.length ? (
        <div role="alert" className="rounded-xl border border-danger p-3 text-sm text-danger">
          {state.errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
          {state.duplicateId ? (
            <Link href={`/phrases/${state.duplicateId}`} className="underline underline-offset-4">
              Open the existing one
            </Link>
          ) : null}
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Kind</legend>
        <div className="grid grid-cols-3 gap-2">
          {(["term", "frame", "sentence"] as const).map((k) => (
            <label
              key={k}
              className={`flex h-11 cursor-pointer items-center justify-center rounded-xl border text-sm capitalize ${
                kind === k ? "border-primary bg-primary/10 font-semibold" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="sr-only"
              />
              {k}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">{KIND_HELP[kind]}</p>
      </fieldset>

      <label className={label}>
        Chinese
        <input
          name="hanzi"
          required
          value={hanzi}
          onChange={(e) => setHanzi(e.target.value)}
          lang="zh-CN"
          autoComplete="off"
          className={`${field} hanzi text-lg`}
        />
      </label>

      {values.pinyin ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Pinyin</legend>
          {hanziChanged ? (
            <p className="text-xs text-muted">
              The Chinese changed: pinyin is recomputed on save
              {values.pinyinOverride ? ", and your pinyin edits are dropped" : ""}.
            </p>
          ) : (
            <>
              <input type="hidden" name="pinyinFor" value={values.hanzi} />
              <input type="hidden" name="pinyinCount" value={values.pinyin.length} />
              <div className="flex flex-wrap gap-2">
                {values.pinyin.map(([char, computed], i) =>
                  computed === null ? (
                    <input key={i} type="hidden" name={`py${i}`} value="" />
                  ) : (
                    <label key={i} className="flex w-16 flex-col items-center gap-1">
                      <span className="hanzi text-xl" lang="zh-CN">
                        {char}
                      </span>
                      <input
                        name={`py${i}`}
                        defaultValue={values.pinyinOverride?.[i]?.[1] ?? ""}
                        placeholder={computed}
                        aria-label={`Pinyin for ${char}`}
                        autoCapitalize="none"
                        autoCorrect="off"
                        className="h-9 w-full rounded-lg border border-border bg-card text-center text-sm"
                      />
                    </label>
                  ),
                )}
              </div>
              <p className="text-xs text-muted">
                Blank = computed. Type a fix like <i>dei3</i> or <i>děi</i> for polyphones.
              </p>
            </>
          )}
        </fieldset>
      ) : null}

      <label className={label}>
        {kind === "term" ? "English meaning" : "English intent"}
        <input name="english" required defaultValue={values.english} className={field} />
      </label>

      <label className={label}>
        Who it&apos;s for
        <input
          name="addressee"
          list="addressees"
          defaultValue={values.addressee ?? ""}
          placeholder="yuesao, toddler, nanny, anyone"
          autoCapitalize="none"
          className={field}
        />
        <datalist id="addressees">
          {ADDRESSEES.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </datalist>
      </label>

      <label className={label}>
        What you heard (optional)
        <input
          name="heardAs"
          defaultValue={values.heardAs ?? ""}
          placeholder="podafen"
          autoCapitalize="none"
          className={field}
        />
      </label>

      {kind === "term" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Examples (up to 3)</legend>
          {Array.from({ length: MAX_EXAMPLE_ROWS }, (_, i) => (
            <div key={i} className="flex flex-col gap-1 rounded-xl border border-border p-2">
              <input
                name={`example${i}Hanzi`}
                defaultValue={values.examples[i]?.hanzi ?? ""}
                placeholder="Example sentence in Chinese"
                lang="zh-CN"
                aria-label={`Example ${i + 1} Chinese`}
                className="hanzi h-10 rounded-lg bg-card px-2"
              />
              <input
                name={`example${i}English`}
                defaultValue={values.examples[i]?.english ?? ""}
                placeholder="English"
                aria-label={`Example ${i + 1} English`}
                className="h-10 rounded-lg bg-card px-2 text-sm"
              />
            </div>
          ))}
        </fieldset>
      ) : null}

      <label className={label}>
        Note (optional)
        <textarea
          name="note"
          defaultValue={values.note ?? ""}
          rows={2}
          className="w-full rounded-xl border border-border bg-card p-3"
        />
      </label>

      <label className={label}>
        Tags
        <input
          name="tags"
          defaultValue={values.tags.join(", ")}
          placeholder="feeding, baby, food, groceries, household, toddler, units"
          autoCapitalize="none"
          className={field}
        />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Cards</legend>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            name="cardTypes"
            value="say"
            defaultChecked={values.cardTypes.includes("say")}
            className="size-5"
          />
          Say it: English → you say the Chinese
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            name="cardTypes"
            value="listen"
            defaultChecked={values.cardTypes.includes("listen")}
            className="size-5"
          />
          Listen: hear it → recall the meaning
        </label>
      </fieldset>

      <button
        type="submit"
        disabled={pending}
        className="h-14 rounded-2xl bg-primary text-lg font-semibold text-primary-foreground disabled:opacity-60"
      >
        {pending ? "Saving…" : values.id ? "Save" : "Add phrase"}
      </button>
    </form>
  );
}
