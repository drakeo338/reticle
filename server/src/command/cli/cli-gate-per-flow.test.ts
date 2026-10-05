import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  QueryBy,
  ReticleDir,
  RunAgentKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  type RunFlowResult,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from '@/language/flows/flows.js';
import { RunStore } from '@/judgement/runs/artifact/run-store.js';
import { buildVerificationRun } from '@/judgement/runs/artifact/build-verification-run.js';
import { emitBuddyStatus, handleGate } from './cli-flow-commands.js';

const flowResult = (name: string, status: RunFlowStatus): RunFlowResult => ({
  name,
  status,
  steps: 1,
  durationMs: 1,
});

const runAt = (runId: string, at: number, flows: RunFlowResult[]) =>
  buildVerificationRun(
    {
      runId,
      durationMs: 100,
      profile: RunProfile.DEV,
      project: { name: 'demo', framework: RunFramework.REACT },
      agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
      trigger: { kind: RunTrigger.EDIT },
      changedFiles: [],
      flows,
      checks: [],
      risks: [],
      evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
    },
    () => at,
  );

describe('handleGate reads coverage per flow, not from the single newest run', () => {
  let dir: string;
  let root: string;
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-gate-'));
    root = join(dir, ReticleDir.ROOT);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const flows = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
    for (const name of ['flow-a', 'flow-b']) {
      await flows.save({
        name,
        version: 1,
        steps: [
          {
            tool: 'reticle_act',
            stable: true,
            args: { by: QueryBy.TESTID, value: name, action: ActionType.CLICK, args: {} },
          },
        ],
      });
    }
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await removeTempDir(dir);
  });

  const gateOutput = async (): Promise<{ uncovered: string[]; pass: boolean }> => {
    await handleGate(['src/app.ts'], undefined);
    const line = stderr.map((s) => s.trim()).find((s) => s.includes('"event":"reticle_gate"'));
    expect(line).toBeDefined();
    return JSON.parse(line ?? '{}') as { uncovered: string[]; pass: boolean };
  };

  it('a newer drive run with no flows does not erase an earlier passing replay', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('replay', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
    await store.write(runAt('drive', 2000, []));
    const out = await gateOutput();
    expect(out.uncovered).toEqual([]);
    expect(out.pass).toBe(true);
  });

  it('a flow whose newest result is a failure stays uncovered, even after an older pass', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('old', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
    await store.write(runAt('new', 2000, [flowResult('flow-a', RunFlowStatus.FAIL)]));
    await store.write(runAt('drive', 3000, []));
    const out = await gateOutput();
    expect(out.uncovered).toEqual(['flow-a']);
    expect(out.pass).toBe(false);
  });

  const editSource = async (atMs: number): Promise<void> => {
    await mkdir(join(dir, 'src'), { recursive: true });
    const file = join(dir, 'src', 'app.ts');
    await writeFile(file, 'export const x = 1;\n');
    await utimes(file, atMs / 1000, atMs / 1000);
  };

  it('a pass older than the edit leaves the flow uncovered, a pass newer than it does not', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(runAt('old', 1000, [flowResult('flow-a', RunFlowStatus.PASS)]));
    await store.write(runAt('fresh', 5000, [flowResult('flow-b', RunFlowStatus.PASS)]));
    await editSource(3000);
    const out = await gateOutput();
    expect(out.uncovered).toEqual(['flow-a']);
    expect(out.pass).toBe(false);
  });

  it('the status line counts the flows that pass and names the one an edit made stale', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('replay', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
        flowResult('gone', RunFlowStatus.PASS),
      ]),
    );
    await store.write(runAt('drive', 2000, []));
    const fs = createNodeFileSystem();
    const flows = [
      { name: 'flow-a', steps: [] },
      { name: 'flow-b', steps: [] },
    ];
    const status = async (affected: string[], changed: string[]): Promise<string> => {
      stderr.length = 0;
      await emitBuddyStatus(fs, root, flows, affected, changed);
      const line = stderr.map((s) => s.trim()).find((s) => s.includes('"event":"reticle_buddy"'));
      return (JSON.parse(line ?? '{}') as { status: string }).status;
    };
    // The deleted flow's pass is not counted, and the drive run did not erase the replay.
    expect(await status([], [])).toBe('✓ 2/2 flows nominal');
    await editSource(3000);
    expect(await status(['flow-a'], ['src/app.ts'])).toBe('✗ 1 deviation: flow-a · 1 nominal');
  });
});
