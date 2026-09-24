// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Input } from "@cloudflare/kumo";
import { CpuIcon } from "@phosphor-icons/react";
import {
	DEFAULT_MODELS,
	MODEL_CONFIG_KEYS,
	MODEL_CONFIG_LABELS,
	validateModelId,
	type ModelConfig,
	type ModelConfigKey,
} from "shared/models";


interface AiModelsCardProps {
	/** Model overrides for this scope. Blank fields inherit. */
	models: ModelConfig;
	onChange: (models: ModelConfig) => void;
	/**
	 * Inherited model ids shown as placeholders: the app-wide overrides for
	 * a mailbox card, or the built-in defaults in Global Settings.
	 */
	inherited?: ModelConfig;
	title?: string;
	description?: string;
}


/**
 * Editable AI model ids for one scope (app-wide or a single mailbox).
 *
 * Every field is optional: leaving it blank inherits the next level up,
 * shown as the placeholder so an empty field still says which model will
 * run. Obviously-wrong ids get inline feedback.
 */
export default function AiModelsCard({
	models,
	onChange,
	inherited,
	title = "AI Models",
	description,
}: AiModelsCardProps) {
	const placeholderFor = (key: ModelConfigKey) => {
		const inheritedValue = inherited?.[key];
		return inheritedValue && inheritedValue.trim()
			? inheritedValue
			: DEFAULT_MODELS[key];
	};

	const update = (key: ModelConfigKey, value: string) => {
		const next: ModelConfig = { ...models };
		if (value) next[key] = value;
		else delete next[key];
		onChange(next);
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<CpuIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				{description ??
					"Choose which Workers AI model runs each job. Leave a field empty to inherit the placeholder model."}
			</p>
			<div className="space-y-3">
				{MODEL_CONFIG_KEYS.map((key) => {
					const value = models[key] ?? "";
					const error = value.trim() ? validateModelId(value) : null;
					return (
						<Input
							key={key}
							label={MODEL_CONFIG_LABELS[key]}
							value={value}
							placeholder={placeholderFor(key)}
							error={error ?? undefined}
							onChange={(e) => update(key, e.target.value)}
						/>
					);
				})}
			</div>
		</div>
	);
}
