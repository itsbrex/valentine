// Headless `valentine init --provider onnx` end-to-end via a subprocess with
// HOME pointed at a temp dir (config lands in $HOME/.valentine/config.json).
// stdin is not a TTY under execFileSync, so init is headless automatically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("init --provider onnx writes provider, default model, and dtype", () => {
  const home = mkdtempSync(join(tmpdir(), "valentine-test-"));
  execFileSync(
    "npx",
    [
      "tsx", "src/cli.ts", "init",
      "--provider", "onnx",
      "--onnx-dtype", "q4f16",
      "--crm", "attio",
      "--crm-key", "test-key-0123456789",
    ],
    { env: { ...process.env, HOME: home }, stdio: "pipe" },
  );
  const cfg = JSON.parse(readFileSync(join(home, ".valentine", "config.json"), "utf8"));
  assert.equal(cfg.provider, "onnx");
  assert.equal(cfg.model, "LiquidAI/LFM2.5-2.6B-ONNX");
  assert.equal(cfg.onnxDtype, "q4f16");
});

test("init --provider onnx rejects a bad dtype", () => {
  const home = mkdtempSync(join(tmpdir(), "valentine-test-"));
  assert.throws(() =>
    execFileSync(
      "npx",
      ["tsx", "src/cli.ts", "init", "--provider", "onnx", "--onnx-dtype", "q2",
       "--crm", "attio", "--crm-key", "test-key-0123456789"],
      { env: { ...process.env, HOME: home }, stdio: "pipe" },
    ),
  );
});
