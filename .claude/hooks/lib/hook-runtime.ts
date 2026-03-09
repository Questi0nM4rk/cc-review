/**
 * Shared hook runtime for cc-review hooks.
 * Typed input, pure primitives, process.stdin (works with Node/tsx).
 */

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    process.stderr.write("[hook-runtime] invalid JSON on stdin\n");
    process.exit(0);
  }
}

export function allow(): never {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
}

export function block(reason: string): never {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

export function extractCommand(toolInput: Record<string, unknown>): string {
  const cmd = toolInput.command;
  return typeof cmd === "string" ? cmd : "";
}
