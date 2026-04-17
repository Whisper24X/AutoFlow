const { spawn } = require("child_process");
const path = require("path");

const DEFAULT_MODEL = "composer-2-fast";
const FALLBACK_MODEL = "composer-2";

function createAbortError(message) {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function composePrompt(stepName, body, requiredSkills = []) {
  const skillLine = requiredSkills.length
    ? `必须严格按以下 skills 方法执行：${requiredSkills.join(", ")}。`
    : "若配置了 skills，请严格遵循相应方法。";
  return [
    `你是 AI 软件工程流程的执行代理，当前阶段：${stepName}。`,
    skillLine,
    "要求：输出结构化、可执行、简洁；若涉及代码改动，优先最小改动，并给出变更证据。",
    "",
    body
  ].join("\n");
}

function runCursorAgent({
  prompt,
  model = DEFAULT_MODEL,
  workspacePath,
  timeoutMs = 8 * 60 * 1000,
  signal,
  trustWorkspace = true,
  approveMcps = false,
  onStdoutChunk,
  onStderrChunk
}) {
  return new Promise((resolve) => {
    const args = [
      "agent",
      "-p",
      "--output-format",
      "text",
      "--model",
      model,
      "--workspace",
      workspacePath
    ];
    if (trustWorkspace) {
      args.push("--trust");
    }
    if (approveMcps) {
      // 与「全部允许」自动化一致：批准 MCP 服务器 + 非交互下尽量少拦截（等价于 CLI 的 Run Everything）
      args.push("--approve-mcps");
      args.push("--force");
    }
    args.push(prompt);

    const child = spawn("cursor", args, {
      cwd: workspacePath,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedByAbort = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onAbort = () => {
      killedByAbort = true;
      child.kill("SIGTERM");
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onStdoutChunk) onStdoutChunk(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onStderrChunk) onStderrChunk(text);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        command: `cursor ${args.join(" ")}`,
        timedOut,
        killedByAbort
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve({
        ok: code === 0 && !timedOut && !killedByAbort,
        exitCode: code,
        stdout,
        stderr,
        command: `cursor ${args.join(" ")}`,
        timedOut,
        killedByAbort
      });
    });
  });
}

async function runCompose({
  stepName,
  promptBody,
  model,
  workspacePath,
  timeoutMs,
  signal,
  trustWorkspace = true,
  approveMcps = false,
  requiredSkills = [],
  onStdoutChunk,
  onStderrChunk
}) {
  const useModel = model || DEFAULT_MODEL;
  const fullPrompt = composePrompt(stepName, promptBody, requiredSkills);

  let result = await runCursorAgent({
    prompt: fullPrompt,
    model: useModel,
    workspacePath,
    timeoutMs,
    signal,
    trustWorkspace,
    approveMcps,
    onStdoutChunk,
    onStderrChunk
  });

  // 快速模型失败时，自动切到 composer-2 再试一轮。
  if (!result.ok && useModel === DEFAULT_MODEL && !signal?.aborted) {
    const fallback = await runCursorAgent({
      prompt: fullPrompt,
      model: FALLBACK_MODEL,
      workspacePath,
      timeoutMs,
      signal,
      trustWorkspace,
      approveMcps,
      onStdoutChunk,
      onStderrChunk
    });
    fallback.fallbackFrom = DEFAULT_MODEL;
    result = fallback;
  }

  return {
    ...result,
    modelUsed: result.fallbackFrom ? FALLBACK_MODEL : useModel,
    requiredSkills
  };
}

function resolveWorkspace(baseDir, candidate) {
  if (!candidate) {
    return baseDir;
  }
  const abs = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(baseDir, candidate);
  return abs;
}

module.exports = {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  createAbortError,
  runCompose,
  resolveWorkspace
};
