// ts-fsrs card states, as numbers (stored in `card.state`). Kept apart from fsrs.ts so client code
// (the review screen uses session.ts) doesn't bundle the scheduler.
export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 } as const;
