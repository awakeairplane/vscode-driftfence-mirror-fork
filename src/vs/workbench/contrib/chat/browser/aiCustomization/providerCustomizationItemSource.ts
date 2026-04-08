/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { parse as parseJSONC } from '../../../../../base/common/json.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS } from '../../../../../base/common/platform.js';
import { basename, isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAICustomizationWorkspaceService } from '../../common/aiCustomizationWorkspaceService.js';
import { IAgentPluginService } from '../../common/plugins/agentPluginService.js';
import { HOOK_METADATA } from '../../common/promptSyntax/hookTypes.js';
import { parseHooksFromFile } from '../../common/promptSyntax/hookCompatibility.js';
import { formatHookCommandLabel } from '../../common/promptSyntax/hookSchema.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { ICustomizationSyncProvider, IExternalCustomizationItem, IExternalCustomizationItemProvider } from '../../common/customizationHarnessService.js';
import { BUILTIN_STORAGE } from './aiCustomizationManagement.js';
import { IAICustomizationItemSource, IAICustomizationListItem } from './aiCustomizationListItem.js';
import { getFriendlyName } from './aiCustomizationItemSourceUtils.js';
import { extractExtensionIdFromPath } from './aiCustomizationListWidgetUtils.js';

export class ProviderCustomizationItemSource implements IAICustomizationItemSource {

	readonly onDidChange: Event<void>;

	constructor(
		private readonly itemProvider: IExternalCustomizationItemProvider | undefined,
		private readonly syncProvider: ICustomizationSyncProvider | undefined,
		private readonly promptsService: IPromptsService,
		private readonly workspaceService: IAICustomizationWorkspaceService,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly labelService: ILabelService,
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
		private readonly agentPluginService: IAgentPluginService,
		private readonly productService: IProductService,
	) {
		const onDidChangeSyncableCustomizations = this.syncProvider
			? Event.any(
				this.promptsService.onDidChangeCustomAgents,
				this.promptsService.onDidChangeSlashCommands,
				this.promptsService.onDidChangeSkills,
				this.promptsService.onDidChangeHooks,
				this.promptsService.onDidChangeInstructions,
			)
			: Event.None;

		this.onDidChange = Event.any(
			this.itemProvider?.onDidChange ?? Event.None,
			this.syncProvider?.onDidChange ?? Event.None,
			onDidChangeSyncableCustomizations,
		);
	}

	async fetchItems(promptType: PromptsType): Promise<IAICustomizationListItem[]> {
		const remoteItems = this.itemProvider
			? await this.fetchItemsFromProvider(this.itemProvider, promptType)
			: [];
		if (!this.syncProvider) {
			return remoteItems;
		}
		const localItems = await this.fetchLocalSyncableItems(promptType, this.syncProvider);
		return [...remoteItems, ...localItems];
	}

