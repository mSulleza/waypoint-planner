import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Reply, Request, World } from './data'
import { deltas } from './deltas'
import { asRefusal, messageOf } from './errors'
import { compareTool } from './tools/compare'
import { getDebt } from './tools/read/debt'
import { getLedger } from './tools/read/ledger'
import { listOpen } from './tools/read/open'
import { getOverview } from './tools/read/overview'
import { listPlan } from './tools/read/plan'
import { basis, type ReadTool } from './tools/read/shape'
import { deleteTransactions } from './tools/write/delete'
import { upsertPlanItem } from './tools/write/item'
import { setLink } from './tools/write/link'
import { postTransactions } from './tools/write/post'
import { balancesOf, type WriteIO, type WriteTool } from './tools/write/shape'
import { addStatement } from './tools/write/statement'

export const READ_TOOLS = [getOverview, listOpen, listPlan, getLedger, getDebt] as const
export const WRITE_TOOLS = [postTransactions, deleteTransactions, setLink, upsertPlanItem, addStatement] as const

export interface ServerDeps {
  // One export plus the day's rates, walked; it throws an AgentError the agent can act on.
  world(): Promise<World>
  // One request as the signed-in user, so row-level security and every check apply.
  send(request: Request): Promise<Reply>
}

// Compact JSON: the agent reads it, and every byte is context.
async function answer(run: () => unknown): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: messageOf(error) }] }
  }
}

// The household before the write and after it, each from its own export, so what moved is the engine's answer on both (spec §9).
export async function written(deps: ServerDeps, tool: WriteTool, args: unknown): Promise<unknown> {
  const before = await deps.world()
  let after: Promise<World> | null = null
  const io: WriteIO = { before, send: (request) => deps.send(request), after: () => (after ??= deps.world()) }
  // What the tool refuses is JSON; a household that could not be read first is not a refusal of the write.
  const { link, ...fields } = await tool.run(io, args).catch((error: unknown) => {
    throw asRefusal(error)
  })
  let world: World
  try {
    world = await io.after()
  } catch (error) {
    // The write stands; only the second read failed, so the answer must not read as a refusal.
    return { ...fields, balances_after: null, changes: null, problem: `Saved, but reading the household again failed: ${messageOf(error).replace(/\.?$/, '.')} Call get_overview to see it.`, link }
  }
  return { ...fields, balances_after: balancesOf(world), changes: await deltas(before, world), basis: basis(world), link }
}

// The SDK checks the arguments against the tool's core schema before the tool runs.
function register(server: McpServer, deps: ServerDeps, tool: ReadTool): void {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: true, openWorldHint: false } }, (args) =>
    answer(async () => tool.run(await deps.world(), args)),
  )
}

function registerWrite(server: McpServer, deps: ServerDeps, tool: WriteTool): void {
  const annotations = { readOnlyHint: false, destructiveHint: tool.destructive, idempotentHint: tool.idempotent, openWorldHint: false }
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations }, (args) => answer(() => written(deps, tool, args)))
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'waypoint', version: '0.0.0' })
  for (const tool of READ_TOOLS) register(server, deps, tool)
  for (const tool of WRITE_TOOLS) registerWrite(server, deps, tool)
  // compare saves nothing, so it reads like the read tools.
  register(server, deps, compareTool)
  return server
}
