using UnrealBuildTool;
public class UEShedCameraAuthoring : ModuleRules
{
	public UEShedCameraAuthoring(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "Json", "Slate", "SlateCore", "ToolMenus", "UEShedCameraAuthoringBridge" });
	}
}
