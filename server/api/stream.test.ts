import { expect, test } from "bun:test";
import { streamHandler } from "./stream.ts";

test("does not start periodic pushes when the client disconnects during the initial push", async () => {
  let resolveInitialPush!: () => void;
  const initialPush = new Promise<void>((resolve) => {
    resolveInitialPush = resolve;
  });
  let homeCalls = 0;

  const response = streamHandler({
    homeHandler: async () => {
      homeCalls += 1;
      await initialPush;
      return Response.json({ data: { homeCalls } });
    },
    pushIntervalMs: 5,
    heartbeatIntervalMs: 5,
  });

  const cancellation = response.body!.cancel();
  resolveInitialPush();
  await cancellation;
  await Bun.sleep(20);

  expect(homeCalls).toBe(1);
});
