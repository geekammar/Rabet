/**
 * Shared test doubles for the wizard suites.
 *
 * `scripts/setup-neon-dev.mjs` injects every external surface, and both wizard
 * suites need the same two doubles: a terminal IO fake that answers prompts
 * from a script (so a flow that asks for something unexpected fails loudly
 * instead of hanging), and the record of subprocess calls the wizard made.
 *
 * The flow suite (`tests/wizard/setup-neon-dev.test.ts`) adds a mock database
 * on top; the replacement-VPS suite (`tests/db/wizard-reconnect.test.ts`)
 * reuses only these two against real PostgreSQL.
 */

import * as wizard from "../../scripts/setup-neon-dev.mjs";

export type RunResult = {
  code: number;
  stdout?: string;
  stderr?: string;
  signal?: string | null;
};

export type CommandCall = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
};

/**
 * Answers consumed in order. Prompts throw when nothing is queued, so a flow
 * that asks for something unexpected fails loudly instead of hanging.
 *
 * `exhausted` models an interrupted session: `isInputExhausted()` reports the
 * input stream has ended, which is how the real IO behaves when SSH dies or a
 * piped stdin runs out.
 */
export function fakeIo(
  answers: string[] = [],
  { exhausted = false }: { exhausted?: boolean } = {},
) {
  const queue = [...answers];
  const output: string[] = [];
  const prompts: string[] = [];
  let index = 0;

  const take = (message: string) => {
    prompts.push(message);

    const value = queue[index++];

    if (value === undefined) {
      throw new wizard.CancelledError(
        `test: no answer queued for prompt: ${message}`,
      );
    }

    return value;
  };

  return {
    output,
    prompts,
    answers: queue,

    write(text: string) {
      output.push(String(text));
    },

    line(text = "") {
      output.push(`${text}\n`);
    },

    async prompt({ message }: { message: string }) {
      return String(take(message)).trim();
    },

    async confirm({
      message,
      default: defaultValue = false,
    }: {
      message: string;
      default?: boolean;
    }) {
      return wizard.parseYesNo(take(message), defaultValue);
    },

    async confirmStrong({
      message,
      expected,
    }: {
      message: string;
      expected: string;
    }) {
      return take(message) === expected;
    },

    isInputExhausted() {
      return exhausted;
    },
  };
}
