/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { parse as parseJSONC } from '../../../../../base/common/json.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS } from '../../../../../base/common/platform.js';
import { basename, dirname, isEqualOrParent } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAICustomizationWorkspaceService, applyStorageSourceFilter } from '../../common/aiCustomizationWorkspaceService.js';
import { IAgentPluginService } from '../../common/plugins/agentPluginService.js';
import { HookType, HOOK_METADATA } from '../../common/promptSyntax/hookTypes.js';
import { parseHooksFromFile } from '../../common/promptSyntax/hookCompatibility.js';
import { formatHookCommandLabel } from '../../common/promptSyntax/hookSchema.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { IHarnessDescriptor, matchesInstructionFileFilter, matchesWorkspaceSubpath } from '../../common/customizationHarnessService.js';
import { BUILTIN_STORAGE } from './aiCustomizationManagement.js';
import { extensionIcon, instructionsIcon, pluginIcon, userIcon, workspaceIcon } from './aiCustomizationIcons.js';
import { IAICustomizationItemSource, IAICustomizationListItem } from './aiCustomizationListItem.js';
import { getFriendlyName } from './aiCustomizationItemSourceUtils.js';

export function storageToIcon(storage: PromptsStorage): ThemeIcon {
	switch (storage) {
		case PromptsStorage.local: return workspaceIcon;
		case PromptsStorage.user: return userIcon;
		case PromptsStorage.extension: return extensionIcon;
		case PromptsStorage.plugin: return pluginIcon;
		default: return instructionsIcon;
	}
}

/**
 * Fetches rich list items from IPromptsService for static/local harnesses.
 */
export class PromptsServiceCustomizationItemSource implements IAICustomizationItemSource {

	readonly onDidChange: Event<void>;

	constructor(
		private readonly getActiveDescriptor: () => IHarnessDescriptor,
		private readonly promptsService: IPromptsService,
		private readonly workspaceService: IAICustomizationWorkspaceService,
		private readonly labelService: ILabelService,
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
		private readonly agentPluginService: IAgentPluginService,
		private readonly productService: IProductService,
	) {
		this.onDidChange = Event.any(
			this.promptsService.onDidChangeCustomAgents,
			this.promptsService.onDidChangeSlashCommands,
			this.promptsService.onDidChangeSkills,
			this.promptsService.onDidChangeHooks,
			this.promptsService.onDidChangeInstructions,
		);
	}

