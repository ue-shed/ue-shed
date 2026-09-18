using UnrealBuildTool;
public class UEShedCameraAuthoring : ModuleRules
{
	public UEShedCameraAuthoring(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore", "Json", "Slate", "SlateCore", "ToolMenus", "UnrealEd", "UEShedCameraAuthoringBridge", "UEShedCamerasEditor" });
	}
}
