// Request timing logs a line per measured request (lib/timing.ts); keep test output readable.
// Tests that check the lines replace the sink themselves.
import { timingSink } from "./lib/timing";

timingSink.log = () => {};
