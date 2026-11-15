// Reproduction for #19389: stale unclickable Thinking rows after history replacement.
// Run with the MSW dev server: VITE_DO_NOT_TRACK=1 VITE_MOCK_API=true npx react-router dev --port 3193
// Usage: node .pr/bugs/thinking-row-keys/reproduce.mjs before|after <outputDir>
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const mode = process.argv[2] ?? "before";
const output = process.argv[3] ?? `.pr/bugs/thinking-row-keys/${mode}`;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.setDefaultTimeout(20000);

const keyErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" && m.text().toLowerCase().includes("key")) {
    keyErrors.push(m.text().slice(0, 300));
  }
});

await page.addInitScript(() => {
  localStorage.setItem("openhands-onboarded", "1");
  localStorage.setItem(
    "openhands-backends",
    JSON.stringify([
      {
        id: "default-local",
        name: "Synthetic history fixture",
        host: location.origin,
        apiKey: "mock-session-key",
        kind: "local",
      },
    ]),
  );
  localStorage.setItem(
    "openhands-active-backend",
    JSON.stringify({ backendId: "default-local", orgId: null }),
  );
  localStorage.setItem("analytics-consent", "false");
  localStorage.setItem("openhands-telemetry-consent", "denied");
  localStorage.setItem("openhands-telemetry-first-use", "true");
});

try {
  await page.goto("http://127.0.0.1:3193/conversations/2", {
    waitUntil: "domcontentloaded",
  });
  await page.getByTestId("chat-scroll-container").waitFor();
  await page.waitForTimeout(1500);
  const consent = page.getByRole("button", { name: "Confirm preferences" });
  if (await consent.isVisible().catch(() => false)) {
    await page.getByRole("checkbox").uncheck();
    await consent.click();
    await page.waitForTimeout(500);
  }

  // Synthetic history: 8 completed tool calls, each with reasoning_content and a
  // visible thought, separated by user messages. No model or private data.
  await page.evaluate(async () => {
    const { useEventStore } = await import("/src/stores/use-event-store.ts");
    const events = [];
    let seq = 0;
    const stamp = () =>
      new Date(Date.UTC(2026, 10, 5, 12, 0, seq++)).toISOString();
    for (let i = 0; i < 8; i++) {
      const id = `old-${i}`;
      events.push({
        id,
        timestamp: stamp(),
        source: "agent",
        thought: [{ type: "text", text: `Checking step ${i + 1}` }],
        reasoning_content: `Reasoning for step ${i + 1}`,
        thinking_blocks: [],
        action: {
          kind: "ExecuteBashAction",
          command: "pwd",
          is_input: false,
          timeout: null,
          reset: false,
        },
        tool_name: "execute_bash",
        tool_call_id: `call_${id}`,
        tool_call: {
          id: `call_${id}`,
          type: "function",
          function: { name: "execute_bash", arguments: '{"command":"pwd"}' },
        },
        llm_response_id: `response_${id}`,
        security_risk: "LOW",
      });
      events.push({
        id: `obs-${i}`,
        timestamp: stamp(),
        source: "environment",
        tool_name: "execute_bash",
        tool_call_id: `call_${id}`,
        action_id: id,
        observation: {
          kind: "ExecuteBashObservation",
          content: [{ type: "text", text: "/workspace/project" }],
          command: "pwd",
          exit_code: 0,
          error: false,
          timeout: false,
          metadata: {},
        },
      });
      events.push({
        id: `prompt-${i}`,
        timestamp: stamp(),
        source: "user",
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "Continue to the next step." }],
        },
        activated_skills: [],
        extended_content: [],
      });
    }
    useEventStore.getState().clearEvents();
    useEventStore.getState().addEvents(events);
  });

  await page.getByTestId("event-group-toggle").first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${output}/01-history-loaded.png`, fullPage: false });

  const togglesBefore = await page
    .getByTestId("event-group-toggle")
    .count();
  const thinkingBefore = await page.getByTestId("collapsible-thinking").count();

  // Replace the displayed history with another conversation's user message
  // while the message list stays mounted.
  await page.evaluate(async () => {
    const { useEventStore } = await import("/src/stores/use-event-store.ts");
    useEventStore.getState().clearEvents();
    useEventStore.getState().addEvents([
      {
        id: "new-prompt",
        timestamp: "2026-11-05T13:00:00Z",
        source: "user",
        llm_message: {
          role: "user",
          content: [
            { type: "text", text: "This is the newly loaded conversation." },
          ],
        },
        activated_skills: [],
        extended_content: [],
      },
    ]);
  });
  await page.waitForTimeout(1000);

  await page.screenshot({ path: `${output}/02-after-replacement.png`, fullPage: false });
  const togglesAfter = await page.getByTestId("event-group-toggle").count();
  const thinkingAfter = await page.getByTestId("collapsible-thinking").count();

  console.log(
    JSON.stringify(
      {
        mode,
        togglesBefore,
        thinkingBefore,
        togglesAfter,
        thinkingAfter,
        keyErrors: keyErrors.length,
        keyErrorSample: keyErrors.slice(0, 3),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
