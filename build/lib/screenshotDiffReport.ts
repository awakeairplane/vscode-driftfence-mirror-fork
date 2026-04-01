/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Reads a screenshot diff report.json and prints the PR comment markdown to stdout.
// Usage: node build/lib/screenshotDiffReport.ts <report.json>

import { readFileSync, existsSync } from 'fs';

const COMMENT_MARKER = '<!-- screenshot-diff-report -->';
const MAX_PER_SECTION = 5;

interface DiffReport {
	readonly baseCommitSha: string;
	readonly currentCommitSha: string;
	readonly summary: {
		readonly added: number;
		readonly removed: number;
		readonly changed: number;
		readonly unchanged: number;
		readonly total: number;
	};
	readonly added: readonly { readonly fixtureId: string; readonly imageUrl: string; readonly changeCount?: number }[];
	readonly removed: readonly { readonly fixtureId: string; readonly imageUrl: string; readonly changeCount?: number }[];
	readonly changed: readonly { readonly fixtureId: string; readonly beforeImageUrl: string; readonly afterImageUrl: string; readonly changeCount?: number }[];
}

function generateMarkdown(report: DiffReport): string {
	const lines: string[] = [];
	const hasChangeCounts = report.changed.some(e => e.changeCount !== undefined)
		|| report.added.some(e => e.changeCount !== undefined)
		|| report.removed.some(e => e.changeCount !== undefined);

	const byChangeCount = <T extends { readonly changeCount?: number }>(items: readonly T[]): T[] =>
		[...items].sort((a, b) => (a.changeCount ?? 0) - (b.changeCount ?? 0));

	lines.push('## Screenshot Changes');
	lines.push('');
	const base = report.baseCommitSha?.slice(0, 8) ?? '?';
	const current = report.currentCommitSha?.slice(0, 8) ?? '?';
	lines.push(`**Base:** \`${base}\` **Current:** \`${current}\``);
	lines.push('');

	if (report.changed.length > 0) {
		const sorted = byChangeCount(report.changed);
		lines.push(`### Changed (${report.changed.length})`);
		lines.push('');
		for (let i = 0; i < sorted.length; i++) {
			const entry = sorted[i];
			const open = i < MAX_PER_SECTION ? ' open' : '';
			lines.push(`<details${open}><summary><code>${entry.fixtureId}</code></summary>`);
			lines.push('');
			lines.push('| Before | After |');
			lines.push('|--------|-------|');
			lines.push(`| ![before](${entry.beforeImageUrl}) | ![after](${entry.afterImageUrl}) |`);
			lines.push('');
			lines.push('</details>');
			lines.push('');
		}
	}

	if (report.added.length > 0) {
		const sorted = byChangeCount(report.added);
		lines.push(`### Added (${report.added.length})`);
		lines.push('');
		for (let i = 0; i < sorted.length; i++) {
			const entry = sorted[i];
			const open = i < MAX_PER_SECTION ? ' open' : '';
			lines.push(`<details${open}><summary><code>${entry.fixtureId}</code></summary>`);
			lines.push('');
			lines.push(`![current](${entry.imageUrl})`);
			lines.push('');
			lines.push('</details>');
			lines.push('');
		}
	}

	if (report.removed.length > 0) {
		const sorted = byChangeCount(report.removed);
		lines.push(`### Removed (${report.removed.length})`);
		lines.push('');
		for (let i = 0; i < sorted.length; i++) {
			const entry = sorted[i];
			const open = i < MAX_PER_SECTION ? ' open' : '';
			const suffix = hasChangeCounts ? ` — ${entry.changeCount ?? '?'} changes in last 7d` : '';
			lines.push(`<details${open}><summary><code>${entry.fixtureId}</code>${suffix}</summary>`);
			lines.push('');
			lines.push(`![baseline](${entry.imageUrl})`);
			lines.push('');
			lines.push('</details>');
			lines.push('');
		}
	}

	return lines.join('\n');
}

const reportPath = process.argv[2];
if (!reportPath) {
	console.error('Usage: node build/lib/screenshotDiffReport.ts <report.json>');
	process.exit(1);
}

if (!existsSync(reportPath)) {
	process.exit(0);
}

const report: DiffReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
if (report.changed.length === 0 && report.added.length === 0 && report.removed.length === 0) {
	process.exit(0);
}

process.stdout.write(`${COMMENT_MARKER}\n${generateMarkdown(report)}`);
