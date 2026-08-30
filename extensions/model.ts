/**
 * Out-of-band model calls for the extension.
 *
 * Both the bash summarizer and the meta-amnesia tagger run *outside* the main
 * conversation: their requests and responses never enter the session messages
 * array, so the main agent has no way of knowing they happened.
 *
 * Per user choice: the aux model is the user's **active model** run with low
 * reasoning effort (a cheap/fast pass). Override with PI_CTX_AUX_MODEL
 * ("provider/id") if a dedicated small model is preferred.
 */
import { complete, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CtxConfig } from "./config";
import { withTimeout } from "./util";

export interface AuxModelOptions {
	maxTokens: number;
	temperature?: number;
	label: string;
	signal?: AbortSignal;
}

function resolveModel(ctx: ExtensionContext, cfg: CtxConfig): Model<any> | undefined {
	if (cfg.auxModel) {
		const slash = cfg.auxModel.indexOf("/");
		const provider = slash >= 0 ? cfg.auxModel.slice(0, slash) : undefined;
		const id = slash >= 0 ? cfg.auxModel.slice(slash + 1) : cfg.auxModel;
		if (provider) {
			const m = ctx.modelRegistry.find(provider, id);
			if (m) return m;
		}
		// bare id: fall back to same-provider search, then active model id
		const activeProvider = ctx.model?.provider;
		if (activeProvider) {
			const m = ctx.modelRegistry.find(activeProvider, id);
			if (m) return m;
		}
	}
	return ctx.model;
}

/**
 * Run a one-shot prompt on the aux model. Returns the text reply, or
 * `undefined` on any failure (no model, no auth, timeout, abort, API error)
 * so callers can fall back to safe behavior (retain / truncate).
 */
export async function runAuxModel(
	ctx: ExtensionContext,
	cfg: CtxConfig,
	prompt: string,
	opts: AuxModelOptions,
): Promise<string | undefined> {
	const model = resolveModel(ctx, cfg);
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return undefined;

	try {
		const response = await withTimeout(opts.signal, cfg.auxTimeoutMs, (signal) =>
			complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					reasoningEffort: "low",
					maxTokens: opts.maxTokens,
					temperature: opts.temperature ?? 0,
					signal,
				},
			),
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		return text || undefined;
	} catch {
		// Callers decide how to degrade; a failed aux pass must never crash the agent.
		return undefined;
	}
}
