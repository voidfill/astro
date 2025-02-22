import { getManagedAppTokenOrExit } from '@astrojs/studio';
import type { AstroConfig } from 'astro';
import prompts from 'prompts';
import { safeFetch } from '../../../../runtime/utils.js';
import { MIGRATION_VERSION } from '../../../consts.js';
import { type DBConfig, type DBSnapshot } from '../../../types.js';
import { type Result, getRemoteDatabaseUrl } from '../../../utils.js';
import {
	createCurrentSnapshot,
	createEmptySnapshot,
	formatDataLossMessage,
	getMigrationQueries,
	getProductionCurrentSnapshot,
} from '../../migration-queries.js';
import type { YargsArguments } from '../../types.js';

export async function cmd({
	dbConfig,
	flags,
}: {
	astroConfig: AstroConfig;
	dbConfig: DBConfig;
	flags: YargsArguments;
}) {
	const isDryRun = flags.dryRun;
	const isForceReset = flags.forceReset;
	const appToken = await getManagedAppTokenOrExit(flags.token);
	const productionSnapshot = await getProductionCurrentSnapshot({ appToken: appToken.token });
	const currentSnapshot = createCurrentSnapshot(dbConfig);
	const isFromScratch = !productionSnapshot;
	const { queries: migrationQueries, confirmations } = await getMigrationQueries({
		oldSnapshot: isFromScratch ? createEmptySnapshot() : productionSnapshot,
		newSnapshot: currentSnapshot,
		reset: isForceReset,
	});

	// // push the database schema
	if (migrationQueries.length === 0) {
		console.log('Database schema is up to date.');
	} else {
		console.log(`Database schema is out of date.`);
	}

	if (isForceReset) {
		const { begin } = await prompts({
			type: 'confirm',
			name: 'begin',
			message: `Reset your database? All of your data will be erased and your schema created from scratch.`,
			initial: false,
		});

		if (!begin) {
			console.log('Canceled.');
			process.exit(0);
		}

		console.log(`Force-pushing to the database. All existing data will be erased.`);
	} else if (confirmations.length > 0) {
		console.log('\n' + formatDataLossMessage(confirmations) + '\n');
		throw new Error('Exiting.');
	}

	if (isDryRun) {
		console.log('Statements:', JSON.stringify(migrationQueries, undefined, 2));
	} else {
		console.log(`Pushing database schema updates...`);
		await pushSchema({
			statements: migrationQueries,
			appToken: appToken.token,
			isDryRun,
			currentSnapshot: currentSnapshot,
		});
	}
	// cleanup and exit
	await appToken.destroy();
	console.info('Push complete!');
}

async function pushSchema({
	statements,
	appToken,
	isDryRun,
	currentSnapshot,
}: {
	statements: string[];
	appToken: string;
	isDryRun: boolean;
	currentSnapshot: DBSnapshot;
}) {
	const requestBody = {
		snapshot: currentSnapshot,
		sql: statements,
		version: MIGRATION_VERSION,
	};
	if (isDryRun) {
		console.info('[DRY RUN] Batch query:', JSON.stringify(requestBody, null, 2));
		return new Response(null, { status: 200 });
	}
	const url = new URL('/db/push', getRemoteDatabaseUrl());
	const response = await safeFetch(
		url,
		{
			method: 'POST',
			headers: new Headers({
				Authorization: `Bearer ${appToken}`,
			}),
			body: JSON.stringify(requestBody),
		},
		async (res) => {
			console.error(`${url.toString()} failed: ${res.status} ${res.statusText}`);
			console.error(await res.text());
			throw new Error(`/db/push fetch failed: ${res.status} ${res.statusText}`);
		},
	);

	const result = (await response.json()) as Result<never>;
	if (!result.success) {
		console.error(`${url.toString()} unsuccessful`);
		console.error(await response.text());
		throw new Error(`/db/push fetch unsuccessful`);
	}
}