	private async fetchItemsFromProvider(provider: IExternalCustomizationItemProvider, promptType: PromptsType): Promise<IAICustomizationListItem[]> {
		const allItems = await provider.provideChatSessionCustomizations(CancellationToken.None);
		if (!allItems) {
			return [];
		}

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;

		const descriptionsByUri = new ResourceMap<string>();
		if (promptType === PromptsType.skill) {
			const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
			for (const s of skills ?? []) {
				if (s.description) {
					descriptionsByUri.set(s.uri, s.description);
				}
			}
		}

		if (promptType === PromptsType.hook) {
			return this.expandProviderHookItems(allItems, workspaceFolders);
		}

		return allItems
			.filter(item => item.type === promptType)
			.map((item: IExternalCustomizationItem) => {
				const { storage, groupKey } = item.groupKey
					? { storage: undefined, groupKey: item.groupKey }
					: this.inferStorageAndGroup(item.uri, workspaceFolders);
				return {
					id: item.uri.toString(),
					uri: item.uri,
					name: item.name,
					filename: item.uri.scheme === Schemas.file
						? this.labelService.getUriLabel(item.uri, { relative: true })
						: basename(item.uri),
					description: item.description ?? descriptionsByUri.get(item.uri),
					promptType,
					disabled: item.enabled === false,
					status: item.status,
					statusMessage: item.statusMessage,
					groupKey,
					badge: item.badge,
					badgeTooltip: item.badgeTooltip,
					storage,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async expandProviderHookItems(allItems: readonly IExternalCustomizationItem[], workspaceFolders: readonly { uri: URI }[]): Promise<IAICustomizationListItem[]> {
		const hookFileItems = allItems.filter(item => item.type === PromptsType.hook);
		const items: IAICustomizationListItem[] = [];
		const activeRoot = this.workspaceService.getActiveProjectRoot();
		const userHomeUri = await this.pathService.userHome();
		const userHome = userHomeUri.scheme === Schemas.file ? userHomeUri.fsPath : userHomeUri.path;

		for (const item of hookFileItems) {
			const { storage } = item.groupKey
				? { storage: undefined }
				: this.inferStorageAndGroup(item.uri, workspaceFolders);

			let parsedHooks = false;
			try {
				const content = await this.fileService.readFile(item.uri);
				const json = parseJSONC(content.value.toString());
				const { hooks } = parseHooksFromFile(item.uri, json, activeRoot, userHome);

				if (hooks.size > 0) {
					parsedHooks = true;
					for (const [hookType, entry] of hooks) {
						const hookMeta = HOOK_METADATA[hookType];
						for (let i = 0; i < entry.hooks.length; i++) {
							const hook = entry.hooks[i];
							const cmdLabel = formatHookCommandLabel(hook, OS);
							const truncatedCmd = cmdLabel.length > 60 ? cmdLabel.substring(0, 57) + '...' : cmdLabel;
							items.push({
								id: `${item.uri.toString()}#${entry.originalId}[${i}]`,
								uri: item.uri,
								name: hookMeta?.label ?? entry.originalId,
								filename: basename(item.uri),
								description: truncatedCmd || localize('hookUnset', "(unset)"),
								storage,
								promptType: PromptsType.hook,
								disabled: item.enabled === false,
							});
						}
					}
				}
			} catch {
				// Parse failed - fall through to show raw file.
			}

			if (!parsedHooks) {
				items.push({
					id: item.uri.toString(),
					uri: item.uri,
					name: item.name,
					filename: basename(item.uri),
					description: item.description,
					storage,
					promptType: PromptsType.hook,
					disabled: item.enabled === false,
				});
			}
		}

		return items;
	}

	private inferStorageAndGroup(uri: URI, workspaceFolders: readonly { uri: URI }[]): { storage?: PromptsStorage; groupKey?: string } {
		if (uri.scheme !== Schemas.file) {
			return { storage: PromptsStorage.extension, groupKey: BUILTIN_STORAGE };
		}

		for (const folder of workspaceFolders) {
			if (isEqualOrParent(uri, folder.uri)) {
				return { storage: PromptsStorage.local };
			}
		}

		for (const plugin of this.agentPluginService.plugins.get()) {
			if (isEqualOrParent(uri, plugin.uri)) {
				return { storage: PromptsStorage.plugin };
			}
		}

		const extensionId = extractExtensionIdFromPath(uri.path);
		if (extensionId) {
			if (this.isChatExtensionItem(new ExtensionIdentifier(extensionId))) {
				return { storage: PromptsStorage.extension, groupKey: BUILTIN_STORAGE };
			}
			return { storage: PromptsStorage.extension };
		}

		return { storage: PromptsStorage.user };
	}

	private async fetchLocalSyncableItems(promptType: PromptsType, syncProvider: ICustomizationSyncProvider): Promise<IAICustomizationListItem[]> {
		const files = await this.promptsService.listPromptFiles(promptType, CancellationToken.None);
		if (!files.length) {
			return [];
		}

		return files
			.filter(f => f.storage === PromptsStorage.local || f.storage === PromptsStorage.user)
			.map(f => ({
				id: `sync-${f.uri.toString()}`,
				uri: f.uri,
				name: getFriendlyName(basename(f.uri)),
				filename: basename(f.uri),
				promptType,
				disabled: false,
				storage: f.storage,
				groupKey: 'sync-local',
				syncable: true,
				synced: syncProvider.isSelected(f.uri),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private isChatExtensionItem(extensionId: ExtensionIdentifier): boolean {
		const chatExtensionId = this.productService.defaultChatAgent?.chatExtensionId;
		return !!chatExtensionId && ExtensionIdentifier.equals(extensionId, chatExtensionId);
	}
}