	async fetchItems(promptType: PromptsType): Promise<IAICustomizationListItem[]> {
		const items: IAICustomizationListItem[] = [];
		const disabledUris = this.promptsService.getDisabledPromptFiles(promptType);
		const extensionInfoByUri = new ResourceMap<{ id: ExtensionIdentifier; displayName?: string }>();

		if (promptType === PromptsType.agent) {
			const agents = await this.promptsService.getCustomAgents(CancellationToken.None);
			const allAgentFiles = await this.promptsService.listPromptFiles(PromptsType.agent, CancellationToken.None);
			for (const file of allAgentFiles) {
				if (file.extension) {
					extensionInfoByUri.set(file.uri, { id: file.extension.identifier, displayName: file.extension.displayName });
				}
			}
			for (const agent of agents) {
				const filename = basename(agent.uri);
				items.push({
					id: agent.uri.toString(),
					uri: agent.uri,
					name: agent.name,
					filename,
					description: agent.description,
					storage: agent.source.storage,
					promptType,
					pluginUri: agent.source.storage === PromptsStorage.plugin ? agent.source.pluginUri : undefined,
					disabled: disabledUris.has(agent.uri),
				});
				if (agent.source.storage === PromptsStorage.extension && !extensionInfoByUri.has(agent.uri)) {
					extensionInfoByUri.set(agent.uri, { id: agent.source.extensionId });
				}
			}
		} else if (promptType === PromptsType.skill) {
			const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
			const allSkillFiles = await this.promptsService.listPromptFiles(PromptsType.skill, CancellationToken.None);
			for (const file of allSkillFiles) {
				if (file.extension) {
					extensionInfoByUri.set(file.uri, { id: file.extension.identifier, displayName: file.extension.displayName });
				}
			}
			const uiIntegrations = this.workspaceService.getSkillUIIntegrations();
			const seenUris = new ResourceSet();
			for (const skill of skills || []) {
				const filename = basename(skill.uri);
				const skillName = skill.name || basename(dirname(skill.uri)) || filename;
				seenUris.add(skill.uri);
				const skillFolderName = basename(dirname(skill.uri));
				const uiTooltip = uiIntegrations.get(skillFolderName);
				items.push({
					id: skill.uri.toString(),
					uri: skill.uri,
					name: skillName,
					filename,
					description: skill.description,
					storage: skill.storage,
					promptType,
					pluginUri: skill.storage === PromptsStorage.plugin ? this.findPluginUri(skill.uri) : undefined,
					disabled: false,
					badge: uiTooltip ? localize('uiIntegrationBadge', "UI Integration") : undefined,
					badgeTooltip: uiTooltip,
				});
			}
			if (disabledUris.size > 0) {
				for (const file of allSkillFiles) {
					if (!seenUris.has(file.uri) && disabledUris.has(file.uri)) {
						const filename = basename(file.uri);
						const disabledName = file.name || basename(dirname(file.uri)) || filename;
						const disabledFolderName = basename(dirname(file.uri));
						const uiTooltip = uiIntegrations.get(disabledFolderName);
						items.push({
							id: file.uri.toString(),
							uri: file.uri,
							name: disabledName,
							filename,
							description: file.description,
							storage: file.storage,
							promptType,
							disabled: true,
							badge: uiTooltip ? localize('uiIntegrationBadge', "UI Integration") : undefined,
							badgeTooltip: uiTooltip,
						});
					}
				}
			}
		} else if (promptType === PromptsType.prompt) {
			const commands = await this.promptsService.getPromptSlashCommands(CancellationToken.None);
			for (const command of commands) {
				if (command.type === PromptsType.skill) {
					continue;
				}
				const filename = basename(command.uri);
				items.push({
					id: command.uri.toString(),
					uri: command.uri,
					name: command.name,
					filename,
					description: command.description,
					storage: command.storage,
					promptType,
					pluginUri: command.storage === PromptsStorage.plugin ? command.pluginUri : undefined,
					disabled: disabledUris.has(command.uri),
				});
				if (command.extension) {
					extensionInfoByUri.set(command.uri, { id: command.extension.identifier, displayName: command.extension.displayName });
				}
			}
		} else if (promptType === PromptsType.hook) {
			await this.fetchPromptServiceHooks(items, disabledUris, promptType);
		} else {
			await this.fetchPromptServiceInstructions(items, extensionInfoByUri, disabledUris, promptType);
		}

		items.splice(0, items.length, ...this.applyLocalFilters(this.applyBuiltinGroupKeys(items, extensionInfoByUri), promptType));
		items.sort((a, b) => a.name.localeCompare(b.name));

		return items;
	}

