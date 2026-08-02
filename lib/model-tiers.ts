/**
 * Model tier resolution for agent definitions.
 *
 * An agent `.md` file can name a concrete model (`deepseek/deepseek-v4-flash`),
 * but pinning one there couples every agent to a single provider — swapping
 * providers means editing every file. Two indirections avoid that:
 *
 *   model: inherit   → whatever model the session is currently using
 *   model: $fast     → a tier name looked up in config.json `modelTiers`
 *
 * Tiers let a fleet of agents be described by role ("$fast" for recon, "$deep"
 * for review) and repointed in one place. A tier may itself resolve to
 * `inherit`, so `{"fast": "inherit"}` is a valid way to say "no separate fast
 * model on this machine".
 *
 * Resolution is pure and synchronous: the caller supplies the session model, so
 * this module needs no pi imports and stays trivially testable.
 */

/** Sentinel meaning "use the session's current model". Compared case-insensitively. */
export const INHERIT_MODEL = "inherit";

/** Guards against a tier chain that never terminates (`{"a": "$b", "b": "$a"}`). */
const MAX_TIER_HOPS = 8;

export interface ModelResolutionOptions {
	/** Tier name → model spec, from ExtensionConfig.modelTiers. Names are case-insensitive. */
	tiers?: Record<string, string>;
	/** The session's current model as "provider/id", if one is active. */
	sessionModel?: string;
}

export type ModelResolution =
	| { ok: true; model: string }
	| { ok: false; error: string };

/** Tier references are written `$name` in frontmatter. */
export function isTierReference(spec: string): boolean {
	return spec.startsWith("$") && spec.length > 1;
}

export function isInheritReference(spec: string): boolean {
	return spec.trim().toLowerCase() === INHERIT_MODEL;
}

/**
 * Resolve an agent's `model:` value to a concrete "provider/id" spec.
 *
 * Concrete specs pass through untouched, so existing agent files keep working.
 * Failures are returned rather than thrown: a missing tier should surface as a
 * clear dispatch error naming the agent, not crash agent discovery at startup.
 */
export function resolveAgentModel(
	rawModel: string,
	options: ModelResolutionOptions = {},
): ModelResolution {
	const tiers = normalizeTierKeys(options.tiers);
	let spec = rawModel.trim();
	const seen: string[] = [];

	for (let hop = 0; hop <= MAX_TIER_HOPS; hop++) {
		if (isInheritReference(spec)) {
			if (!options.sessionModel) {
				return {
					ok: false,
					error:
						"model resolves to 'inherit' but no session model is active. " +
						"Select a model with /model, or name a concrete model in the agent file.",
				};
			}
			return { ok: true, model: options.sessionModel };
		}

		if (!isTierReference(spec)) {
			return { ok: true, model: spec };
		}

		const tierName = spec.slice(1).toLowerCase();
		if (seen.includes(tierName)) {
			return {
				ok: false,
				error: `model tier '$${tierName}' is defined in terms of itself (${seen.map((t) => `$${t}`).join(" → ")} → $${tierName}).`,
			};
		}
		seen.push(tierName);

		const next = tiers[tierName];
		if (next === undefined) {
			const known = Object.keys(tiers);
			const suffix = known.length
				? ` Known tiers: ${known.map((t) => `$${t}`).join(", ")}.`
				: " No modelTiers are configured in config.json.";
			return { ok: false, error: `model tier '$${tierName}' is not defined.${suffix}` };
		}
		spec = next.trim();
	}

	return {
		ok: false,
		error: `model tier chain exceeded ${MAX_TIER_HOPS} hops (${seen.map((t) => `$${t}`).join(" → ")}).`,
	};
}

/** Format a pi model object as the "provider/id" spec used throughout. */
export function formatModelSpec(
	model: { provider?: string; id?: string } | undefined,
): string | undefined {
	if (!model?.provider || !model?.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function normalizeTierKeys(tiers: Record<string, string> | undefined): Record<string, string> {
	if (!tiers) return {};
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(tiers)) {
		if (typeof value !== "string" || !value.trim()) continue;
		normalized[key.trim().toLowerCase().replace(/^\$/, "")] = value;
	}
	return normalized;
}
