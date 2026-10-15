import { posix } from 'node:path';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import {
  createPodBashOps,
  createPodEditOps,
  createPodFindOps,
  createPodGrepTool,
  createPodReadOps,
  type ExecInPod,
  type K8sSandboxConfig,
} from '@moca/k8s-sandbox';
import { editOps, findOps, lsOps, readOps, writeOps } from './fewer-execs.js';

/** The sandbox's working directory: the workspace every worker tier mounts (guest-agent -workdir). */
export const WORKSPACE = '/workspace';

/** The slice of a Pi AgentTool the MCP server needs. */
export interface ServedTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>;
}

/**
 * Pi's seven tools, built exactly as k8sSandboxExtension builds them, over one exec seam. Head
 * and pod cwd are both /workspace, so path mapping is the identity and the model sees the
 * sandbox's real paths.
 */
export function buildTools(exec: ExecInPod): ServedTool[] {
  const cfg: K8sSandboxConfig = {
    pod: 'sandbox',
    namespace: '',
    context: undefined,
    podCwd: WORKSPACE,
    headCwd: WORKSPACE,
  };
  const searchExec = skipGitDir(exec);
  const podFind = findOps(createPodFindOps(searchExec, cfg));
  return [
    createReadTool(WORKSPACE, { operations: readOps(createPodReadOps(exec, cfg)) }),
    createWriteTool(WORKSPACE, { operations: writeOps(exec) }),
    createEditTool(WORKSPACE, { operations: editOps(createPodEditOps(exec, cfg)) }),
    createLsTool(WORKSPACE, { operations: lsOps(exec) }),
    createFindTool(WORKSPACE, {
      operations: {
        ...podFind,
        // Pi relativizes glob results with path.relative, which resolves a relative path against
        // the PROCESS cwd. MOCA's harness runs with process cwd == headCwd, so it never shows;
        // here the process cwd is not /workspace, so hand Pi absolute paths.
        glob: async (pattern, cwd, opts) =>
          (await podFind.glob(pattern, cwd, opts)).map((p) => posix.join(cwd, p)),
      },
    }),
    createBashTool(WORKSPACE, { operations: createPodBashOps(exec, cfg) }),
    createPodGrepTool(WORKSPACE, searchExec, cfg),
  ] as unknown as ServedTool[];
}

/**
 * The pod tools' rg runs with --hidden, which also walks .git. MOCA's pod workspaces rarely hold
 * one; this sandbox always does (sbx-push commits a baseline), so keep search out of it.
 */
function skipGitDir(exec: ExecInPod): ExecInPod {
  return (command, opts) =>
    exec(command.replace(/\brg (--files|--line-number) /, "rg $1 --glob '!.git' "), opts);
}
