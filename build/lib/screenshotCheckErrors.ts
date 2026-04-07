/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks the screenshot manifest for fixtures that rendered with errors.
// Usage: node build/lib/screenshotCheckErrors.ts <manifest-path>
//
// Exit codes:
//   0 — no fixtures have errors
//   1 — one or more fixtures rendered with errors

import * as fs from 'fs';

interface ManifestFixture {
	readonly fixtureId: string;
	readonly hasError?: boolean;
	readonly error?: string;
	readonly events?: readonly { type: string; message: string }[];
}

interface Manifest {
	readonly fixtures: readonly ManifestFixture[];
}

const manifestPath = process.argv[2];
if (!manifestPath) {
	console.error('Usage: node build/lib/screenshotCheckErrors.ts <manifest-path>');
	process.exit(1);
}

const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const errored = manifest.fixtures.filter(f => f.hasError);

if (errored.length === 0) {
	console.log(`All ${manifest.fixtures.length} fixtures rendered without errors.`);
	process.exit(0);
}

console.error(`${errored.length} fixture(s) rendered with errors:\n`);
for (const f of errored) {
	console.error(`  [FAIL] ${f.fixtureId}`);
	if (f.error) {
		console.error(`    ${f.error}`);
	}
	if (f.events) {
		for (const e of f.events) {
			console.error(`    [${e.type}] ${e.message.split('\n')[0]}`);
		}
	}
}
console.error('');
process.exit(1);
