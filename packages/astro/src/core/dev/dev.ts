import fs, { existsSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { green } from 'kleur/colors';
import { performance } from 'perf_hooks';
import { gt, major, minor, patch } from 'semver';
import type * as vite from 'vite';
import type { AstroInlineConfig } from '../../@types/astro.js';
import { DATA_STORE_FILE } from '../../content/consts.js';
import { globalContentLayer } from '../../content/content-layer.js';
import { DataStore, globalDataStore } from '../../content/data-store.js';
import { attachContentServerListeners } from '../../content/index.js';
import { globalContentConfigObserver } from '../../content/utils.js';
import { telemetry } from '../../events/index.js';
import * as msg from '../messages.js';
import { ensureProcessNodeEnv } from '../util.js';
import { startContainer } from './container.js';
import { createContainerWithAutomaticRestart } from './restart.js';
import {
	MAX_PATCH_DISTANCE,
	fetchLatestAstroVersion,
	shouldCheckForUpdates,
} from './update-check.js';

export interface DevServer {
	address: AddressInfo;
	handle: (req: http.IncomingMessage, res: http.ServerResponse<http.IncomingMessage>) => void;
	watcher: vite.FSWatcher;
	stop(): Promise<void>;
}

/**
 * Runs Astro’s development server. This is a local HTTP server that doesn’t bundle assets.
 * It uses Hot Module Replacement (HMR) to update your browser as you save changes in your editor.
 *
 * @experimental The JavaScript API is experimental
 */
export default async function dev(inlineConfig: AstroInlineConfig): Promise<DevServer> {
	ensureProcessNodeEnv('development');
	const devStart = performance.now();
	await telemetry.record([]);

	// Create a container which sets up the Vite server.
	const restart = await createContainerWithAutomaticRestart({ inlineConfig, fs });
	const logger = restart.container.logger;

	const currentVersion = process.env.PACKAGE_VERSION ?? '0.0.0';
	const isPrerelease = currentVersion.includes('-');

	if (!isPrerelease) {
		try {
			// Don't await this, we don't want to block the dev server from starting
			shouldCheckForUpdates(restart.container.settings.preferences)
				.then(async (shouldCheck) => {
					if (shouldCheck) {
						const version = await fetchLatestAstroVersion(restart.container.settings.preferences);

						if (gt(version, currentVersion)) {
							// Only update the latestAstroVersion if the latest version is greater than the current version, that way we don't need to check that again
							// whenever we check for the latest version elsewhere
							restart.container.settings.latestAstroVersion = version;

							const sameMajor = major(version) === major(currentVersion);
							const sameMinor = minor(version) === minor(currentVersion);
							const patchDistance = patch(version) - patch(currentVersion);

							if (sameMajor && sameMinor && patchDistance < MAX_PATCH_DISTANCE) {
								// Don't bother the user with a log if they're only a few patch versions behind
								// We can still tell them in the dev toolbar, which has a more opt-in nature
								return;
							}

							logger.warn(
								'SKIP_FORMAT',
								await msg.newVersionAvailable({
									latestVersion: version,
								}),
							);
						}
					}
				})
				.catch(() => {});
		} catch {
			// Just ignore the error, we don't want to block the dev server from starting and this is just a nice-to-have feature
		}
	}

	// Start listening to the port
	const devServerAddressInfo = await startContainer(restart.container);
	logger.info(
		'SKIP_FORMAT',
		msg.serverStart({
			startupTime: performance.now() - devStart,
			resolvedUrls: restart.container.viteServer.resolvedUrls || { local: [], network: [] },
			host: restart.container.settings.config.server.host,
			base: restart.container.settings.config.base,
		}),
	);

	if (isPrerelease) {
		logger.warn('SKIP_FORMAT', msg.prerelease({ currentVersion }));
	}
	if (restart.container.viteServer.config.server?.fs?.strict === false) {
		logger.warn('SKIP_FORMAT', msg.fsStrictWarning());
	}

	await attachContentServerListeners(restart.container);

	let store: DataStore | undefined;
	try {
		const dataStoreFile = new URL(DATA_STORE_FILE, restart.container.settings.config.cacheDir);
		if (existsSync(dataStoreFile)) {
			store = await DataStore.fromFile(dataStoreFile);
			globalDataStore.set(store);
		}
	} catch (err: any) {
		logger.error('content', err.message);
	}
	if (!store) {
		store = new DataStore();
		globalDataStore.set(store);
	}

	const config = globalContentConfigObserver.get();
	if (config.status === 'error') {
		logger.error('content', config.error.message);
	}
	if (config.status === 'loaded') {
		const contentLayer = globalContentLayer.init({
			settings: restart.container.settings,
			logger,
			watcher: restart.container.viteServer.watcher,
			store,
		});
		contentLayer.watchContentConfig();
		await contentLayer.sync();
	}

	logger.info(null, green('watching for file changes...'));

	return {
		address: devServerAddressInfo,
		get watcher() {
			return restart.container.viteServer.watcher;
		},
		handle(req, res) {
			return restart.container.handle(req, res);
		},
		async stop() {
			await restart.container.close();
		},
	};
}
