import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const VERSION = "0.1.0-rc.1";
const WINDOWS_X64_PACKAGE = "@ue-shed/uasset-win32-x64";

/**
 * An operating-system and CPU combination for which no parser artifact is published.
 */
export class UnsupportedPlatformError extends Error {
	/**
	 * @param {string} platform
	 * @param {string} arch
	 */
	constructor(platform, arch) {
		super(
			`@ue-shed/uasset ${VERSION} does not support ${platform}/${arch}. ` +
				"This release supports Windows x64 only. Run the parser on a Windows x64 host " +
				"or install a later @ue-shed/uasset release that lists your platform."
		);
		this.name = "UnsupportedPlatformError";
		this.code = "UE_SHED_UASSET_UNSUPPORTED_PLATFORM";
		this.platform = platform;
		this.arch = arch;
	}
}

/**
 * The selected platform package was not installed or does not contain its executable.
 */
export class PlatformPackageUnavailableError extends Error {
	/**
	 * @param {string} packageName
	 * @param {unknown} [cause]
	 */
	constructor(packageName, cause) {
		super(
			`The required ${packageName}@${VERSION} parser artifact is unavailable. ` +
				`Reinstall @ue-shed/uasset@${VERSION} with optional dependencies enabled.`,
			{ cause }
		);
		this.name = "PlatformPackageUnavailableError";
		this.code = "UE_SHED_UASSET_PLATFORM_PACKAGE_UNAVAILABLE";
		this.packageName = packageName;
	}
}

/**
 * Select the one published package for a platform. This function never probes the filesystem.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function platformPackageName(platform = process.platform, arch = process.arch) {
	if (platform === "win32" && arch === "x64") return WINDOWS_X64_PACKAGE;
	throw new UnsupportedPlatformError(platform, arch);
}

/**
 * Resolve the executable shipped in the installed platform package. There is intentionally no
 * source-checkout, Cargo target, PATH, or runtime-download fallback.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function resolveUassetExecutable(platform = process.platform, arch = process.arch) {
	const packageName = platformPackageName(platform, arch);
	try {
		const packageJson = require.resolve(`${packageName}/package.json`);
		const executable = join(dirname(packageJson), "bin", "uasset.exe");
		accessSync(executable, constants.R_OK);
		return executable;
	} catch (cause) {
		throw new PlatformPackageUnavailableError(packageName, cause);
	}
}
