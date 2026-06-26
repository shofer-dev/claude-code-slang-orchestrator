/**
 * Workflow discovery + parsing.
 *
 * Finds `.slang` files in the project (`.claude/workflows/`) and global
 * (`~/.claude/workflows/`) directories, parses them with the vendored slang stack, and
 * runs static analysis — the data behind the `list_workflows` and `validate_workflow`
 * MCP tools.
 */
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseSlang, validateSlangAST } from "./slang/slang-parser"
import type { FlowDecl } from "./slang/slang-ast"

export interface WorkflowParam {
	name: string
	paramType: string
	description?: string
}

export interface WorkflowSummary {
	/** Flow name (machine identifier). */
	name: string
	title?: string
	description?: string
	params: WorkflowParam[]
	/** Count of declared agents in the flow body. */
	agentCount: number
	/** Absolute path of the source `.slang` file. */
	path: string
	/** "project" (.claude/workflows) or "global" (~/.claude/workflows). */
	scope: "project" | "global"
	/** Parse errors, if any (an unparseable file still appears, with its errors). */
	errors: string[]
}

export interface ValidationReport {
	name: string
	path: string
	parseErrors: string[]
	/** Static-analysis diagnostics from `validateSlangAST` (warnings + errors). */
	diagnostics: string[]
	ok: boolean
}

function workflowDirs(cwd: string): Array<{ dir: string; scope: "project" | "global" }> {
	return [
		{ dir: path.join(cwd, ".claude", "workflows"), scope: "project" },
		{ dir: path.join(os.homedir(), ".claude", "workflows"), scope: "global" },
	]
}

async function listSlangFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		return entries
			.filter((e) => e.isFile() && e.name.endsWith(".slang"))
			.map((e) => path.join(dir, e.name))
	} catch {
		return [] // directory absent is normal
	}
}

function countAgents(flow: FlowDecl): number {
	return flow.body.filter((item) => item.type === "AgentDecl").length
}

function summarize(flow: FlowDecl, file: string, scope: "project" | "global", errors: string[]): WorkflowSummary {
	return {
		name: flow.name,
		title: flow.title,
		description: flow.description,
		params: (flow.params ?? []).map((p) => ({
			name: p.name,
			paramType: p.paramType,
			description: p.description,
		})),
		agentCount: countAgents(flow),
		path: file,
		scope,
		errors,
	}
}

/** Discover and summarize every workflow across project + global scopes. */
export async function listWorkflows(cwd: string): Promise<WorkflowSummary[]> {
	const out: WorkflowSummary[] = []
	for (const { dir, scope } of workflowDirs(cwd)) {
		for (const file of await listSlangFiles(dir)) {
			let source: string
			try {
				source = await fs.readFile(file, "utf8")
			} catch (e) {
				out.push({
					name: path.basename(file, ".slang"),
					params: [],
					agentCount: 0,
					path: file,
					scope,
					errors: [`read failed: ${(e as Error).message}`],
				})
				continue
			}
			const { ast, errors } = parseSlang(source)
			if (ast.flows.length === 0) {
				out.push({
					name: path.basename(file, ".slang"),
					params: [],
					agentCount: 0,
					path: file,
					scope,
					errors: errors.length ? errors : ["no flow found"],
				})
				continue
			}
			for (const flow of ast.flows) out.push(summarize(flow, file, scope, errors))
		}
	}
	return out
}

/** Resolve a workflow by name (preferring project scope) to its source file path. */
export async function resolveWorkflow(cwd: string, name: string): Promise<string | undefined> {
	const all = await listWorkflows(cwd)
	const match = all.find((w) => w.name === name) ?? all.find((w) => path.basename(w.path, ".slang") === name)
	return match?.path
}

/** Parse + statically analyze one workflow file. */
export async function validateWorkflowFile(file: string): Promise<ValidationReport> {
	const source = await fs.readFile(file, "utf8")
	const { ast, errors } = parseSlang(source)
	const diagnostics = validateSlangAST(ast)
	const hardErrors = diagnostics.filter((d) => d.startsWith("[error]"))
	return {
		name: ast.flows[0]?.name ?? path.basename(file, ".slang"),
		path: file,
		parseErrors: errors,
		diagnostics,
		ok: errors.length === 0 && hardErrors.length === 0,
	}
}
