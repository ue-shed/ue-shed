using UnrealBuildTool;

public class UEShedSyncProbe : ModuleRules
{
	public UEShedSyncProbe(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[] {
			"AssetRegistry", "Json", "UnrealEd", "Slate", "SlateCore", "ApplicationCore"
		});
	}
}
