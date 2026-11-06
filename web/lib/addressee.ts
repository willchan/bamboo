// Who a phrase is said to (PRD §5.1). Free text is allowed; these are the usual ones.
export const ADDRESSEES = [
  { value: "yuesao", label: "Yuesao", chip: "阿姨" },
  { value: "nanny", label: "Nanny", chip: "阿姨" },
  { value: "toddler", label: "Toddler", chip: "宝宝" },
  { value: "anyone", label: "Anyone", chip: null },
] as const;

/** The chip on a Say card's front ("→ 阿姨"); null when there's no one in particular. */
export function addresseeChip(addressee: string | null): string | null {
  if (!addressee) return null;
  const known = ADDRESSEES.find((a) => a.value === addressee.toLowerCase());
  if (known) return known.chip ? `→ ${known.chip}` : null;
  return `→ ${addressee}`;
}
