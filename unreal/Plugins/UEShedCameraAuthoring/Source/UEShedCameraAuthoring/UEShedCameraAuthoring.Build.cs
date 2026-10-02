using UnrealBuildTool;
public class UEShedCameraAuthoring : ModuleRules
{
	public UEShedCameraAuthoring(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore", "Json", "Slate", "SlateCore", "UnrealEd", "WorkspaceMenuStructure", "UEShedCameraAuthoringBridge", "UEShedCamerasEditor" });
	}
}
