export type UassetLauncherErrorCode =
	| "UE_SHED_UASSET_PLATFORM_PACKAGE_UNAVAILABLE"
	| "UE_SHED_UASSET_UNSUPPORTED_PLATFORM";

export declare class UnsupportedPlatformError extends Error {
	readonly name: "UnsupportedPlatformError";
	readonly code: "UE_SHED_UASSET_UNSUPPORTED_PLATFORM";
	readonly platform: string;
	readonly arch: string;
	constructor(platform: string, arch: string);
}

export declare class PlatformPackageUnavailableError extends Error {
	readonly name: "PlatformPackageUnavailableError";
	readonly code: "UE_SHED_UASSET_PLATFORM_PACKAGE_UNAVAILABLE";
	readonly packageName: string;
	constructor(packageName: string, cause?: unknown);
}

export declare function platformPackageName(
	platform?: string,
	arch?: string
): "@ue-shed/uasset-win32-x64";

export declare function resolveUassetExecutable(platform?: string, arch?: string): string;
