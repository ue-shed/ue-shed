using UnrealBuildTool;

public class UEShedCamerasEditor : ModuleRules
{
	public UEShedCamerasEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[] {
			"Json", "RenderCore", "UEShedCameras", "UnrealEd"
		});
	}
}