	private async fetchPromptServiceHooks(items: IAICustomizationListItem[], disabledUris: ResourceSet, promptType: PromptsType): Promise<void> {
		const hookFiles = await this.promptsService.listPromptFiles(PromptsType.hook, CancellationToken.None);
		const activeRoot = this.workspaceService.getActiveProjectRoot();
		const userHomeUri = await this.pathService.userHome();
		const userHome = userHomeUri.scheme === Schemas.file ? userHomeUri.fsPath : userHomeUri.path;

		for (const hookFile of hookFiles) {
			if (hookFile.storage === PromptsStorage.plugin) {
				const filename = basename(hookFile.uri);
				items.push({
					id: hookFile.uri.toString() + ':' + hookFile.name,
					uri: hookFile.uri,
					name: hookFile.name || getFriendlyName(filename),
					filename,
					storage: hookFile.storage,
					promptType,
					pluginUri: hookFile.pluginUri,
					disabled: disabledUris.has(hookFile.uri),
				});
				continue;
			}

			let parsedHooks = false;
			try {
				const content = await this.fileService.readFile(hookFile.uri);
				const json = parseJSONC(content.value.toString());
				const { hooks } = parseHooksFromFile(hookFile.uri, json, activeRoot, userHome);

				if (hooks.size > 0) {
					parsedHooks = true;
					for (const [hookType, entry] of hooks) {
						const hookMeta = HOOK_METADATA[hookType];
						for (let i = 0; i < entry.hooks.length; i++) {
							const hook = entry.hooks[i];
							const cmdLabel = formatHookCommandLabel(hook, OS);
							const truncatedCmd = cmdLabel.length > 60 ? cmdLabel.substring(0, 57) + '...' : cmdLabel;
							items.push({
								id: `${hookFile.uri.toString()}#${entry.originalId}[${i}]`,
								uri: hookFile.uri,
								name: hookMeta?.label ?? entry.originalId,
								filename: basename(hookFile.uri),
								description: truncatedCmd || localize('hookUnset', "(unset)"),
								storage: hookFile.storage,
								promptType,
								disabled: disabledUris.has(hookFile.uri),
							});
						}
					}
				}
			} catch {
				// Parse failed - fall through to show raw file.
			}

			if (!parsedHooks) {
				const filename = basename(hookFile.uri);
				items.push({
					id: hookFile.uri.toString(),
					uri: hookFile.uri,
					name: hookFile.name || getFriendlyName(filename),
					filename,
					storage: hookFile.storage,
					promptType,
					disabled: disabledUris.has(hookFile.uri),
				});
			}
		}

		const agents = !this.workspaceService.isSessionsWindow ? await this.promptsService.getCustomAgents(CancellationToken.None) : [];
		for (const agent of agents) {
			if (!agent.hooks) {
				continue;
			}
			for (const hookType of Object.values(HookType)) {
				const hookCommands = agent.hooks[hookType];
				if (!hookCommands || hookCommands.length === 0) {
					continue;
				}
				const hookMeta = HOOK_METADATA[hookType];
				for (let i = 0; i < hookCommands.length; i++) {
					const hook = hookCommands[i];
					const cmdLabel = formatHookCommandLabel(hook, OS);
					const truncatedCmd = cmdLabel.length > 60 ? cmdLabel.substring(0, 57) + '...' : cmdLabel;
					items.push({
						id: `${agent.uri.toString()}#hook:${hookType}[${i}]`,
						uri: agent.uri,
						name: hookMeta?.label ?? hookType,
						filename: basename(agent.uri),
						description: `${agent.name}: ${truncatedCmd || localize('hookUnset', "(unset)")}`,
						storage: agent.source.storage,
						groupKey: 'agents',
						promptType,
						pluginUri: agent.source.storage === PromptsStorage.plugin ? agent.source.pluginUri : undefined,
						disabled: disabledUris.has(agent.uri),
					});
				}
			}
		}
	}

	private async fetchPromptServiceInstructions(items: IAICustomizationListItem[], extensionInfoByUri: ResourceMap<{ id: ExtensionIdentifier; displayName?: string }>, disabledUris: ResourceSet, promptType: PromptsType): Promise<void> {
		const instructionFiles = await this.promptsService.getInstructionFiles(CancellationToken.None);
		for (const file of instructionFiles) {
			if (file.extension) {
				extensionInfoByUri.set(file.uri, { id: file.extension.identifier, displayName: file.extension.displayName });
			}
		}
		const agentInstructionFiles = await this.promptsService.listAgentInstructions(CancellationToken.None, undefined);
		const agentInstructionUris = new ResourceSet(agentInstructionFiles.map(f => f.uri));

		for (const file of agentInstructionFiles) {
			const storage = PromptsStorage.local;
			const filename = basename(file.uri);
			items.push({
				id: file.uri.toString(),
				uri: file.uri,
				name: filename,
				filename: this.labelService.getUriLabel(file.uri, { relative: true }),
				displayName: filename,
				storage,
				promptType,
				typeIcon: storageToIcon(storage),
				groupKey: 'agent-instructions',
				disabled: disabledUris.has(file.uri),
			});
		}

		for (const { uri, pattern, name, description, storage, pluginUri } of instructionFiles) {
			if (agentInstructionUris.has(uri)) {
				continue;
			}

			const friendlyName = getFriendlyName(name);

			if (pattern !== undefined) {
				const badge = pattern === '**'
					? localize('alwaysAdded', "always added")
					: pattern;
				const badgeTooltip = pattern === '**'
					? localize('alwaysAddedTooltip', "This instruction is automatically included in every interaction.")
					: localize('onContextTooltip', "This instruction is automatically included when files matching '{0}' are in context.", pattern);
				items.push({
					id: uri.toString(),
					uri,
					name: friendlyName,
					filename: this.labelService.getUriLabel(uri, { relative: true }),
					displayName: friendlyName,
					badge,
					badgeTooltip,
					description,
					storage,
					promptType,
					typeIcon: storageToIcon(storage),
					groupKey: 'context-instructions',
					pluginUri,
					disabled: disabledUris.has(uri),
				});
			} else {
				items.push({
					id: uri.toString(),
					uri,
					name: friendlyName,
					filename: basename(uri),
					displayName: friendlyName,
					description,
					storage,
					promptType,
					typeIcon: storageToIcon(storage),
					groupKey: 'on-demand-instructions',
					pluginUri,
					disabled: disabledUris.has(uri),
				});
			}
		}
	}

