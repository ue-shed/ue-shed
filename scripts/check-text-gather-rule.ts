import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read-only verification against configured engine source; never generates fixtures. */
for (const version of ["4.27", "5.7", "5.8"]) {
	const root = process.env[`UE_SHED_UNREAL_${version.replace(".", "")}_ROOT`];
	assert.ok(root, `Configure source for UE ${version}`);
	const source = (path: string) => readFileSync(join(root, "Engine/Source", path), "utf8");
	const probes = [
		[
			"Runtime/CoreUObject/Public/UObject/ObjectMacros.h",
			/PKG_RequiresLocalizationGather\s*=\s*0x00040000/u
		],
		[
			"Runtime/Core/Private/Internationalization/Text.cpp",
			/UnderlyingArchive.ThisRequiresLocalizationGather\(\)/u
		],
		[
			"Runtime/CoreUObject/Public/UObject/Package.h",
			/SetPackageFlags\(PKG_RequiresLocalizationGather\)/u
		],
		[
			"Runtime/CoreUObject/Public/UObject/Package.h",
			/return HasAnyPackageFlags\(PKG_RequiresLocalizationGather\)/u
		],
		[
			`Runtime/CoreUObject/Private/UObject/${version === "4.27" ? "SavePackage" : "SavePackage2"}.cpp`,
			/ThisRequiresLocalizationGather\(Linker->RequiresLocalizationGather\(\)\)/u
		],
		[
			`Runtime/CoreUObject/Private/UObject/${version === "4.27" ? "SavePackage" : "SavePackage2"}.cpp`,
			/Summary.GatherableTextDataOffset = (?:\(int32\))?Linker->Tell\(\)/u
		],
		[
			`Runtime/CoreUObject/Private/UObject/${version === "4.27" ? "SavePackage" : "SavePackage2"}.cpp`,
			/Summary.GatherableTextDataCount = Linker->GatherableTextDataMap.Num\(\)/u
		],
		[
			"Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp",
			/SA_VALUE\(TEXT\("GatherableTextDataCount"\)/u
		],
		[
			"Runtime/CoreUObject/Private/UObject/LinkerLoad.cpp",
			/Seek\(\s*Summary.GatherableTextDataOffset\s*\)/u
		],
		[
			"Editor/UnrealEd/Private/Commandlets/GatherTextFromAssetsCommandlet.cpp",
			/FileReader->Seek\(PackageFileSummary.GatherableTextDataOffset\)/u
		],
		[
			"Editor/UnrealEd/Private/Commandlets/GatherTextFromAssetsCommandlet.cpp",
			/if \(Package->RequiresLocalizationGather\(\)/u
		],
		[
			"Editor/UnrealEd/Private/Commandlets/GatherTextFromAssetsCommandlet.cpp",
			/PackageFileSummary\.(?:PackageFlags|GetPackageFlags\(\)) & PKG_RequiresLocalizationGather/u
		]
	] as const;
	for (const [file, pattern] of probes) {
		const content = source(file);
		const match = pattern.exec(content);
		assert.ok(match, `UE ${version}: ${file}: ${pattern}`);
		const line = content.slice(0, match.index).split("\n").length;
		process.stdout.write(`UE ${version} ${file}:${line} ${match[0]}\n`);
	}
	const text = source("Runtime/Core/Private/Internationalization/Text.cpp");
	assert.match(text, /if\( Value.ShouldGatherForLocalization\(\) \)/u);
	const gather = source("Editor/UnrealEd/Private/Commandlets/GatherTextFromAssetsCommandlet.cpp");
	if (version === "5.7")
		assert.match(gather, /RequiresLocalizationGather\(\) \|\| ExternalActors.Num\(\) > 0/u);
	if (version === "5.8") {
		assert.match(gather, /ExternalActors.Num\(\) > 0 \|\| ExternalPackages.Num\(\) > 0/u);
		assert.match(gather, /RequiresLocalizationGather\(\) \|\| bHasExternalObjects/u);
	}
	process.stdout.write(`UE ${version}: 12 source probes and gather conditions passed\n`);
}
