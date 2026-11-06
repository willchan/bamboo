import { householdTimeZone } from "../config";
import type { Clock } from "./review";

/** The real clock, in the household's time zone. */
export const serverClock = (): Clock => ({ now: Date.now(), timeZone: householdTimeZone() });