	private applyBuiltinGroupKeys(items: IAICustomizationListItem[], extensionInfoByUri: ResourceMap<{ id: ExtensionIdentifier; displayName?: string }>): IAICustomizationListItem[] {
		return items.map(item => {
			if (item.storage !== PromptsStorage.extension) {
				return item;
			}
			const extInfo = extensionInfoByUri.get(item.uri);
			if (!extInfo) {
				return item;
			}
			const isBuiltin = this.isChatExtensionItem(extInfo.id);
			if (isBuiltin) {
				return {
					...item,
					isBuiltin: true,
					groupKey: item.groupKey ?? BUILTIN_STORAGE,
				};
			}
			return {
				...item,
				extensionLabel: extInfo.displayName || extInfo.id.value,
			};
		});
	}

	private applyLocalFilters(groupedItems: IAICustomizationListItem[], promptType: PromptsType): IAICustomizationListItem[] {
		const filter = this.workspaceService.getStorageSourceFilter(promptType);
		const withStorage = groupedItems.filter((item): item is IAICustomizationListItem & { readonly storage: PromptsStorage } => item.storage !== undefined);
		const withoutStorage = groupedItems.filter(item => item.storage === undefined);
		const items = [...applyStorageSourceFilter(withStorage, filter), ...withoutStorage];

		const descriptor = this.getActiveDescriptor();
		const subpaths = descriptor.workspaceSubpaths;
		const instrFilter = descriptor.instructionFileFilter;
		if (subpaths) {
			const projectRoot = this.workspaceService.getActiveProjectRoot();
			for (let i = items.length - 1; i >= 0; i--) {
				const item = items[i];
				if (item.storage === PromptsStorage.local && projectRoot && isEqualOrParent(item.uri, projectRoot)) {
					if (!matchesWorkspaceSubpath(item.uri.path, subpaths)) {
						if (instrFilter && promptType === PromptsType.instructions && matchesInstructionFileFilter(item.uri.path, instrFilter)) {
							continue;
						}
						if (item.groupKey === 'agent-instructions') {
							continue;
						}
						items.splice(i, 1);
					}
				}
			}
		}

		if (instrFilter && promptType === PromptsType.instructions) {
			for (let i = items.length - 1; i >= 0; i--) {
				if (!matchesInstructionFileFilter(items[i].uri.path, instrFilter)) {
					items.splice(i, 1);
				}
			}
		}

		return items;
	}

	private isChatExtensionItem(extensionId: ExtensionIdentifier): boolean {
		const chatExtensionId = this.productService.defaultChatAgent?.chatExtensionId;
		return !!chatExtensionId && ExtensionIdentifier.equals(extensionId, chatExtensionId);
	}

	private findPluginUri(itemUri: URI): URI | undefined {
		for (const plugin of this.agentPluginService.plugins.get()) {
			if (isEqualOrParent(itemUri, plugin.uri)) {
				return plugin.uri;
			}
		}
		return undefined;
	}
}
